/**
 * Proving the filler cannot submit.
 *
 * Runs against adversarial fixtures served from a local HTTP server, so
 * no employer is ever involved and the suite is repeatable offline. Each
 * fixture is a form built to defeat one specific layer.
 *
 * Both directions are asserted. A guard that refuses everything is not a
 * guard, it is a broken filler, so the legitimate cases have to pass as
 * surely as the dangerous ones have to fail.
 */
import { createServer, type Server } from "node:http";
import { chromium, type BrowserContext, type Page } from "playwright";
import { SubmitGuard, isSubmitCapable, nameLooksLikeSubmit } from "../lib/browser/submitGuard.ts";
import { advanceStep, stepEvidence } from "../lib/browser/navigation.ts";
import { snapshotLive } from "../lib/browser/liveSnapshot.ts";
import { resolveFormContext, assertContextIntact } from "../lib/browser/formContext.ts";
import { reconcileField, answerFitsControl } from "../lib/browser/reconcile.ts";
import { attachResume } from "../lib/browser/upload.ts";
import { readFileSync } from "node:fs";
import { readLazyOptions } from "../lib/browser/inspectCombobox.ts";
import { ACTION_ALLOW_LIST } from "../lib/browser/actions.ts";
import { Stop, STOP_REASONS } from "../lib/browser/stopReasons.ts";
import { launchBrowser, newPreparedContext } from "../lib/browser/launch.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++; else fails.push(`  ${name}\n      ${detail}`);
};

// ---- the action surface, checked as a closed set ---------------------
check("the action allow-list is exactly seven entries",
  ACTION_ALLOW_LIST.length === 7, `${ACTION_ALLOW_LIST.length}: ${ACTION_ALLOW_LIST.join(", ")}`);
check("the allow-list contains no submit-shaped action",
  !ACTION_ALLOW_LIST.some((a) => /submit|send|apply|finish/i.test(a)), ACTION_ALLOW_LIST.join(", "));
check("the allow-list names exactly the intended primitives",
  JSON.stringify([...ACTION_ALLOW_LIST].sort()) ===
  JSON.stringify(["advanceStep", "fillText", "inspectOptions", "readBack", "selectOption", "setChecked", "setFiles"]),
  [...ACTION_ALLOW_LIST].sort().join(", "));
check("a submission stop reason exists and is terminal",
  STOP_REASONS.includes("SUBMISSION_ATTEMPT_BLOCKED"), "missing");

// A defect found while writing this suite: blockedRequests is
// context-wide and cumulative, so "has anything been blocked" was true
// for every page after the first block. A legitimate multi-step form
// could never advance, and the stop reason reported would belong to an
// earlier page. The guard now takes a baseline; this case is the
// regression test, and it only passes because real-step runs AFTER
// several fixtures that block requests.

