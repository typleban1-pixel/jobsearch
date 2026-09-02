/**
 * Filling a Lever form, and refusing to.
 *
 *   node scripts/lever-fill-selftest.ts
 *
 * Drives the real fillLeverApplication against fixtures served at
 * jobs.lever.co. The parser cases matter most: Lever reads the uploaded
 * PDF and writes name, email, phone and org from it, so the fixture
 * simulates that by populating those inputs when a file is attached.
 */
import { chromium, type Browser, type Page } from "playwright";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fillLeverApplication, leverSubmitControl, type LeverAnswer } from "../lib/browser/leverFill.ts";
import { snapshotLeverForm, leverSnapshotShape } from "../lib/browser/providers/lever.ts";
import { launchBrowser, newPreparedContext, newPreparedPage } from "../lib/browser/launch.ts";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};

const ORIGIN = "https://jobs.lever.co";
const RESUME = join(tmpdir(), "lever-selftest-resume.pdf");
writeFileSync(RESUME, "%PDF-1.4\n% approved artifact stand-in\n");

/** A form that parses the resume on upload, exactly as Lever does. */
const page_html = (body: string, parser = true) => `<!doctype html><meta charset="utf-8"><body>
<button id="cookie-deny">Deny</button><button id="cookie-accept">Accept</button>
<form>
  <li class="application-question"><div class="application-label">Resume/CV ✱</div>
    <input type="file" name="resume"></li>
  <li class="application-question"><div class="application-label">Full name✱</div>
    <input type="text" name="name" required></li>
  <li class="application-question"><div class="application-label">Email✱</div>
    <input type="email" name="email" required></li>
  <li class="application-question"><div class="application-label">Current company</div>
    <input type="text" name="org"></li>
  ${body}
  <button type="submit">Submit application</button>
</form>
<script>
  ${parser ? `document.querySelector("input[name=resume]").addEventListener("change", () => {
    setTimeout(() => {
      document.querySelector("input[name=name]").value = "T. Pleban";
      document.querySelector("input[name=email]").value = "parsed@example.com";
      document.querySelector("input[name=org]").value = "Genius One";
    }, 200);
  });` : ""}
</script></body>`;

const RADIOS = `
  <li class="application-question"><div class="application-label">Work eligibility✱</div>
    <div class="field"><span class="text">Are you legally authorized to work?</span>
      <input type="radio" name="cards[x][field0]" required><label>Yes</label>
      <input type="radio" name="cards[x][field0]" required><label>No</label></div>
    <div class="field"><span class="text">Will you require sponsorship?</span>
      <input type="radio" name="cards[x][field1]" required><label>Yes</label>
      <input type="radio" name="cards[x][field1]" required><label>No</label></div></li>`;

const CHECKS = `
  <li class="application-question"><div class="application-label">Languages✱</div>
    <input type="checkbox" name="cards[y][field0]" required><label>English (ENG)</label>
    <input type="checkbox" name="cards[y][field0]" required><label>Spanish (SPA)</label>
    <input type="checkbox" name="cards[y][field0]" required><label>French (FRA)</label></li>`;

const SIGNATURE = `
  <li class="application-question"><div class="application-label">Disability signature</div>
    <input type="text" name="eeo[disabilitySignature]"></li>`;

const browser: Browser = await launchBrowser();
async function open(body: string, parser = true): Promise<Page> {
  const p = await newPreparedPage(browser, { viewport: { width: 1200, height: 900 } });
  await p.route(`${ORIGIN}/**`, (r) => r.fulfill({ status: 200, contentType: "text/html", body: page_html(body, parser) }));
  await p.goto(`${ORIGIN}/acme/abc/apply`, { waitUntil: "domcontentloaded" });
  return p;
}
const answer = (k: string, v: string | null, req = true, conf = "VERIFIED"): LeverAnswer =>
  ({ fieldKey: k, fieldLabel: k, answer: v, isRequired: req, confidence: conf });

const shapeOf = async (p: Page) => leverSnapshotShape(await snapshotLeverForm(p));

