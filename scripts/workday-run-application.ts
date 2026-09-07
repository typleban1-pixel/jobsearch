/**
 * One browser, one process, from your sign-in to the Review page.
 *
 *   node scripts/workday-run-application.ts <application_id>
 *
 * Northern Trust issues a SESSION cookie: it dies with the browser
 * process. So everything after the sign-in has to happen in the process
 * that watched you sign in -- opening a window, closing it, and
 * reopening to "continue" throws the session away, which has already
 * happened once here.
 *
 * It types no credential and clicks no consent control: the sign-in is
 * yours. And it never clicks Submit. Advancing uses a name list that
 * Submit is not on, and a guard refuses it even if a tenant labels its
 * Continue button something unexpected.
 */
import { existsSync, unlinkSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { chromium } from "playwright";
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { tenantFromToken, candidateHomeUrl } from "../lib/workday/tenant.ts";
import { observe, waitForWorkdayReady } from "../lib/workday/probe.ts";
import { snapshotLive } from "../lib/browser/liveSnapshot.ts";
import { mergeDiscovery, summarise } from "../lib/applications/fieldMerge.ts";
import { fillOne, selectRadioByLabel, selectListboxOption, selectPromptPath, type FillTarget } from "../lib/workday/fill.ts";
import { firstCharacterLost } from "../lib/workday/textFill.ts";
import { collapseRadioGroups } from "../lib/workday/radioGroups.ts";
import { resolveField, guardInheritedAnswer, type ResolveContext } from "../lib/applications/answer.ts";
import { loadContext, applicationScope } from "../lib/applications/prepare.ts";
import { chooseAdvance, classifyAcceptance } from "../lib/workday/advance.ts";

const ID = process.argv[2] ?? "35eaed21-599e-4480-bc7b-192677c80f18";
const DONE = ".workday-signin-done";
const MAX_PAGES = 30;          // re-passes on one page consume iterations too
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

// ---- the record ------------------------------------------------------
const { data: app } = await db.from("applications").select("id,job_id,status,resume_id").eq("id", ID).single();
if (!app) { console.error("no such application"); process.exit(1); }
const { data: job } = await db.from("jobs").select("id,title,company_id,source,application_form_url,url,remote_policy").eq("id", app.job_id).single();
const { data: co } = await db.from("companies").select("id,name,ats_token").eq("id", job!.company_id).single();
const { data: profile } = await db.from("profile").select("*").single();
const { data: employment } = await db.from("employment").select("*").order("start_date", { ascending: false });
const { data: bankRows } = await db.from("question_bank").select("*").eq("reuse_allowed", true);
const { data: jobLoc } = await db.from("job_locations").select("city,state,metro").eq("job_id", job!.id).maybeSingle();
const tenant = tenantFromToken(co!.ats_token);

/**
 * The same context prepare.ts and submit-application.ts build.
 *
 * This script used to assemble its own from `db.from("employment")` -- a
 * table that does not exist. The query failed silently, the employment
 * history arrived empty, and every question about where he has worked
 * resolved to nothing. Truth here is the FROZEN profile version, not the
 * live tables, so a resolution made now matches the one the resume was
 * rendered from.
 */
const ctx: ResolveContext = await loadContext(db);
ctx.application = await applicationScope(db, job!.id).catch(() => undefined);

console.log(`${co!.name} — ${job!.title}`);
console.log(`  application ${ID.slice(0, 8)}  ${app.status}`);
console.log(`  tenant ${tenant.host}/${tenant.site}\n`);

// ---- open, or join a window that is already signed in ----------------
//
// Attaching exists because the session cannot be moved. Workday's cookie
// dies with the browser process, so a window a person signed into can
// only ever be driven by a process that reaches THAT browser -- and
// launching another one, or reopening the profile, throws the sign-in
// away. --attach joins over the debugging port instead, and leaves the
// browser running when it is done.
const ATTACH = process.argv.includes("--attach");
let browser: any, page: any, cdp: any = null;
if (ATTACH) {
  cdp = await chromium.connectOverCDP("http://127.0.0.1:9222");
  browser = cdp.contexts()[0];
  const pages = browser.pages().filter((p: any) => !p.url().startsWith("about:"));
  page = pages[0] ?? browser.pages()[0];
  page.setDefaultTimeout(60_000);
  console.log(`attached to the running browser (${page.url()})`);
} else {
  browser = await launchApplicationContext({ debugPort: 9222 });
  page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto(candidateHomeUrl(tenant), { waitUntil: "domcontentloaded" });
  await waitForWorkdayReady(page, 30_000);
}

console.log("This window is the automated profile (.browser-profile). SIGN IN HERE.");
console.log("Nothing is typed for you and no consent control is touched.");
console.log(`Waiting for an authenticated session... (touch ${DONE} to abandon)\n`);

let signedIn = false;
if (ATTACH) {
  const o = await observe(page, tenant).catch(() => null);
  signedIn = o?.state === "SIGNED_IN";
  console.log(`observed: ${o?.state ?? "unreadable"}`);
  if (!signedIn) console.log("this window is not signed in; not proceeding.");
}
for (let i = 0; !ATTACH && i < 2400; i++) {         // up to ~2 hours
  if (existsSync(DONE)) { unlinkSync(DONE); console.log("abandoned by request."); await browser.close(); process.exit(0); }
  const o = await observe(page, tenant).catch(() => null);
  if (o && o.state === "SIGNED_IN") {
    console.log(`\nauthenticated: ${o.state}  (${page.url()})`);
    signedIn = true; break;
  }
  if (i % 10 === 0) console.log(`  [${new Date().toISOString().slice(11, 19)}] still ${o?.state ?? "unreadable"}`);
  await new Promise((r) => setTimeout(r, 3000));
}
if (!signedIn) { console.log("no session appeared; leaving the window open."); }

// ---- where is this application now? ---------------------------------
const stepOf = async () => await page.evaluate(() => {
  const t = (s: string) => (document.querySelector(s) as HTMLElement | null)?.innerText?.trim() ?? "";
  // The page heading is the careers site's banner, "NT Careers", on every
  // step. Using it to detect progress meant Save and Continue worked and
  // the run still concluded the page had not advanced. The progress bar
  // names the actual step.
  const marker = [...document.querySelectorAll("*")]
    .map((e) => (e as HTMLElement).innerText ?? "")
    .find((x) => /current step \d+ of \d+/i.test(x) && x.length < 120) ?? "";
  const m = /current step (\d+) of (\d+)\s*\n?\s*(.*)/i.exec(marker.replace(/\s+\n/g, "\n"));
  const heading = (m?.[3] ?? "").trim()
    || t('[data-automation-id="jobApplicationHeader"]') || t("h1") || t("h2");
  const prog = [...document.querySelectorAll('[data-automation-id="progressBar"] *, [role="navigation"] li')]
    .map((e) => ((e as HTMLElement).innerText ?? "").trim()).filter(Boolean).slice(0, 12);
  return { heading, prog, url: location.href, title: document.title };
});

/**
 * An application page, or some other page of the careers site?
 *
 * The first run of this discovered the JOB SEARCH page, merged its search
 * box and two filter dropdowns into the application as three new
 * questions, and then reported that nothing advanced. Discovery is only
 * meaningful where there is an application, so this is checked before
 * anything is written down rather than after.
 */
async function onApplicationPage(): Promise<boolean> {
  return await page.evaluate(() => {
    const q = (s: string) => document.querySelector(s);
    const vis = (e: Element | null) => Boolean(e && e.getClientRects().length > 0);
    // A posting is not an application. The url test that used to live
    // here matched "/job/", which every posting url contains, so the
    // posting page passed as an application and its two filter
    // dropdowns were recorded as questions. Only a control that exists
    // solely inside the application counts.
    if (vis(q('[data-automation-id="jobSearchPage"]')) || vis(q('[data-automation-id="jobSearch"]'))) return false;
    if (vis(q('[data-automation-id="jobPostingHeader"]')) && !vis(q('[data-automation-id="progressBar"]'))) return false;
    return vis(q('[data-automation-id="progressBar"]'))
      || vis(q('[data-automation-id="jobApplicationHeader"]'))
      || vis(q('[data-automation-id="applyFlowPage"]'))
      || vis(q('[data-automation-id="quickApplyModal"]'));
  });
}

/** True when this is the posting, which is where Apply lives. */
async function onPostingPage(): Promise<boolean> {
  return await page.evaluate(() =>
    [...document.querySelectorAll('a, button, [role="button"], [role="link"]')]
      .filter((e) => e.getClientRects().length > 0)
      .some((e) => /^apply$/i.test(((e as HTMLElement).innerText || "").trim())));
}

/** Finds the in-progress application and opens it. */
async function openApplication(): Promise<boolean> {
  if (await onApplicationPage()) return true;
  const base = candidateHomeUrl(tenant).replace(/\/$/, "");
  // application_form_url is null for this posting; the canonical url
  // is the one the ingest recorded, so both are tried.
  // The Apply control is an anchor with a real href: the posting url
  // plus /apply. Navigating to it is steadier than clicking a button
  // whose overlay pattern differs per tenant.
  const posting = String((job as any)!.url ?? "");
  for (const url of [job!.application_form_url ?? "", posting ? `${posting}/apply` : "", posting]) {
    if (!url) continue;
    console.log(`  looking at ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await waitForWorkdayReady(page, 30_000).catch(() => undefined);
    await page.waitForTimeout(1500);
    if (await onApplicationPage()) { console.log("  application page reached"); return true; }

    /**
     * Workday asks HOW to start: autofill from a resume, use the last
     * application, or enter it by hand. Only the manual path is taken.
     * The other two import data this system has not verified and cannot
     * attribute, which is the whole thing the evidence pipeline exists
     * to prevent -- and "use my last application" would copy answers
     * given to a different employer.
     */
    const manual = page.getByRole("button", { name: /apply manually/i })
      .or(page.getByRole("link", { name: /apply manually/i }));
    if (await manual.count().catch(() => 0)) {
      console.log("  choosing Apply Manually (autofill and last-application are not used)");
      await manual.first().click({ timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(3500);
      await waitForWorkdayReady(page, 30_000).catch(() => undefined);
      if (await onApplicationPage()) { console.log("  application page reached"); return true; }
    }

    // On the posting, Apply resumes an application already started.
    if (await onPostingPage()) {
      console.log("  posting page; clicking Apply to resume");
      await page.getByRole("button", { name: /^apply$/i }).first().click({ timeout: 15_000 })
        .catch(async () => { await page.getByRole("link", { name: /^apply$/i }).first().click({ timeout: 15_000 }).catch(() => undefined); });
      await page.waitForTimeout(4000);
      await waitForWorkdayReady(page, 30_000).catch(() => undefined);
      // Workday may offer "Use My Last Application" / "Apply Manually".
      const choices = await page.evaluate(() =>
        [...document.querySelectorAll('a, button, [role="button"]')].filter((e) => e.getClientRects().length > 0)
          .map((e) => ((e as HTMLElement).innerText || "").trim()).filter(Boolean));
      console.log(`  after Apply: ${choices.slice(0, 12).join(" | ").slice(0, 240)}`);
      if (await onApplicationPage()) { console.log("  application page reached"); return true; }
    }

    // Candidate home lists tasks. Take the one naming this posting, or a
    // plain Continue; never guess between several.
    const links = await page.evaluate(() =>
      [...document.querySelectorAll('a, button, [role="button"], [role="link"]')]
        .filter((e) => e.getClientRects().length > 0)
        .map((e) => ((e as HTMLElement).innerText || e.getAttribute("aria-label") || "").trim())
        .filter(Boolean));
    console.log(`  controls here: ${links.slice(0, 18).join(" | ").slice(0, 300)}`);
    const title = String(job!.title ?? "");
    const wanted = links.filter((l: string) => l === title || /continue application|continue|resume application/i.test(l));
    if (wanted.length === 1) {
      console.log(`  opening ${JSON.stringify(wanted[0])}`);
      await page.getByRole("link", { name: wanted[0]!, exact: true }).first().click({ timeout: 15_000 })
        .catch(async () => { await page.getByRole("button", { name: wanted[0]!, exact: true }).first().click({ timeout: 15_000 }).catch(() => undefined); });
      await waitForWorkdayReady(page, 30_000).catch(() => undefined);
      await page.waitForTimeout(2000);
      if (await onApplicationPage()) { console.log("  application page reached"); return true; }
    } else if (wanted.length > 1) {
      console.log(`  ${wanted.length} candidate links (${wanted.join(", ")}); not guessing between them`);
    }
  }
  return false;
}

const passes = new Map<string, number>();
let reachable = false;
if (signedIn) {
  console.log(`\n--- locating the application ---`);
  reachable = await openApplication();
  console.log(`\n--- current step ---`);
  console.log(JSON.stringify(await stepOf(), null, 1).slice(0, 900));
  if (!reachable) {
    console.log(`\nCould not reach an application page. Nothing was written down.`);
    console.log(`Open the application in this window yourself; the session stays alive.`);
  }
}

/** Advancing, never submitting. The choice is made by a tested guard. */
async function advance(): Promise<string | null> {
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('button, [role="button"]')]
      .filter((e) => e.getClientRects().length > 0)
      .map((e) => ((e as HTMLElement).innerText || e.getAttribute("aria-label") || "").trim())
      .filter(Boolean));
  const choice = chooseAdvance(buttons);
  if (!choice.click) { console.log(`  not advancing: ${choice.why}`); return null; }
  const label = choice.label;
  const before = (await stepOf()).heading;
  await page.getByRole("button", { name: label, exact: true }).first().click({ timeout: 20_000 }).catch(() => undefined);
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(700);
    const now = await stepOf();
    if (now.heading && now.heading !== before) return now.heading;
  }
  // The page said no. Its own error text is the reason, so record it
  // rather than "nothing advanced".
  const errors: string[] = await page.evaluate(() =>
    [...document.querySelectorAll('[data-automation-id="errorMessage"], [data-automation-id="errorHeading"], [role="alert"]')]
      .filter((e) => e.getClientRects().length > 0)
      .map((e) => ((e as HTMLElement).innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
  for (const e of [...new Set(errors)].slice(0, 6)) console.log(`  page error: ${e.slice(0, 200)}`);
  return null;
}

// ---- one page at a time ---------------------------------------------
for (let pageNo = 1; signedIn && reachable && pageNo <= MAX_PAGES; pageNo++) {
  const step = await stepOf();
  console.log(`\n=========== page ${pageNo}: ${step.heading || "(unnamed)"} ===========`);

  if (/review/i.test(step.heading)) {
    console.log("REVIEW reached. Stopping here; nothing is submitted.");
    break;
  }

  if (!(await onApplicationPage())) {
    console.log("this is not an application page; refusing to record its controls as questions.");
    break;
  }

  const raw: any = await snapshotLive(page.mainFrame() as any).catch((e: any) => ({ fields: [], error: String(e) }));
  // Controls become questions: radio options collapse to one row keyed by
  // their shared name; every other control keeps its own selector.
  // htmlType is carried across because the resolver needs to know a
  // dropdown from a text box. Used for the first read and every re-read
  // alike, so the two are compared as questions and a two-option group
  // never reads as growth.
  const questionsOf = (snap: any) => {
    const typeBySelector = new Map<string, string>(
      (snap.fields ?? []).map((f: any) => [String(f.selector ?? f.key ?? ""), String(f.htmlType ?? "text")]));
    return collapseRadioGroups((snap.fields ?? []).map((f: any) => ({
      label: String(f.label ?? ""), htmlType: String(f.htmlType ?? "text"), name: f.name ?? null,
      group: f.groupLabel ?? null,
      selector: String(f.selector ?? f.key ?? ""), required: Boolean(f.required), value: null,
    }))).map((r: any) => ({ ...r, htmlType: typeBySelector.get(r.key) ?? "text" }));
  };
  const live = questionsOf(raw);
  // An unlabelled control is not a question. The page header's language
  // and settings menus are listbox buttons with ids and no labels, so
  // they look exactly like a form dropdown to discovery and arrived as
  // two blank questions on the application.
  const named = live.filter((f: any) => String(f.question ?? "").trim().length > 0);
  const dropped = live.length - named.length;
  if (dropped) console.log(`ignoring ${dropped} unlabelled control(s); an unlabelled control is not a question`);
  live.length = 0; live.push(...named);
  console.log(`discovered ${live.length} field(s)`);
  for (const f of live) console.log(`   ${f.required ? "*" : " "} ${String(f.question).slice(0, 48).padEnd(50)} ${f.htmlType}`);

  // merge into the stored record; never erase
  const { data: stored } = await db.from("application_answers")
    .select("id,question_text,field_key,field_label,is_required,answer_text,confidence_state,category,provenance,block_kind,blocked_reason,evidence_ids")
    .eq("application_id", ID);
  const merged = mergeDiscovery(stored ?? [], live.map((f: any) => ({
    field_key: String(f.key ?? "").slice(0, 300),
    question_text: String(f.question || "unlabelled field"),
    is_required: Boolean(f.required), options: f.options ?? null,
  })));
  const t = summarise(merged);
  console.log(`merge: ${t.PRESERVED} preserved, ${t.ADDED} added, ${t.RECONCILE} reconcile, ${t.RETAINED_OFFPAGE} retained`);
  for (const m of merged) {
    if (m.action === "PRESERVED" || m.action === "RETAINED_OFFPAGE") continue;
    // A rediscovered control carries no answer. Writing it over a stored
    // one turned the confirmed "No" for previous-worker into a blank the
    // moment the group's identity was reconciled.
    const existing = (stored ?? []).find((x: any) => x.field_key === m.field.field_key);
    const keptAnswer = m.field.answer_text ?? existing?.answer_text ?? null;
    const keptState = m.field.answer_text ? m.field.confidence_state
      : (existing?.answer_text ? existing.confidence_state : m.field.confidence_state);
    const row: any = { application_id: ID, question_text: m.field.question_text, field_key: m.field.field_key,
      field_label: m.field.question_text, is_required: m.field.is_required, answer_text: keptAnswer,
      confidence_state: keptState, category: m.field.category ?? "E_UNKNOWN",
      provenance: m.field.provenance ?? "USER_RESPONSE", block_kind: m.field.block_kind,
      blocked_reason: m.field.blocked_reason, evidence_ids: m.field.evidence_ids ?? [] };
    if ((m.field as any).id) await db.from("application_answers").update(row).eq("id", (m.field as any).id);
    else await db.from("application_answers").insert(row);
  }

  // resolve anything not already settled by a person
  const { data: rows } = await db.from("application_answers")
    .select("id,question_text,field_key,is_required,confidence_state,answer_text")
    .eq("application_id", ID);
  for (const r of rows ?? []) {
    // An answer that already stands is not re-derived. Re-resolving
    // VERIFIED rows overwrote the PREFERRED first name with the legal
    // one, because both questions are called "First Name" and the intent
    // matcher can only see the label. Only empty or blocked rows are
    // resolved here.
    if (r.confidence_state === "HUMAN_CONFIRMED") continue;
    if (r.answer_text && r.confidence_state !== "BLOCKED") continue;
    const match = live.find((f: any) => String(f.key) === r.field_key);
    if (!match) continue;
    let res: any = resolveField({ key: r.field_key, label: r.question_text, required: Boolean(r.is_required),
      type: match.htmlType, options: match.options ?? [] } as any, ctx);
    if (!res || res.refused) continue;

    // A secondary field that merely echoed its primary is left blank.
    // guardInheritedAnswer existed and was tested, but nothing in
    // production called it -- so "Address Line 2" resolved to the street
    // address and "Phone Extension" to the phone number, and both were
    // written into the live form.
    res = guardInheritedAnswer(res, [
      String((profile as any)?.address_line ?? ""),
      String((profile as any)?.phone ?? ""),
      String((profile as any)?.phone_e164 ?? ""),
    ].filter(Boolean));

    /**
     * An answer that is not on the control's own list is not an answer.
     *
     * "Phone Device Type" matched a phone intent and resolved to the
     * phone NUMBER, against a control offering Fax, Landline and Mobile.
     * The listbox filler refused it, correctly, but by then it was
     * recorded as this field's answer. Where the live control states its
     * choices, an answer outside them is blocked for a person instead.
     */
    const opts: string[] = (match.options ?? []) as string[];
    if (res.answer && opts.length && !opts.some((o) => String(o).trim().toLowerCase() === String(res.answer).trim().toLowerCase())) {
      const { normalizeCountryName, normalizeRegionName } = await import("../lib/browser/geography.ts");
      const same = opts.some((o) => normalizeCountryName(o) === normalizeCountryName(res.answer)
        || normalizeRegionName(o) === normalizeRegionName(res.answer));
      if (!same) {
        res = { ...res, answer: null, confidence: "BLOCKED", blockKind: "UNKNOWN",
          blockedReason: `the control offers ${opts.length} choices and ${JSON.stringify(res.answer)} is not one of them `
            + `(${opts.slice(0, 8).join(" | ")}${opts.length > 8 ? " ..." : ""})` };
      }
    }
    await db.from("application_answers").update({
      answer_text: res.answer ?? null, confidence_state: res.confidence ?? "BLOCKED",
      block_kind: res.blockKind ?? null, blocked_reason: res.blockedReason ?? null,
      evidence_ids: res.evidenceIds ?? [],
    }).eq("id", r.id);
  }

  // fill what is settled, and read every one back
  const { data: toFill } = await db.from("application_answers")
    .select("question_text,field_key,answer_text,confidence_state,is_required")
    .eq("application_id", ID);
  const here = (toFill ?? []).filter((a: any) => live.some((f: any) => String(f.key) === a.field_key));
  let failed = 0, filled = 0;
  const blockedAcceptance: { q: string; why: string }[] = [];
  /**
   * What every control a selector matches currently holds.
   *
   * My Experience repeats its blocks -- one School or University per
   * education entry -- and workday-experience-fill.ts fills them block by
   * block. A selector that matches several controls, all holding values,
   * is a section that has been completed by that script, not a question
   * for this loop; writing to "the" control would be choosing between
   * blocks. Held values are read from the page, the only authority.
   */
  const heldValues = async (key: string): Promise<string[]> => await page.locator(`${key}:visible`)
    .evaluateAll((els: any[]) => els.map((e) => {
      const tag = e.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return String(e.value ?? "");
      const box = e.closest('[data-automation-id="multiSelectContainer"]');
      if (box) return [...box.querySelectorAll('[data-automation-id="selectedItem"]')].map((x: any) => x.innerText).join(", ");
      return String(e.innerText ?? "");
    }).map((v: string) => (/^select one$/i.test(v.trim()) ? "" : v.trim()))).catch(() => [] as string[]);

  for (const a of here as any[]) {
    // An agreement is entered into by a person, never filled in from a
    // profile. A stored acceptance for one employer is not consent to
    // another's terms.
    const acc = classifyAcceptance(`${a.question_text} ${a.field_key}`);
    const held = await heldValues(a.field_key);
    // A control inside a numbered block -- "Education 2", "Work
    // Experience 4" -- belongs to the experience fill whatever its key.
    const block: string | null = await page.locator(`${a.field_key}:visible`).first().evaluate((el: any) => {
      let n: any = el;
      for (let i = 0; i < 14 && n; i++) {
        const heads = [...n.querySelectorAll(":scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > div > h2, :scope > div > h3, :scope > div > h4, :scope > div > h5")]
          .map((x: any) => String(x.innerText ?? "").trim());
        const h = heads.find((t: string) => /^(Work Experience|Education) \d+$/i.test(t));
        if (h) return h;
        n = n.parentElement;
      }
      return null;
    }).catch(() => null);
    if (block && held.length === 1) {
      if (held[0]!.length) { filled++; console.log(`   held ${String(a.question_text).slice(0, 40).padEnd(42)} answered on the page (${block})`); }
      else console.log(`   --   ${String(a.question_text).slice(0, 40).padEnd(42)} left blank by the experience fill (${block}); not written here`);
      continue;
    }
    if (held.length > 1) {
      // A repeated section. Filled block by block by workday-experience-fill,
      // never by this loop, which cannot know which block a single stored
      // answer belongs to. All held: answered. Some empty: left as the
      // experience fill left them (an optional Field of Study it could not
      // map stays blank), and reported.
      const empty = held.filter((v) => !v.length).length;
      if (!empty) { filled++; console.log(`   held ${String(a.question_text).slice(0, 40).padEnd(42)} ${held.length} blocks, all answered on the page`); }
      else console.log(`   --   ${String(a.question_text).slice(0, 40).padEnd(42)} ${held.length} blocks, ${empty} left blank by the experience fill; not written here`);
      continue;
    }
    if (acc.kind === "NEEDS_A_PERSON") {
      console.log(`   STOP ${String(a.question_text).slice(0, 40).padEnd(42)} ${acc.why}`);
      blockedAcceptance.push({ q: String(a.question_text), why: acc.why });
      continue;
    }
    if (acc.kind === "STANDARD") {
      const box = page.locator(`${a.field_key}:visible`).first();
      if (await box.count().catch(() => 0)) {
        if (!(await box.isChecked().catch(() => false))) await box.check({ timeout: 8000 }).catch(() => undefined);
        const on = await box.isChecked().catch(() => false);
        console.log(`   ${on ? "ok  " : "FAIL"} ${String(a.question_text).slice(0, 40).padEnd(42)} acknowledged (${on})`);
        if (!on) failed++;
      }
      continue;
    }
    if (!a.answer_text || a.confidence_state === "BLOCKED") continue;
    const target: FillTarget = { selector: a.field_key, label: a.question_text, value: a.answer_text,
      confidence: a.confidence_state, required: Boolean(a.is_required) };
    /**
     * A checkbox that IS an option, not a yes/no.
     *
     * Workday's disability self-identification renders three mutually
     * exclusive statements as three checkboxes. The stored answer is the
     * text of the chosen statement, so applying it to every checkbox in
     * the group ticked the wrong ones. A checkbox is ticked only when
     * its own label is the answer.
     */
    const isOptionCheckbox = live.some((f: any) => String(f.key) === a.field_key && f.htmlType === "checkbox")
      && !/^(yes|no|true|false|)$/i.test(String(a.answer_text ?? "").trim());
    if (isOptionCheckbox) {
      const box = page.locator(`${a.field_key}:visible`).first();
      if (await box.count().catch(() => 0)) {
        const mine = String(a.question_text).trim().toLowerCase()
          === String(a.answer_text).trim().toLowerCase();
        if (mine) await box.check({ timeout: 8000 }).catch(() => undefined);
        else await box.uncheck({ timeout: 8000 }).catch(() => undefined);
        const on = await box.isChecked().catch(() => false);
        const ok = on === mine;
        console.log(`   ${ok ? "ok  " : "FAIL"} ${String(a.question_text).slice(0, 40).padEnd(42)} ${on ? "checked" : "unchecked"}`);
        if (!ok) failed++; else filled++;
      }
      continue;
    }

    // A dropdown that is a button, not a select, needs the listbox path;
    // fillOne has nothing to write to and reports the control type as
    // unfamiliar, which is how Country stopped this page dead.
    // A multiSelectContainer is a TREE prompt: its levels have to be
    // walked. Sending it to the flat listbox path typed a category name
    // into the search box and committed nothing.
    const isPromptTree = await page.locator(`${a.field_key}:visible`).first()
      .evaluate((el: any) => Boolean(el.closest('[data-automation-id="multiSelectContainer"]')))
      .catch(() => false);
    const isListbox = await page.locator(`${a.field_key}:visible`).first()
      .evaluate((el: any) => {
        const tag = el.tagName;
        if (tag === "SELECT" || tag === "TEXTAREA") return false;
        // An input that opens a listbox is a chooser, not a text box.
        if (tag === "INPUT") {
          return el.getAttribute("role") === "combobox"
            || el.getAttribute("aria-haspopup") === "listbox"
            || el.getAttribute("aria-autocomplete") === "list";
        }
        return true;
      })
      .catch(() => false);
    const out = a.field_key.startsWith("radio-group:")
      // The stored key already carries the prefix; radioGroupKey ADDS
      // one, so passing it through produced "radio-group:radio-group:...".
      ? await selectRadioByLabel(page, a.field_key.slice("radio-group:".length), a.answer_text)
      : isPromptTree
        ? await selectPromptPath(page, a.field_key, a.answer_text)
        : isListbox
        ? await selectListboxOption(page, a.field_key, a.answer_text)
        : await fillOne(page, target);
    if (out.status === "FAILED") { failed++; console.log(`   FAIL ${a.question_text}: ${out.why}`); }
    else {
      const back = String((out as any).readBack ?? "");
      // A value that lost its first character reads back as a plausible
      // string, so it is checked for explicitly rather than trusted.
      if (firstCharacterLost(String(a.answer_text), back)) {
        failed++;
        console.log(`   FAIL ${String(a.question_text).slice(0, 40).padEnd(42)} first character lost: ${JSON.stringify(back)}`);
      } else {
        filled++;
        console.log(`   ok   ${String(a.question_text).slice(0, 40).padEnd(42)} ${JSON.stringify(back)}`);
      }
    }
  }
  console.log(`filled ${filled}, failed ${failed}`);

  // An acknowledgment is ticked above and has no stored answer text, so
  // counting it as unanswered stopped a page it had just completed.
  /**
   * A deliberately unticked option is answered, not missing.
   *
   * Mutually exclusive checkboxes are each marked required because the
   * GROUP is required. Counting the two the person did not choose as
   * unanswered stopped a page where the right box was already ticked.
   * An empty answer only means "unanswered" for a control you write
   * into.
   */
  const isCheckbox = (key: string) => live.some((f: any) => String(f.key) === key && f.htmlType === "checkbox");
  /**
   * A control that already holds a value is answered, whoever answered it.
   *
   * My Experience is filled by workday-experience-fill.ts from the approved
   * résumé, block by block; its Job Title and Company rows stay BLOCKED in
   * the answer table because no single-field intent can answer a bare
   * "Company". Stopping on them after they are visibly filled would stop
   * every Workday application on page 2. The page is the authority: a
   * required control with a committed value is not a blocker.
   */
  const holdsValue = async (key: string): Promise<boolean> => {
    const held = await heldValues(key);
    return held.length > 0 && held.every((v) => v.length > 0);
  };
  const candidates = (here as any[]).filter((a) => a.is_required
    && classifyAcceptance(`${a.question_text} ${a.field_key}`).kind === "NOT_ACCEPTANCE"
    && (a.confidence_state === "BLOCKED"
        || (!a.answer_text && !(isCheckbox(a.field_key) && a.answer_text === ""))));
  const blocked: any[] = [];
  for (const a of candidates) {
    if (await holdsValue(a.field_key)) { console.log(`   held ${String(a.question_text).slice(0, 40).padEnd(42)} already answered on the page`); continue; }
    blocked.push(a);
  }
  if (blocked.length) {
    console.log(`\nSTOPPING: ${blocked.length} required question(s) this system will not answer for you:`);
    for (const b of blocked) console.log(`   - ${b.question_text}`);
    break;
  }
  if (blockedAcceptance.length) {
    console.log(`\nSTOPPING: ${blockedAcceptance.length} acknowledgment(s) need you to read them:`);
    for (const x of blockedAcceptance) console.log(`   - ${x.q.slice(0, 90)}  (${x.why})`);
    break;
  }
  if (failed) { console.log("\nSTOPPING: a control did not accept its value; not advancing on a partial page."); break; }

  /**
   * Everything visible and required has to be accounted for.
   *
   * Discovery finding fewer controls than the page shows is not
   * detectable from inside discovery: it reports what it found, and a
   * question it never saw is simply absent. So the page is read a second
   * time, independently, for anything marked required, and any required
   * control that is not among the discovered fields stops the run. A
   * missed required field would otherwise be left blank and the page
   * submitted as if complete.
   */
  /**
   * Workday reveals fields as earlier ones are answered: the address
   * block does not exist until Country is chosen. Discovering once and
   * advancing would leave every revealed field blank, so the page is
   * read again and re-processed while it keeps growing.
   */
  {
    const again: any = await snapshotLive(page.mainFrame() as any).catch(() => ({ fields: [] }));
    const namedAgain = questionsOf(again).filter((f: any) => String(f.question ?? "").trim().length > 0);
    if (namedAgain.length > live.length) {
      passes.set(step.heading, (passes.get(step.heading) ?? 0) + 1);
      if ((passes.get(step.heading) ?? 0) <= 4) {
        console.log(`the page revealed ${namedAgain.length - live.length} more field(s); reading it again`);
        pageNo--;                       // the same page, not the next one
        continue;
      }
      console.log(`the page is still revealing fields after 4 passes; stopping rather than looping`);
      break;
    }
  }

  const covered = new Set(live.map((f: any) => String(f.key)));
  const uncovered = await page.evaluate((known: string[]) => {
    const vis = (e: Element) => e.getClientRects().length > 0;
    const out: { label: string; id: string; tag: string }[] = [];
    const seen = new Set(known);
    const nodes = [...document.querySelectorAll('[aria-required="true"], [required]')].filter(vis)
      // A fieldset marked required is the group, not a control; its
      // members are audited individually just below.
      .filter((e) => !["FIELDSET", "DIV", "SECTION"].includes(e.tagName));
    for (const el of nodes) {
      // Escaped the same way discovery escapes it. An id beginning with
      // a digit becomes "#\36 4cbff..." there and "#64cbff..." here, so
      // controls that WERE discovered looked unaccounted for.
      const id = el.id ? `#${CSS.escape(el.id)}` : "";
      const name = el.getAttribute("name") ? `[name="${el.getAttribute("name")}"]` : "";
      const auto = el.getAttribute("data-automation-id") ? `[data-automation-id="${el.getAttribute("data-automation-id")}"]` : "";
      // Any identity discovery might have stored it under.
      if ([id, name, auto].some((k) => k && seen.has(k))) continue;
      if (name && [...seen].some((k) => k.startsWith("radio-group:") && name.includes(k.slice("radio-group:".length)))) continue;
      const lbl = (el.getAttribute("aria-label")
        || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : "")
        || el.closest("label")?.textContent
        || el.closest("[data-automation-id]")?.getAttribute("data-automation-id") || "").replace(/\s+/g, " ").trim();
      out.push({ label: lbl.slice(0, 70), id: id || name || auto || "(no identity)", tag: el.tagName });
    }
    return out;
  }, [...covered]);

  if (uncovered.length) {
    console.log(`\nSTOPPING: ${uncovered.length} visible required control(s) discovery did not account for:`);
    for (const u of uncovered) console.log(`   - ${u.label || "(unlabelled)"}  ${u.id}  <${u.tag.toLowerCase()}>`);
    console.log("Not clicking Save and Continue on a page whose required fields are not all represented.");
    break;
  }

  const next = await advance();
  if (!next) { console.log("\nno Continue control advanced the page; stopping here."); break; }
  console.log(`advanced to: ${next}`);
}

console.log(`\nThe browser stays open so the session survives. touch ${DONE} to close it.`);
if (ATTACH) {
  // Disconnect, leaving the window and the session exactly as found.
  await cdp.close().catch(() => undefined);
  console.log("detached; the browser and its session are untouched.");
  process.exit(0);
}
for (;;) {
  if (existsSync(DONE)) { unlinkSync(DONE); break; }
  await new Promise((r) => setTimeout(r, 3000));
}
await browser.close();
console.log("closed.");