// ---- fixtures --------------------------------------------------------
const FIXTURES: Record<string, string> = {
  // Layer 1 targets. Each is structurally submit-capable.
  "input-submit": `<form action="/posted" method="post"><input name="a"><input type="submit" value="Go"></form>`,
  "button-submit": `<form action="/posted" method="post"><input name="a"><button type="submit">Go</button></form>`,
  // The one no label check can see: no type attribute means type=submit.
  "button-no-type": `<form action="/posted" method="post"><input name="a"><button>Continue</button></form>`,
  "formaction": `<form method="post"><input name="a"><button type="button" formaction="/posted">Continue</button></form>`,
  "form-attr": `<form id="f" action="/posted" method="post"><input name="a"></form><button type="button" form="f">Continue</button>`,
  "implicit-default": `<form action="/posted" method="post"><input name="a"><button>First</button><button type="button">Second</button></form>`,

  // Layer 4 target: honest structure, dishonest label.
  "named-submit": `<div><input name="a"><button type="button" id="b" onclick="void 0">Submit application</button></div>`,

  // No step evidence: a lone "Continue" on a form with nothing left to fill.
  "no-step-evidence": `<div><input name="a"><button type="button" id="b">Continue</button></div>`,

  // Legitimate: a genuine step control, with an indicator.
  "real-step": `<div><ol class="steps"><li aria-current="step">One</li><li>Two</li></ol>
                 <input name="a"><button type="button" id="b" onclick="document.getElementById('later').style.display='block'">Next</button>
                 <div id="later" style="display:none"><input name="b"></div></div>`,

  // Layer 2 targets: programmatic submission, bypassing any click.
  "programmatic-submit": `<form id="f" action="/posted" method="post"><input name="a"></form>
                          <button type="button" id="b" onclick="try{document.getElementById('f').submit()}catch(e){window.__err=e.message}">Continue</button>`,
  "request-submit": `<form id="f" action="/posted" method="post"><input name="a"><button type="submit" id="s">x</button></form>
                     <button type="button" id="b" onclick="try{document.getElementById('f').requestSubmit()}catch(e){window.__err=e.message}">Continue</button>`,
  "native-submit-event": `<form id="f" action="/posted" method="post"><input name="a"><button type="submit" id="s">Go</button></form>`,

  // Layer 2 in isolation. Identical handlers to the pair above, but with
  // a step indicator, so the evidence requirement is satisfied and the
  // click actually happens. This is the case that proves the deepest
  // guard works rather than merely never being reached.
  "stepped-programmatic": `<div><ol class="steps"><li aria-current="step">One</li></ol>
    <form id="f" action="/posted" method="post"><input name="a"></form>
    <button type="button" id="b" onclick="try{document.getElementById('f').submit()}catch(e){window.__err=e.message}">Continue</button></div>`,
  "stepped-request-submit": `<div><ol class="steps"><li aria-current="step">One</li></ol>
    <form id="f" action="/posted" method="post"><input name="a"><button type="submit" id="s">x</button></form>
    <button type="button" id="b" onclick="try{document.getElementById('f').requestSubmit()}catch(e){window.__err=e.message}">Continue</button></div>`,

  // reCAPTCHA v3, as Greenhouse actually embeds it: a badge in the
  // corner, watching, asking nothing. Treating this as a challenge
  // stopped the Greenhouse path before it filled a single field.
  "captcha-badge-only": `<div><input name="a"><div class="grecaptcha-badge" style="width:70px;height:60px"></div></div>`,
  // An interactive challenge. Still an unconditional stop.
  "captcha-challenge": `<div><input name="a"><iframe title="recaptcha challenge expires in two minutes" style="width:400px;height:580px"></iframe></div>`,

  // Greenhouse's uploader: styled buttons, real file input hidden.
  "hidden-file-input": `<div><input name="a">
    <button type="button">Attach</button><button type="button">Dropbox</button>
    <label for="resume">Resume/CV</label>
    <input id="resume" type="file" style="display:none">
    <label for="cover_letter">Attach</label><input id="cover_letter" type="file" style="display:none"></div>`,

  // Fill-then-stop: one unresolved required field, three answerable ones,
  // and one that depends on the unresolved control by sharing its group.
  "fill-then-stop": `<div>
    <label for="a">First</label><input id="a" name="a">
    <label for="b">Second</label><input id="b" name="b">
    <label for="need">Needed</label><input id="need" name="need" required>
    <fieldset id="grp"><legend>Address</legend>
      <label for="ctry">Country</label><input id="ctry" name="ctry" required>
      <label for="state">State</label><input id="state" name="state">
    </fieldset></div>`,

  // A telephone input beside an unresolved control whose options are
  // calling codes. Greenhouse labels that control simply "Country".
  "tel-needs-dial-code": `<div>
    <label for="nm">Name</label><input id="nm" name="nm">
    <label for="dial">Country</label>
    <select id="dial" name="dial" required><option>Poland +48</option><option>United States +1</option></select>
    <label for="tel">Phone</label><input id="tel" name="tel" type="tel"></div>`,

  // Filling one field reveals another.
  "reveals-more": `<div>
    <label for="x">Trigger</label><input id="x" name="x" oninput="document.getElementById('more').style.display='block'">
    <div id="more" style="display:none"><label for="y">Revealed</label><input id="y" name="y"></div></div>`,

  // A combobox with no <option> elements, beside a telephone input:
  // Greenhouse's dial-code selector. Answering it from residence is the
  // conflation the profile rules forbid.
  "bare-country-with-tel": `<div>
    <label for="country">Country</label><input id="country" name="country" role="combobox" required>
    <label for="tel">Phone</label><input id="tel" name="tel" type="tel"></div>`,
  // The same label with no telephone anywhere: an ordinary residence field.
  "bare-country-no-tel": `<div>
    <label for="country">Country</label><input id="country" name="country" required>
    <label for="city">City</label><input id="city" name="city"></div>`,

  // A react-select style combobox: options exist only once opened.
  "lazy-combobox": `<div>
    <label for="country">Country</label>
    <input id="country" role="combobox" aria-controls="lb" aria-expanded="false" readonly
      onclick="document.getElementById('lb').style.display='block';this.setAttribute('aria-expanded','true')">
    <ul id="lb" role="listbox" style="display:none">
      <li role="option">Poland +48</li><li role="option">United States +1</li><li role="option">Canada +1</li></ul>
    <label for="tel">Phone</label><input id="tel" name="tel" type="tel">
    <script>document.addEventListener("keydown",e=>{if(e.key==="Escape"){document.getElementById("lb").style.display="none";document.getElementById("country").setAttribute("aria-expanded","false");}});<\/script>
    </div>`,
  // A combobox that inserts a value merely by being opened. Inspection
  // must notice and stop rather than silently having entered something.
  "combobox-that-writes": `<div>
    <label for="c2">Country</label>
    <input id="c2" role="combobox" aria-controls="lb2" onclick="this.value='Poland';document.getElementById('lb2').style.display='block'">
    <ul id="lb2" role="listbox" style="display:none"><li role="option">Poland +48</li><li role="option">France +33</li></ul></div>`,

  // ---- frame fixtures ------------------------------------------------
  // A Greenhouse-style application, served from a provider host.
  "gh-form": `<form action="/posted" method="post">
    <label for="first_name">First Name</label><input id="first_name" required>
    <label for="email">Email</label><input id="email" required>
    <label for="resume">Resume/CV</label><input id="resume" type="file" style="display:none">
    <button type="submit">Submit application</button></form>`,
  // An employer page: description only, form embedded one frame down.
  "employer-embed": `<h1>Position details</h1><p>Long description with no controls at all.</p>
    <iframe src="GH_ORIGIN/gh-form" width="600" height="400"></iframe>`,
  // An employer page whose only iframe is somebody else's form.
  "employer-newsletter": `<h1>Position details</h1>
    <iframe src="/newsletter" width="400" height="200"></iframe>`,
  "newsletter": `<form><label for="nl">Email</label><input id="nl"><button>Subscribe</button></form>`,
  // Two provider frames: which is the application is not established.
  "employer-two-forms": `<h1>Position details</h1>
    <iframe src="GH_ORIGIN/gh-form" width="600" height="300"></iframe>
    <iframe src="GH_ORIGIN/gh-form" width="600" height="300"></iframe>`,
  // Top page with controls of its own AND a provider frame.
  "employer-own-controls": `<label for="search">Search jobs</label><input id="search">
    <iframe src="GH_ORIGIN/gh-form" width="600" height="400"></iframe>`,

  // An uploader that ignores programmatic setInputFiles, as Greenhouse's
  // embed does, and exposes a bound label that raises a file chooser.
  "chooser-upload": `<form><label for="resume">Attach</label>
    <input id="resume" type="file" class="visually-hidden" style="position:absolute;left:-9999px">
    <script>
      const i = document.getElementById("resume");
      Object.defineProperty(i, "files", { get(){ return this.__f || { length: 0 }; } });
      document.querySelector("label").addEventListener("click", () => i.click());
    <\/script></form>`,
  // Two upload controls in one group: which is the resume is not established.
  "ambiguous-upload": `<form><div>
    <button>Attach</button><button>Attach other</button>
    <input id="resume" type="file" style="display:none"></div></form>`,
  // A react-select style EEO control: choices exist only once opened.
  "eeo-combobox": `<form>
    <label for="gender">Gender</label>
    <input id="gender" role="combobox" aria-haspopup="true" aria-autocomplete="list" aria-controls="glb" readonly
      onclick="document.getElementById('glb').style.display='block'">
    <ul id="glb" role="listbox" style="display:none">
      <li role="option">Decline To Self Identify</li><li role="option">Female</li><li role="option">Male</li></ul>
    <label for="hispanic_ethnicity">Are you Hispanic/Latino?</label>
    <input id="hispanic_ethnicity" role="combobox" aria-haspopup="true" aria-autocomplete="list" aria-controls="hlb" readonly
      onclick="document.getElementById('hlb').style.display='block'">
    <ul id="hlb" role="listbox" style="display:none">
      <li role="option">Decline To Self Identify</li><li role="option">Yes</li><li role="option">No</li></ul>
    <script>document.addEventListener("keydown",e=>{if(e.key==="Escape"){for(const b of document.querySelectorAll("[role=listbox]"))b.style.display="none";}});<\/script>
    </form>`,

  // The real Greenhouse embedded phone structure: a fieldset legended
  // "Phone" containing a react-select country widget (its combobox input
  // plus an identity-less validation proxy) and the tel input. Three
  // inputs, two questions.
  "gh-phone-widget": `<form><fieldset><legend>Phone</legend>
    <div class="select"><div class="select__container"><div class="select-shell">
      <input class="requiredInput" required>
    </div>
    <label for="country">Country</label>
    <div class="select__control"><div class="select__value-container"><div class="select__input-container">
      <input id="country" role="combobox" aria-autocomplete="list" aria-haspopup="true">
    </div></div></div></div></div>
    <div class="iti"><label for="phone">Phone*</label>
      <input id="phone" type="tel" aria-label="Phone">
      <div class="iti__country-container"><div class="iti__dropdown-content">
        <input id="iti-0__search-input" type="search" class="iti__search-input" aria-label="Search" style="display:none">
      </div></div>
    </div></fieldset></form>`,
  // Two genuinely independent questions that happen to share a label.
  // Both keep their own identity, so both survive.
  "twin-questions": `<form>
    <label for="ref1">Reference name</label><input id="ref1">
    <label for="ref2">Reference name</label><input id="ref2"></form>`,

  // Layer 3 target: a single-page form that never fires a submit event.
  "fetch-post": `<div><ol class="steps"><li aria-current="step">One</li></ol><input name="a">
                 <button type="button" id="b" onclick="fetch('/api/apply',{method:'POST',body:'{}'}).then(()=>{window.__posted=true}).catch(e=>{window.__fetchErr=String(e)})">Continue</button></div>`,
};