console.log("upload happens before filling, and the parser is reconciled");
{
  const p = await open(RADIOS);
  const shape = await shapeOf(p);
  const out = await fillLeverApplication({
    page: p, resumePath: RESUME, approvedShape: shape, reviewedLocation: null,
    answers: [answer("name", "Tyler Pleban"), answer("email", "typleban1@gmail.com"),
              answer("org", "Genius One, Inc."),
              answer("cards[x][field0]", "Yes"), answer("cards[x][field1]", "No")],
  });
  check("reaches handoff", out.reason === "HANDOFF", out.message);
  const byField = Object.fromEntries(out.parserReconciliation.map((r) => [r.field, r]));
  check("the parser overwrote the name and it was recorded",
    byField["name"]?.action === "OVERWRITTEN_BY_PREPARED", JSON.stringify(byField["name"]));
  check("and the reviewed name is what the form holds",
    (await p.locator("input[name=name]").inputValue()) === "Tyler Pleban");
  check("a parsed value that agrees is recorded as agreeing",
    byField["org"]?.action === "AGREES" || byField["org"]?.action === "OVERWRITTEN_BY_PREPARED");
  check("both radio questions were answered separately",
    out.filled.some((f) => f.field === "cards[x][field0]" && f.value === "Yes")
    && out.filled.some((f) => f.field === "cards[x][field1]" && f.value === "No"),
    JSON.stringify(out.filled));
  await p.close();
}

console.log("\nan unprepared field keeps the employer's own inference, labelled as theirs");
{
  const p = await open("");
  const out = await fillLeverApplication({
    page: p, resumePath: RESUME, approvedShape: await shapeOf(p), reviewedLocation: null,
    answers: [answer("name", "Tyler Pleban"), answer("email", "typleban1@gmail.com")],
  });
  const org = out.parserReconciliation.find((r) => r.field === "org");
  check("kept, and attributed to the parser", org?.action === "KEPT_PARSER_VALUE", JSON.stringify(org));
  await p.close();
}

console.log("\ncheckbox group semantics");
{
  const p = await open(CHECKS);
  const out = await fillLeverApplication({
    page: p, resumePath: RESUME, approvedShape: await shapeOf(p), reviewedLocation: null,
    answers: [answer("name", "Tyler Pleban"), answer("email", "e@x.com"), answer("org", "Genius One"),
              answer("cards[y][field0]", "English (ENG), Spanish (SPA)")],
  });
  check("several boxes can be ticked from one answer",
    out.filled.some((f) => f.field === "cards[y][field0]" && /English/.test(f.value) && /Spanish/.test(f.value)),
    JSON.stringify(out.filled.find((f) => f.field === "cards[y][field0]")));
  check("and only the named ones", (await p.locator("input[name='cards[y][field0]']:checked").count()) === 2);
  await p.close();
}
{
  const p = await open(CHECKS);
  const out = await fillLeverApplication({
    page: p, resumePath: RESUME, approvedShape: await shapeOf(p), reviewedLocation: null,
    answers: [answer("name", "T"), answer("email", "e@x.com"), answer("org", "G"),
              answer("cards[y][field0]", "Klingon")],
  });
  check("an option that is not offered is a handoff, never a nearest match",
    out.handoffs.some((h) => h.field === "cards[y][field0]" && /not offered/.test(h.why)),
    JSON.stringify(out.handoffs));
  check("and nothing was ticked", (await p.locator("input[name='cards[y][field0]']:checked").count()) === 0);
  await p.close();
}