const server: Server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0]!;
  if (path === "/posted") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<h1>Application received</h1>"); }
  if (path.startsWith("/api/")) { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
  const key = path.replace(/^\//, "");
  const body = FIXTURES[key];
  if (!body) { res.writeHead(404); return res.end("no"); }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><meta charset="utf-8"><title>${key}</title>${body.replace(/GH_ORIGIN/g, "https://job-boards.greenhouse.io")}`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port as number;
const url = (k: string) => `http://127.0.0.1:${port}/${k}`;

const browser = await launchBrowser();
const context: BrowserContext = await newPreparedContext(browser);
const guard = await SubmitGuard.install(context);
guard.arm();

// Provider-hosted fixtures are fulfilled at a real greenhouse.io URL so
// the host matcher is exercised for what it actually is, rather than
// being handed a test-only override that would also exist in production.
const GH_ORIGIN = "https://job-boards.greenhouse.io";
await context.route(`${GH_ORIGIN}/**`, async (route) => {
  const path = new URL(route.request().url()).pathname.replace(/^\//, "").split("?")[0]!;
  const body = FIXTURES[path] ?? FIXTURES["gh-form"]!;
  await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta charset="utf-8">${body}` });
});

const openProvider = async (k: string): Promise<Page> => {
  const p = await context.newPage();
  await p.goto(`${GH_ORIGIN}/${k}`, { waitUntil: "domcontentloaded" });
  return p;
};

const open = async (k: string): Promise<Page> => {
  const p = await context.newPage();
  await p.goto(url(k), { waitUntil: "domcontentloaded" });
  return p;
};

try {
  // ---- Layer 1: structural refusal, before any text ------------------
  for (const [fixture, why] of [
    ["input-submit", "input[type=submit]"],
    ["button-submit", "button[type=submit]"],
    ["button-no-type", "a button with no type inside a form"],
    ["formaction", "formaction"],
    ["form-attr", "the form attribute"],
    ["implicit-default", "the implicit default button"],
  ] as Array<[string, string]>) {
    const page = await open(fixture);
    const el = await page.$(fixture === "implicit-default" ? "form button:first-of-type" : "button, input[type=submit]");
    const verdict = await isSubmitCapable(el!);
    check(`layer 1 refuses ${why}`, verdict.capable, `not flagged (${fixture})`);
    await page.close();
  }

  {
    const page = await open("named-submit");
    const el = await page.$("#b");
    const verdict = await isSubmitCapable(el!);
    check("layer 1 does NOT flag a plain type=button", !verdict.capable, verdict.why);
    check("layer 4 catches it by name instead", nameLooksLikeSubmit("Submit application"), "denylist missed it");
    await page.close();
  }

  // ---- advanceStep refuses every dangerous case ----------------------
  const refuses = async (fixture: string, selector: string, label: string, expect: string) => {
    const page = await open(fixture);
    const el = await page.$(selector);
    let stopped: Stop | null = null;
    try { await advanceStep(page.mainFrame(), guard, el!, []); }
    catch (e) { stopped = e instanceof Stop ? e : null; }
    check(`advanceStep refuses ${label}`, stopped?.reason === expect,
      stopped ? `${stopped.reason}: ${stopped.message.slice(0, 80)}` : "it clicked");
    // And nothing reached the server.
    check(`  ${label} did not navigate to a confirmation`,
      !/Application received/i.test((await page.textContent("body")) ?? ""), page.url());
    await page.close();
  };

  await refuses("button-no-type", "form button", "an untyped button in a form", "AMBIGUOUS_NAVIGATION");
  await refuses("named-submit", "#b", "a control named \"Submit application\"", "AMBIGUOUS_NAVIGATION");
  await refuses("no-step-evidence", "#b", "\"Continue\" with no step evidence", "AMBIGUOUS_NAVIGATION");
  // These carry no step evidence, so the evidence requirement refuses
  // them before the click. That is an EARLIER layer catching it, which
  // is safer than layer 2 having to; the assertion is that they are
  // refused, not which layer did it.
  await refuses("programmatic-submit", "#b", "a control calling form.submit()", "AMBIGUOUS_NAVIGATION");
  await refuses("request-submit", "#b", "a control calling requestSubmit()", "AMBIGUOUS_NAVIGATION");
  await refuses("fetch-post", "#b", "a control POSTing with fetch", "SUBMISSION_ATTEMPT_BLOCKED");

  // Layer 2 in isolation: the same dangerous handlers, but on forms that
  // DO look multi-step, so the click proceeds and only layer 2 stands in
  // the way. Without these the deepest guard is never exercised.
  await refuses("stepped-programmatic", "#b", "form.submit() behind a step indicator", "SUBMISSION_ATTEMPT_BLOCKED");
  await refuses("stepped-request-submit", "#b", "requestSubmit() behind a step indicator", "SUBMISSION_ATTEMPT_BLOCKED");

  // ---- Layer 2 in isolation: a real submit button, clicked directly ---
  {
    const page = await open("native-submit-event");
    await page.click("#s");
    await page.waitForTimeout(500);
    check("layer 2 cancels a genuine submit click, so the page never posts",
      !/Application received/i.test((await page.textContent("body")) ?? ""), page.url());
    const report = await guard.report(page);
    check("and the attempt is recorded", report.submitAttempts.length > 0, JSON.stringify(report).slice(0, 120));
    await page.close();
  }

  // ---- Layer 2, programmatic paths throw rather than submit -----------
  {
    const page = await open("programmatic-submit");
    await page.click("#b");
    await page.waitForTimeout(300);
    const err = await page.evaluate(() => (window as any).__err ?? null);
    check("form.submit() throws instead of submitting", typeof err === "string" && /blocked/i.test(err), String(err));
    await page.close();
  }

  // ---- Layer 3: the fetch never reaches the network -------------------
  {
    const page = await open("fetch-post");
    await page.click("#b");
    await page.waitForTimeout(700);
    const posted = await page.evaluate(() => (window as any).__posted ?? false);
    check("layer 3 aborts a fetch POST", posted === false, "the POST succeeded");
    check("and the abort is recorded", guard.blockedRequests.length > 0, "nothing recorded");
    await page.close();
  }

  // ---- The legitimate direction: a real step control is allowed -------
  {
    const page = await open("real-step");
    const ev = await stepEvidence(page.mainFrame(), []);
    check("a form with a step indicator shows multi-step evidence", ev.multiStep, ev.why);
    const el = await page.$("#b");
    let stopped: Stop | null = null;
    try { await advanceStep(page.mainFrame(), guard, el!, []); }
    catch (e) { stopped = e instanceof Stop ? e : null; }
    check("a cumulative blocked-request count does not poison a later page",
      guard.blockedRequests.length > 0, "no earlier fixture blocked a request, so this proves nothing");
    check("advanceStep clicks a genuine Next control", stopped === null,
      stopped ? `${stopped.reason}: ${stopped.message.slice(0, 90)}` : "");
    check("and the next step's field appeared",
      await page.locator("#later input").isVisible().catch(() => false), "the step did not advance");
    await page.close();
  }

  // ---- Evidence from missing fields, not just indicators --------------
  {
    const page = await open("no-step-evidence");
    const ev = await stepEvidence(page.mainFrame(), ["a", "not_on_this_page"]);
    check("a snapshotted field absent from the DOM is multi-step evidence", ev.multiStep, ev.why);
    const ev2 = await stepEvidence(page.mainFrame(), ["a"]);
    check("and when every field is present, it is not", !ev2.multiStep, ev2.why);
    await page.close();
  }
  // 0. Greenhouse hides the real file input behind styled buttons, so
  //    filtering invisible controls skipped the resume upload silently.
  {
    const page = await open("hidden-file-input");
    const snap = await snapshotLive(page.mainFrame());
    const file = snap.fields.find((f) => f.type === "file");
    check("a hidden file input is still snapshotted", !!file, snap.fields.map((f) => `${f.key}:${f.type}`).join(", "));
    check("and its id is used as the selector rather than being read as generated",
      file?.selectorKind === "id" && file?.selector === "#resume",
      `${file?.selectorKind}:${file?.selector}`);
    check("two file inputs sharing a label stay distinguishable by key",
      snap.fields.filter((f) => f.type === "file").length === 2
      && new Set(snap.fields.filter((f) => f.type === "file").map((f) => f.key)).size === 2,
      snap.fields.filter((f) => f.type === "file").map((f) => `${f.key}/${f.label}`).join(", "));
    check("while other invisible controls stay filtered out",
      !snap.fields.some((f) => f.type !== "file" && f.key === "never"), "");
    await page.close();
  }

  // ---- frame resolution ----------------------------------------------
  //
  // SpotHero's careers page carries the description and embeds the
  // Greenhouse form one frame down. Reading only the top document
  // reported NO_FORM_FOUND for a form that was plainly on screen.
  {
    const page = await openProvider("gh-form");
    const ctx = await resolveFormContext(page, "GREENHOUSE");
    check("a provider-hosted top document resolves to the top document",
      ctx.kind === "top-document", `${ctx.kind} ${ctx.url}`);
    await page.close();
  }
  {
    const page = await open("employer-embed");
    await page.waitForTimeout(600);
    const ctx = await resolveFormContext(page, "GREENHOUSE");
    check("an embedded provider form resolves to the iframe",
      ctx.kind === "iframe" && /gh-form/.test(ctx.url), `${ctx.kind} ${ctx.url}`);
    const snap = await snapshotLive(ctx.frame);
    check("and the snapshot happens inside that frame",
      snap.fields.some((f) => f.key === "first_name") && snap.fields.some((f) => f.key === "email"),
      snap.fields.map((f) => f.key).join(", "));
    check("including the hidden file input",
      snap.fields.some((f) => f.type === "file"), snap.fields.map((f) => f.type).join(", "));
    check("selectors resolve inside the frame",
      await ctx.frame.locator("#first_name").count() === 1, "selector did not resolve");
    // Read-back inside the frame.
    await ctx.frame.locator("#first_name").fill("Tyler");
    check("read-back works inside the frame",
      (await ctx.frame.locator("#first_name").inputValue()) === "Tyler", "read-back failed");
    // File upload inside the frame.
    await ctx.frame.locator("#resume").setInputFiles({ name: "r.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 x") });
    check("file upload works inside the frame",
      await ctx.frame.locator("#resume").evaluate((e: any) => e.files.length === 1), "upload failed");
    await page.close();
  }
  {
    const page = await open("employer-embed");
    await page.waitForTimeout(600);
    const ctx = await resolveFormContext(page, "GREENHOUSE");
    check("a top page with zero controls plus a valid frame is NOT NO_FORM_FOUND",
      !!ctx.frame, "resolution failed");

    // The submit button inside the iframe is protected exactly as one in
    // the top document would be.
    const el = await ctx.frame.$("button[type=submit]");
    const verdict = await isSubmitCapable(el!);
    check("a submit button inside the iframe is refused structurally",
      verdict.capable, verdict.why);
    let stopped: Stop | null = null;
    try { await advanceStep(ctx.frame, guard, el!, []); }
    catch (e) { stopped = e instanceof Stop ? e : null; }
    check("and advanceStep refuses it", stopped?.reason === "AMBIGUOUS_NAVIGATION",
      stopped ? stopped.reason : "it clicked");

    await page.close();
  }
  {
    // Layer 2 inside the frame, on its own page so no earlier fixture in
    // this suite can influence it.
    const page = await context.newPage();
    await page.setContent(`<h1>desc</h1><iframe src="${GH_ORIGIN}/gh-form" width="600" height="400"></iframe>`);
    await page.waitForTimeout(700);
    const ctx = await resolveFormContext(page, "GREENHOUSE");
    // The required fields are filled first on purpose. An incomplete
    // form is stopped by HTML5 constraint validation and never fires a
    // submit event, so clicking it proves nothing about the guard. The
    // dangerous moment is a COMPLETE form, and that is what is tested.
    await ctx.frame.locator("#first_name").fill("Tyler");
    await ctx.frame.locator("#email").fill("x@example.com");
    await ctx.frame.locator("button[type=submit]").click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    const rep = await guard.report(ctx.frame);
    check("a submit click inside the iframe is cancelled, not posted",
      !/Application received/i.test((await ctx.frame.textContent("body")) ?? ""), ctx.frame.url());
    check("and the attempt is recorded against the FRAME, not the top document",
      rep.submitAttempts.length > 0, `frame attempts=${rep.submitAttempts.length}`);
    const mainRep = await guard.report(page.mainFrame());
    check("the top document records nothing, because nothing happened there",
      mainRep.submitAttempts.length === 0, `${mainRep.submitAttempts.length}`);
    await page.close();
  }
  {
    const page = await open("employer-newsletter");
    await page.waitForTimeout(600);
    let stopped: Stop | null = null;
    try { await resolveFormContext(page, "GREENHOUSE"); }
    catch (e) { stopped = e instanceof Stop ? e : null; }
    check("an unrelated iframe with inputs is never selected",
      stopped?.reason === "NO_FORM_FOUND", stopped ? stopped.reason : "it selected the newsletter");
    await page.close();
  }
  {
    const page = await open("employer-two-forms");
    await page.waitForTimeout(600);
    let stopped: Stop | null = null;
    try { await resolveFormContext(page, "GREENHOUSE"); }
    catch (e) { stopped = e instanceof Stop ? e : null; }
    check("two plausible application frames stop rather than guessing",
      stopped?.reason === "SELECTOR_AMBIGUOUS", stopped ? stopped.reason : "it picked one");
    await page.close();
  }
  {
    const page = await open("employer-own-controls");
    await page.waitForTimeout(600);
    const ctx = await resolveFormContext(page, "GREENHOUSE");
    check("the employer's own controls are not mistaken for the application",
      ctx.kind === "iframe", `${ctx.kind}`);
    const snap = await snapshotLive(ctx.frame);
    check("and the search box is not in the snapshot",
      !snap.fields.some((f) => f.key === "search"), snap.fields.map((f) => f.key).join(", "));
    await page.close();
  }
  {
    // Frame replacement is detected rather than silently followed.
    const page = await open("employer-embed");
    await page.waitForTimeout(600);
    const ctx = await resolveFormContext(page, "GREENHOUSE");
    await ctx.frame.evaluate(() => { location.href = "/gh-form?v=2"; }).catch(() => undefined);
    await page.waitForTimeout(700);
    let stopped: Stop | null = null;
    try { await assertContextIntact(ctx); }
    catch (e) { stopped = e instanceof Stop ? e : null; }
    check("a frame that navigates mid-fill is detected",
      stopped?.reason === "FORM_CHANGED", stopped ? stopped.reason : "the change went unnoticed");
    await page.close();
  }
  {
    // An unsupported provider is never filled just because controls exist.
    const page = await open("employer-newsletter");
    await page.waitForTimeout(400);
    let stopped: Stop | null = null;
    try { await resolveFormContext(page, "WORKDAY"); }
    catch (e) { stopped = e instanceof Stop ? e : null; }
    check("an unsupported provider stops rather than filling whatever is there",
      stopped?.reason === "PROVIDER_UNSUPPORTED", stopped ? stopped.reason : "it proceeded");
    await page.close();
  }

  // ---- one semantic control, one snapshot entry ----------------------
  //
  // Modelled on the live Greenhouse embed. react-select renders an
  // identity-less validation proxy inside the fieldset legended "Phone";
  // it inherited that legend and became a second phone question beside
  // the real tel input.
  {
    const page = await open("gh-phone-widget");
    const snap = await snapshotLive(page.mainFrame());
    const phoneish = snap.fields.filter((f) => /phone/i.test(f.label));
    check("one phone question produces exactly one snapshot entry",
      phoneish.length === 1, phoneish.map((f) => `${f.key}:${f.label}`).join(" | "));
    check("and it is the real tel input",
      phoneish[0]?.key === "phone" && phoneish[0]?.htmlType === "tel",
      `${phoneish[0]?.key}/${phoneish[0]?.htmlType}`);
    check("the react-select validation proxy is classified as a widget helper",
      snap.widgetHelpers.some((h) => /phone/i.test(h.label)),
      JSON.stringify(snap.widgetHelpers));
    check("and the reason is identity, not label similarity",
      snap.widgetHelpers.every((h) => /no name, id or test id/.test(h.why)),
      JSON.stringify(snap.widgetHelpers));
    check("the country selector survives as its own control",
      snap.fields.some((f) => f.key === "country"), snap.fields.map((f) => f.key).join(", "));
    check("the country selector is NOT collapsed into the phone input",
      snap.fields.filter((f) => f.key === "country" || f.key === "phone").length === 2,
      snap.fields.map((f) => f.key).join(", "));
    check("the hidden intl-tel search box is not a question either",
      !snap.fields.some((f) => /search/i.test(f.key)), snap.fields.map((f) => f.key).join(", "));
    await page.close();
  }
  {
    // The rule must not eat genuinely distinct questions.
    const page = await open("twin-questions");
    const snap = await snapshotLive(page.mainFrame());
    check("two identically labelled questions with their own ids both survive",
      snap.fields.filter((f) => /reference name/i.test(f.label)).length === 2,
      snap.fields.map((f) => f.key).join(", "));
    check("and nothing was suppressed for sharing a label",
      snap.widgetHelpers.length === 0, JSON.stringify(snap.widgetHelpers));
    await page.close();
  }
  {
    // No positional or label-only deduplication crept in.
    const src = readFileSync("lib/browser/liveSnapshot.ts", "utf8");
    const body = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("the snapshot has no index-based or label-only suppression",
      !/fields\[\d\]|indexOf\(label\)|label === other/.test(body),
      "positional or label-only logic found");
    check("suppression requires the absence of an own identity",
      /hasOwnIdentity/.test(body), "the identity test is missing");
  }

  // ---- upload: the real file chooser, and proof of attachment --------
  {
    const page = await openProvider("gh-form");
    const snap = await snapshotLive(page.mainFrame());
    const field = snap.fields.find((f) => f.type === "file")!;
    const pdf = Buffer.from("%PDF-1.4 direct-upload-fixture");
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/selftest-resume.pdf", pdf);
    const { createHash } = await import("node:crypto");
    const ev = await attachResume({
      page, frame: page.mainFrame(), field, path: "/tmp/selftest-resume.pdf",
      expectedName: "selftest-resume.pdf", expectedBytes: pdf.length,
      expectedSha256: createHash("sha256").update(pdf).digest("hex"),
    });
    check("a directly hosted upload still works without a chooser",
      ev.mechanism === "set-input-files" && ev.fileCount === 1, JSON.stringify(ev).slice(0, 120));
    check("and the attached bytes are hashed and matched",
      ev.sha256 === createHash("sha256").update(pdf).digest("hex"), `${ev.sha256}`);
    check("attachment metadata is verified, not assumed",
      ev.name === "selftest-resume.pdf" && ev.size === pdf.length && /pdf/i.test(ev.type),
      JSON.stringify(ev).slice(0, 120));
    await page.close();
  }
  {
    const page = await open("ambiguous-upload");
    const snap = await snapshotLive(page.mainFrame());
    const field = snap.fields.find((f) => f.type === "file")!;
    let stopped: Stop | null = null;
    try {
      await attachResume({ page, frame: page.mainFrame(), field, path: "/tmp/selftest-resume.pdf",
        expectedName: "selftest-resume.pdf", expectedBytes: 1, expectedSha256: "0".repeat(64) });
    } catch (e) { stopped = e instanceof Stop ? e : null; }
    check("an upload whose attachment cannot be verified stops",
      stopped !== null && (stopped.reason === "UPLOAD_UNACKNOWLEDGED" || stopped.reason === "SELECTOR_AMBIGUOUS"),
      stopped ? stopped.reason : "it was accepted");
    await page.close();
  }
  {
    // The chooser path is not a general click capability: it is reached
    // only from the control bound to the resume input.
    const src = readFileSync("lib/browser/upload.ts", "utf8");
    check("the chooser path activates only the resolved upload control",
      /resolveUploadActivator/.test(src) && !/getByText|page\.click\(/.test(src),
      "a broader click path exists in upload.ts");
    check("and the action allow-list gained nothing",
      ACTION_ALLOW_LIST.length === 7, ACTION_ALLOW_LIST.join(", "));
  }

  // ---- API to DOM reconciliation --------------------------------------
  {
    const apiSelect = { key: "gender", label: "Gender", type: "select", required: false,
      options: ["Decline To Self Identify", "Female", "Male"] };
    const page = await open("eeo-combobox");
    const snap = await snapshotLive(page.mainFrame());
    const liveGender = snap.fields.find((f) => f.key === "gender")!;
    const liveHisp = snap.fields.find((f) => f.key === "hispanic_ethnicity")!;

    const m = reconcileField(liveGender, [apiSelect as any]);
    check("an API select reconciles to a DOM combobox by provider key",
      m.api?.key === "gender" && m.basis === "provider-key", `${m.basis} ${m.blocked ?? ""}`);
    check("and the control-type difference is recorded, not treated as a mismatch",
      m.controlTypeDiffers === true && m.blocked === null, `differs=${m.controlTypeDiffers}`);

    // The live options must actually be read before the answer is used.
    const opts = await readLazyOptions(page, page.mainFrame(), guard, page.locator("#gender"), "Gender");
    check("the live combobox choices can be inspected",
      opts.options.includes("Male"), JSON.stringify(opts.options));
    const fit = answerFitsControl("Male", liveGender, m.api, opts.options);
    check("a confirmed answer is accepted only because the live control offers it",
      fit.ok && fit.value === "Male", fit.ok ? "" : fit.why);
    const bad = answerFitsControl("Nonbinary", liveGender, m.api, opts.options);
    check("an answer the live control does not offer is blocked",
      !bad.ok, bad.ok ? "it was accepted" : "");

    // Race must never answer Hispanic ethnicity.
    const apiRace = { key: "race", label: "Race", type: "select", required: false, options: ["White", "Asian"] };
    const hispMatch = reconcileField(liveHisp, [apiRace as any]);
    check("Race cannot be reconciled to the Hispanic ethnicity question",
      hispMatch.api === null && !!hispMatch.blocked, `${hispMatch.api?.key} ${hispMatch.blocked ?? ""}`);
    const hOpts = await readLazyOptions(page, page.mainFrame(), guard, page.locator("#hispanic_ethnicity"), "Hispanic");
    const raceAsHisp = answerFitsControl("White", liveHisp, null, hOpts.options);
    check("and White is not an available Hispanic-ethnicity answer",
      !raceAsHisp.ok, raceAsHisp.ok ? "it was accepted" : "");
    check("an unanswered optional EEO control is simply not required",
      liveHisp.required === false, `required=${liveHisp.required}`);
    await page.close();
  }
  {
    // Ambiguity blocks. Two reviewed fields asking the same thing cannot
    // both claim one live control.
    const a1 = { key: "q1", label: "Are you authorized to work?", type: "select", required: true, options: ["Yes", "No"] };
    const a2 = { key: "q2", label: "Are you authorized to work?", type: "select", required: true, options: ["Yes", "No"] };
    const live: any = { key: "unknown_key", label: "Are you authorized to work?", type: "select",
      required: true, options: ["Yes", "No"], selector: "#x", selectorKind: "id", unlabelled: false,
      groupKey: null, htmlType: "select", associated: [] };
    const m = reconcileField(live, [a1 as any, a2 as any]);
    check("two reviewed fields asking the same question block rather than picking one",
      m.api === null && /2 reviewed fields/.test(m.blocked ?? ""), m.blocked ?? "it picked one");
  }
  {
    // Position is never a basis for identity.
    const src = readFileSync("lib/browser/reconcile.ts", "utf8");
    check("reconciliation contains no positional or index matching",
      !/\[i\]|indexOf\(live\)|position/i.test(src.replace(/^\s*\*.*$/gm, "")),
      "positional matching appears in reconcile.ts");
  }

  // ---- read-only combobox inspection ---------------------------------
  {
    const page = await open("lazy-combobox");
    const before = await snapshotLive(page.mainFrame());
    const c = before.fields.find((f) => f.key === "country");
    check("a lazy combobox shows no options before inspection",
      (c?.options ?? []).length === 0, JSON.stringify(c?.options));

    // Baselined, because blockedRequests is cumulative across the
    // context and earlier fixtures deliberately trip it.
    const mark = guard.mark();
    const result = await readLazyOptions(page, page.mainFrame(), guard, page.locator("#country"), "Country");
    check("inspection reads the lazily rendered options",
      result.options.length === 3, JSON.stringify(result.options));
    check("and they are dial codes, which identifies the control",
      result.options.every((o) => /\+\d/.test(o)), JSON.stringify(result.options));
    check("inspection chooses nothing: the control is still empty",
      (await page.locator("#country").inputValue()) === "", await page.locator("#country").inputValue());
    check("and closes it again", (await page.getAttribute("#country", "aria-expanded")) === "false",
      String(await page.getAttribute("#country", "aria-expanded")));
    check("inspection did not navigate", /lazy-combobox/.test(page.url()), page.url());
    check("and no submission was attempted by inspecting",
      !(await guard.sawSubmissionAttemptSince(page, mark)), "a guard fired");
    await page.close();
  }
  {
    const page = await open("combobox-that-writes");
    let stopped: Stop | null = null;
    try { await readLazyOptions(page, page.mainFrame(), guard, page.locator("#c2"), "Country"); }
    catch (e) { stopped = e instanceof Stop ? e : null; }
    check("a combobox that enters a value merely by opening is a stop",
      stopped?.reason === "READBACK_MISMATCH", stopped ? stopped.reason : "it was accepted");
    await page.close();
  }
  {
    const page = await open("bare-country-no-tel");
    const r = await readLazyOptions(page, page.mainFrame(), guard, page.locator("#country"), "Country");
    check("a plain text input is not treated as a combobox",
      r.neverOpened && r.options.length === 0, JSON.stringify(r));
    await page.close();
  }

  // ---- one logical answer, one live control --------------------------
  {
    // The live pattern: one element described twice, once by id and once
    // by label. Both selectors must resolve to the identical node.
    const page = await open("lazy-combobox");
    const byId = await page.locator("#tel").elementHandle();
    const byLabel = await page.getByLabel("Phone", { exact: true }).elementHandle();
    const same = await page.evaluate((pair: any) => pair[0] === pair[1], [byId, byLabel] as any);
    check("an id selector and a label selector for one control resolve to the same node",
      same === true, `same=${same}`);
    const other = await page.locator("#country").elementHandle();
    const different = await page.evaluate((pair: any) => pair[0] === pair[1], [byId, other] as any);
    check("and two genuinely different controls do not", different === false, `same=${different}`);
    await page.close();
  }

  // ---- a bare Country control beside a telephone input ---------------
  {
    const page = await open("bare-country-with-tel");
    const snap = await snapshotLive(page.mainFrame());
    const c = snap.fields.find((f) => f.key === "country");
    check("the ambiguous country control offers no options to identify it",
      (c?.options ?? []).length === 0, JSON.stringify(c?.options));
    check("and the form carries a telephone input, which is the signal",
      snap.fields.some((f) => f.htmlType === "tel"), snap.fields.map((f) => `${f.key}:${f.htmlType}`).join(", "));
    await page.close();
  }
  {
    const page = await open("bare-country-no-tel");
    const snap = await snapshotLive(page.mainFrame());
    check("with no telephone on the form there is no ambiguity signal",
      !snap.fields.some((f) => f.htmlType === "tel"), snap.fields.map((f) => f.htmlType).join(", "));
    await page.close();
  }

  // A telephone input defers to an unresolved country control even when
  // that control carries no dial-code options to identify it.
  {
    const page = await open("bare-country-with-tel");
    const snap = await snapshotLive(page.mainFrame());
    const country = snap.fields.find((f) => f.key === "country")!;
    const tel = snap.fields.find((f) => f.key === "tel")!;
    check("a bare country control has a country-ish label to key off",
      /\bcountry\b/i.test(country.label), country.label);
    check("and the telephone input is the one that must wait for it",
      tel.htmlType === "tel", tel.htmlType);
    await page.close();
  }

  // ---- fill-then-stop semantics --------------------------------------
  {
    const page = await open("fill-then-stop");
    const snap = await snapshotLive(page.mainFrame());
    const need = snap.fields.find((f) => f.key === "need");
    const ctry = snap.fields.find((f) => f.key === "ctry");
    const state = snap.fields.find((f) => f.key === "state");
    check("an unresolved required field is visible in the snapshot", need?.required === true, JSON.stringify(need));
    check("controls in one fieldset share a group key",
      !!ctry?.groupKey && ctry.groupKey === state?.groupKey, `${ctry?.groupKey} vs ${state?.groupKey}`);
    check("a control outside that fieldset does not share it",
      snap.fields.find((f) => f.key === "a")?.groupKey !== ctry?.groupKey, "grouped with the fieldset");
    await page.close();
  }
  {
    const page = await open("tel-needs-dial-code");
    const snap = await snapshotLive(page.mainFrame());
    const tel = snap.fields.find((f) => f.key === "tel");
    const dial = snap.fields.find((f) => f.key === "dial");
    check("a tel input keeps its html type", tel?.htmlType === "tel", tel?.htmlType ?? "none");
    check("a dial-code control is recognisable by its options",
      (dial?.options ?? []).every((o) => /\+\d/.test(o)), JSON.stringify(dial?.options));
    await page.close();
  }
  {
    const page = await open("reveals-more");
    const before = await snapshotLive(page.mainFrame());
    check("a hidden dependent field is absent before its trigger is filled",
      !before.fields.some((f) => f.key === "y"), before.fields.map((f) => f.key).join(", "));
    await page.fill("#x", "something");
    await page.waitForTimeout(200);
    const after = await snapshotLive(page.mainFrame());
    check("and appears once it is, so re-reading the DOM finds it",
      after.fields.some((f) => f.key === "y"), after.fields.map((f) => f.key).join(", "));
    await page.close();
  }
  {
    // A step is never advanced while anything required is unresolved,
    // and the guard sits inside advanceStep so no caller can skip it.
    const page = await open("real-step");
    const el = await page.$("#b");
    let stopped: Stop | null = null;
    try { await advanceStep(page.mainFrame(), guard, el!, [], ["Needed"]); }
    catch (e) { stopped = e instanceof Stop ? e : null; }
    check("advanceStep refuses while a required field is unresolved",
      stopped?.reason === "REQUIRED_FIELD_BLOCKED",
      stopped ? `${stopped.reason}` : "it advanced");
    let ok: Stop | null = null;
    try { await advanceStep(page.mainFrame(), guard, el!, [], []); }
    catch (e) { ok = e instanceof Stop ? e : null; }
    check("and still advances when nothing is unresolved", ok === null,
      ok ? `${ok.reason}: ${ok.message.slice(0, 70)}` : "");
    await page.close();
  }

  // ---- defects found during implementation, kept as regressions ------
  //
  // 1. An invisible reCAPTCHA v3 badge was read as a challenge. Every
  //    Greenhouse form carries one, so the whole provider was unusable.
  {
    const page = await open("captcha-badge-only");
    const snap = await snapshotLive(page.mainFrame());
    check("an invisible reCAPTCHA badge is not a challenge", snap.captcha === false, "read as a challenge");
    check("but its presence is recorded", snap.captchaBadgeOnly === true, "not recorded");
    await page.close();
  }
  {
    const page = await open("captcha-challenge");
    const snap = await snapshotLive(page.mainFrame());
    check("a visible challenge is still a stop", snap.captcha === true, "not detected");
    await page.close();
  }

  // 2. SubmitGuard.install ran once per application against a shared
  //    context, so init scripts accumulated and the second one threw
  //    redefining a non-configurable property, hanging the fill.
  {
    const again = await SubmitGuard.install(context);
    check("installing the guard twice on one context returns the same guard",
      again === guard, "a second guard was created");
    const page = await open("real-step");
    const installed = await page.evaluate(() => typeof (window as any).__fillGuard === "object");
    check("and a page in that context still initializes", installed, "__fillGuard missing");
    const usable = await page.locator("#b").isVisible();
    check("and the page is still usable after a repeat install", usable, "page did not render");
    await page.close();
  }

  // 3. The guard must survive a handoff and keep working for the next
  //    application filled through the same browser.
  {
    const page = await open("native-submit-event");
    await guard.handoff(page);
    guard.arm();
    const next = await open("native-submit-event");
    await next.click("#s");
    await next.waitForTimeout(400);
    check("after a handoff, the guard still blocks the next application's submit",
      !/Application received/i.test((await next.textContent("body")) ?? ""), next.url());
    await page.close(); await next.close();
  }
} finally {
  await context.close();
  await browser.close();
  server.close();
}

console.log(`${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