console.log("\nsignatures and unanswered required questions stop");
{
  const p = await open(SIGNATURE);
  const out = await fillLeverApplication({
    page: p, resumePath: RESUME, approvedShape: await shapeOf(p), reviewedLocation: null,
    answers: [answer("name", "T"), answer("email", "e@x.com"), answer("org", "G"),
              answer("eeo[disabilitySignature]", "Tyler Pleban")],
  });
  check("a signature is never typed, even with an answer available",
    out.handoffs.some((h) => h.field === "eeo[disabilitySignature]"), JSON.stringify(out.handoffs));
  check("and the control is empty", (await p.locator("input[name='eeo[disabilitySignature]']").inputValue()) === "");
  await p.close();
}
{
  const p = await open(RADIOS);
  const out = await fillLeverApplication({
    page: p, resumePath: RESUME, approvedShape: await shapeOf(p), reviewedLocation: null,
    answers: [answer("name", "T"), answer("email", "e@x.com"), answer("org", "G"),
              answer("cards[x][field0]", "Yes")],
  });
  check("a required question with no answer is a handoff",
    out.handoffs.some((h) => h.field === "cards[x][field1]"), JSON.stringify(out.handoffs));
  await p.close();
}
{
  const p = await open(RADIOS);
  const out = await fillLeverApplication({
    page: p, resumePath: RESUME, approvedShape: await shapeOf(p), reviewedLocation: null,
    answers: [answer("name", "T"), answer("email", "e@x.com"), answer("org", "G"),
              answer("cards[x][field0]", "Yes"), answer("cards[x][field1]", null, true, "BLOCKED")],
  });
  check("a BLOCKED answer is never entered",
    out.handoffs.some((h) => h.field === "cards[x][field1]"), JSON.stringify(out.handoffs));
  await p.close();
}

console.log("\nsnapshot drift");
{
  const before = await open("");
  const shape = await shapeOf(before);
  await before.close();
  const p = await open(RADIOS);          // two required questions appeared
  let stopped = "";
  try {
    await fillLeverApplication({
      page: p, resumePath: RESUME, approvedShape: shape, reviewedLocation: null,
      answers: [answer("name", "T"), answer("email", "e@x.com"), answer("org", "G")],
    });
  } catch (e) { stopped = (e as Error).message; }
  check("a required question that was not approved stops the fill", /FORM_CHANGED|appeared/.test(stopped), stopped.slice(0, 120));
  check("and the stop names the questions", /authorized to work|sponsorship/i.test(stopped), stopped.slice(0, 160));
  await p.close();
}

console.log("\nsubmit resolution is scoped to the form");
{
  const p = await open("");
  const btn = await leverSubmitControl(p);
  check("exactly one control resolves", (await btn.innerText()) === "Submit application", await btn.innerText());
  // The page carries cookie Deny/Accept buttons outside the form.
  check("the cookie buttons exist and were not candidates",
    (await p.locator("#cookie-deny, #cookie-accept").count()) === 2);
  await p.close();
}

// Spotify's real markup: an empty type=submit sits alongside the actual
// control, which is a type=button. Selecting on type alone resolved to
// exactly one element and it was the wrong one.
console.log("\na decoy submit button does not win");
{
  const p = await newPreparedPage(browser, { viewport: { width: 1200, height: 900 } });
  await p.route(`${ORIGIN}/**`, (r) => r.fulfill({ status: 200, contentType: "text/html", body:
    `<!doctype html><body><button id="cookie-deny">Deny</button><form>
       <input type="text" name="name">
       <button type="submit"></button>
       <button type="button">Submit application</button>
     </form></body>` }));
  await p.goto(`${ORIGIN}/acme/abc/apply`, { waitUntil: "domcontentloaded" });
  const btn = await leverSubmitControl(p);
  check("the named control is chosen over the empty one",
    (await btn.innerText()).trim() === "Submit application", JSON.stringify(await btn.innerText()));
  await p.close();
}

console.log("\nan unidentifiable submit stops rather than guessing");
{
  const p = await newPreparedPage(browser, { viewport: { width: 1200, height: 900 } });
  await p.route(`${ORIGIN}/**`, (r) => r.fulfill({ status: 200, contentType: "text/html", body:
    `<!doctype html><body><form><input type="text" name="name">
       <button type="button">Continue</button><button type="button">Next</button></form></body>` }));
  await p.goto(`${ORIGIN}/acme/abc/apply`, { waitUntil: "domcontentloaded" });
  let stopped = "";
  try { await leverSubmitControl(p); } catch (e) { stopped = (e as Error).message; }
  check("stops with the candidates named", /could not be identified uniquely/.test(stopped), stopped.slice(0, 90));
  await p.close();
}

await browser.close();
console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
