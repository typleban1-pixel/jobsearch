/**
 * Holds one browser open across sign-in AND field discovery.
 *
 *   node scripts/workday-signin-and-discover.ts <application_id>
 *
 * Northern Trust issues a SESSION cookie: it dies with the browser
 * process. Opening a window to sign in and then closing it to "free the
 * profile" therefore discards the session that was just established,
 * which is exactly what happened once. So this never closes between the
 * two steps -- the same context that watches you sign in is the one that
 * reads the form.
 *
 * It types nothing, clicks no consent control, and submits nothing.
 */
import { existsSync, unlinkSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { tenantFromToken, candidateHomeUrl } from "../lib/workday/tenant.ts";
import { observe, waitForWorkdayReady, readSignals } from "../lib/workday/probe.ts";
import { snapshotLive } from "../lib/browser/liveSnapshot.ts";
import { mergeDiscovery, summarise } from "../lib/applications/fieldMerge.ts";
import { fillOne, failures, type FillTarget, type FillReport } from "../lib/workday/fill.ts";
import { radioOptionSelector, radioGroupKey } from "../lib/workday/radioGroups.ts";

const ID = process.argv[2] ?? "35eaed21-599e-4480-bc7b-192677c80f18";
const DONE = ".workday-signin-done";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: app } = await db.from("applications").select("id,job_id,status").eq("id", ID).single();
const { data: job } = await db.from("jobs").select("id,title,company_id,url,application_form_url").eq("id", app!.job_id).single();
const { data: co } = await db.from("companies").select("name,ats_token").eq("id", job!.company_id).single();
const tenant = tenantFromToken(co!.ats_token);

const ctx = await launchApplicationContext();
let page = await ctx.newPage();
page.setDefaultTimeout(45_000);

/**
 * The auth state resolves AFTER the spinner clears and shows Sign In in
 * the interim, so waiting for "either marker" returns on the signed-out
 * one every time. Wait for the authenticated markers specifically.
 */
const settle = async () => {
  await waitForWorkdayReady(page, 30_000);
  await page.waitForFunction(() => {
    const q = (id: string) => document.querySelector(`[data-automation-id="${id}"]`);
    return Boolean(q("utilityButtonSignOut") || q("utilityButtonAccountTasksMenu")
      || q("candidateHomePage") || q("candidate-home-app"));
  }, null, { timeout: 15_000 }).catch(() => { /* genuinely signed out */ });
};

/**
 * Finds and clicks the Apply control.
 *
 * Workday's real buttons are aria-hidden behind a click_filter overlay,
 * so the accessible role is what resolves the element a person clicks.
 * Several labels are tried because tenants word it differently. Returns
 * false rather than clicking something merely plausible.
 */
async function clickApply(p: typeof page): Promise<boolean> {
  // Try the click FIRST, and only diagnose if it fails.
  //
  // The previous version built an element inventory, sliced it to 120
  // before filtering, found no "apply" among Workday's header controls,
  // and returned early -- so the role-based matcher below never ran at
  // all while a green Apply button sat on screen. Diagnosis must never
  // gate the action it is diagnosing.
  const strategies: Array<[string, () => any]> = [
    ["role=button name~/apply/i", () => p.getByRole("button", { name: /apply/i })],
    ["role=link name~/apply/i", () => p.getByRole("link", { name: /apply/i })],
    ["data-automation-id~apply", () => p.locator('[data-automation-id*="pply"]:visible')],
    ["text=Apply", () => p.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /^apply/i })],
  ];
  for (const [label, make] of strategies) {
    const loc = make();
    const n = await loc.count().catch(() => 0);
    if (!n) continue;
    console.log(`  Apply found by ${label} (${n} match(es)); clicking the first`);
    try { await loc.first().click({ timeout: 15_000 }); return true; }
    catch (e) { console.log(`    click failed: ${String(e).split("\n")[0]!.slice(0, 100)}`); }
  }

  // Only now, and without truncating before the filter.
  const inventory = await p.evaluate(() => {
    const vis = (e: Element) => e.getClientRects().length > 0;
    const label = (e: Element) =>
      (e.getAttribute("aria-label") || (e as HTMLElement).innerText || "").trim().slice(0, 60);
    return [...document.querySelectorAll('button, a, [role="button"], [role="link"], [data-automation-id]')]
      .filter(vis).map((e) => ({ tag: e.tagName, id: e.getAttribute("data-automation-id"), label: label(e) }));
  });
  const applyish = inventory.filter((x: any) => /apply/i.test(`${x.label} ${x.id ?? ""}`));
  console.log(`  no strategy clicked. ${inventory.length} visible control(s), ${applyish.length} matching /apply/i:`);
  for (const x of applyish.slice(0, 10)) console.log(`    ${x.tag} id=${x.id ?? "-"} "${x.label}"`);
  console.log(`  frames: ${p.frames().length}`);
  return false;
}

await page.goto(candidateHomeUrl(tenant), { waitUntil: "domcontentloaded" });
await settle();
console.log(`${co!.name} — ${job!.title}`);
console.log(`This is the automated profile. Sign in HERE if it is not already.`);
console.log(`Nothing is typed or clicked by this script. The window stays open.\n`);

// Wait for a session, however it arrives.
let state = (await observe(page, tenant)).state;
let last: string | null = null;
for (let i = 0; state !== "SIGNED_IN"; i++) {
  if (existsSync(DONE)) { unlinkSync(DONE); console.log("stopped at your request"); await ctx.close(); process.exit(0); }
  if (state !== last) { console.log(`  [${new Date().toISOString().slice(11, 19)}] ${state}`); last = state; }
  await new Promise((r) => setTimeout(r, 3000));
  try { state = (await observe(page, tenant)).state; } catch { /* mid-navigation */ }
  if (i > 200) { console.log("no session after 10 minutes; stopping"); await ctx.close(); process.exit(1); }
}
console.log(`  SIGNED_IN — discovering fields without closing this browser\n`);

// ---- adopt the tab that is actually on the posting --------------------
//
// ctx.newPage() opens a tab ALONGSIDE whatever Chrome restored, so the
// page this script drives is not necessarily the page on screen. Four
// discovery attempts failed against a tab that reported SIGNED_IN with
// 35 controls and no Apply button, while a green Apply sat on the user's
// tab at the same URL. Enumerate first, bind second, click last.
const url = job!.application_form_url ?? job!.url;

async function describe(pg: any, i: number) {
  let u = "", t = "", heading = false, apply = false;
  try {
    u = pg.url(); t = await pg.title().catch(() => "");
    heading = await pg.locator(`text=${JSON.stringify(job!.title)}`).first().isVisible({ timeout: 1500 }).catch(() => false);
    const a = pg.getByRole("button", { name: /apply/i });
    apply = (await a.count().catch(() => 0)) > 0
      ? await a.first().isVisible({ timeout: 1500 }).catch(() => false)
      : false;
  } catch { /* a tab mid-navigation describes as much as it can */ }
  return { i, url: u, title: t, heading, apply };
}

const pages = ctx.pages();
console.log(`\nopen tabs: ${pages.length}`);
const described = [];
for (let i = 0; i < pages.length; i++) {
  const d = await describe(pages[i], i);
  described.push(d);
  console.log(`  [${d.i}] apply=${d.apply ? "YES" : "no "} heading=${d.heading ? "YES" : "no "}  ${d.title.slice(0, 40).padEnd(42)} ${d.url.slice(0, 76)}`);
}

// Prefer a tab that already shows Apply; then one on the posting URL.
let target = pages[described.find((d) => d.apply)?.i ?? -1]
  ?? pages[described.find((d) => d.url === url && d.heading)?.i ?? -1]
  ?? null;

if (target) {
  console.log(`  adopting tab [${pages.indexOf(target)}] -- the one showing the posting`);
  page = target as any;
  await page.bringToFront().catch(() => {});
} else {
  console.log(`  no tab shows the posting; navigating this one`);
  await page.goto(url!, { waitUntil: "domcontentloaded" });
  // The job CARD renders after the header, and settle() only waits for
  // the header's auth markers. Wait for the card itself.
  await settle();
  await page.getByRole("button", { name: /apply/i }).first()
    .waitFor({ state: "visible", timeout: 20_000 })
    .catch(() => console.log(`  (no Apply control appeared within 20s)`));
}

const confirmed = await describe(page, pages.indexOf(page as any));
console.log(`  controlling: apply=${confirmed.apply} heading=${confirmed.heading} url=${confirmed.url.slice(0, 76)}`);
if (!confirmed.apply) {
  console.log(`\nNOT clicking: the controlled tab does not show an Apply control.`);
  console.log(`Nothing has been clicked. The browser stays open.`);
  for (;;) { if (existsSync(DONE)) { unlinkSync(DONE); break; } await new Promise((r) => setTimeout(r, 3000)); }
  await ctx.close();
  process.exit(0);
}

const post = await observe(page, tenant);
console.log(`posting page state: ${post.state}`);
const sig = await readSignals(page);
const applyish = sig.automationIds.filter((i) => /apply|autofill|resume|manual|usemylast/i.test(i));
console.log(`apply-related controls: ${JSON.stringify(applyish)}`);

// The posting page is the job description. The form is behind Apply.
//
// A first run discovered zero fields because it read the description
// page and stopped: "apply-related controls: []" was the tell. Clicking
// Apply starts the application, which is reversible and submits nothing;
// it is also the only way to see what the employer will ask.
let snap: any = await snapshotLive(page.mainFrame() as any).catch((e: any) => ({ error: String(e).slice(0, 140) } as any));
if ((snap.fields?.length ?? 0) === 0) {
  console.log(`no fields on the description page; opening the application form`);
  const applied = await clickApply(page);
  if (!applied) {
    console.log(`could not find an Apply control. Nothing was clicked.`);
  } else {
    await settle();
    const after = await observe(page, tenant);
    console.log(`after Apply: ${after.state}  url=${page.url()}`);
    const sig2 = await readSignals(page);
    console.log(`controls now visible: ${JSON.stringify(sig2.automationIds.filter((i) => /apply|autofill|resume|manual|usemylast|quickapply/i.test(i)))}`);
    snap = await snapshotLive(page.mainFrame() as any).catch((e: any) => ({ error: String(e).slice(0, 140) } as any));

    // Apply opens a method chooser, not the form:
    //   autofillWithResume · applyManually · useMyLastApplication · applyWithLinkedIn
    //
    // Apply Manually is the only branch that neither uploads a file nor
    // pulls in a third-party profile, so it is the one that shows the
    // employer's actual questions and nothing else.
    if ((snap.fields?.length ?? 0) === 0) {
      const manual = page.locator('[data-automation-id="applyManually"]:visible');
      if (await manual.count()) {
        console.log(`  choosing "Apply Manually" (no upload, no third-party profile)`);
        await manual.first().click({ timeout: 15_000 }).catch((e) => console.log(`    click failed: ${String(e).split("\n")[0]!.slice(0, 90)}`));
        await settle();
        // The form renders after the chooser closes; wait for a real
        // input rather than a fixed delay.
        await page.locator('input:visible, textarea:visible, select:visible').first()
          .waitFor({ state: "visible", timeout: 25_000 })
          .catch(() => console.log(`    (no form control appeared within 25s)`));
        const after2 = await observe(page, tenant);
        console.log(`  after Apply Manually: ${after2.state}  url=${page.url().slice(0, 90)}`);
        snap = await snapshotLive(page.mainFrame() as any).catch((e: any) => ({ error: String(e).slice(0, 140) } as any));
      } else {
        console.log(`  no "Apply Manually" option visible; leaving the chooser untouched`);
      }
    }
  }
}
console.log(`\nfields discovered: ${snap.fields?.length ?? JSON.stringify(snap)}`);
if (snap.fields) {
  console.log(`loginWall=${snap.loginWall} captcha=${snap.captcha} sso=${sig.sso} forms=${snap.formCount}`);
  for (const f of snap.fields.slice(0, 30)) {
    console.log(`   ${f.required ? "*" : " "} ${String(f.label).slice(0, 54).padEnd(56)} ${f.htmlType}`);
  }
}
// ---- the preferred-name checkbox, when authorised ---------------------
//
// Ticking it makes Workday reveal further preferred-name fields, so it
// changes the form rather than merely answering it. Done only under
// --tick-preferred-name, and the page is re-read afterwards so the new
// fields are discovered rather than assumed.
if (process.argv.includes("--tick-preferred-name") && snap.fields?.length) {
  const box = page.locator('input[type="checkbox"]:visible').filter({ hasNotText: "" });
  const byLabel = page.getByLabel(/preferred name/i);
  const target = (await byLabel.count()) ? byLabel : box;
  if (await target.count()) {
    const already = await target.first().isChecked().catch(() => false);
    if (already) {
      console.log(`  "I have a preferred name" was already ticked`);
    } else {
      console.log(`  ticking "I have a preferred name" (you authorised this)`);
      await target.first().check({ timeout: 15_000 }).catch((e) =>
        console.log(`    could not tick: ${String(e).split("\n")[0]!.slice(0, 90)}`));
      // New controls render after the box is ticked; wait for the count
      // to grow rather than for a fixed delay.
      const before = snap.fields.length;
      await page.waitForFunction((n: number) =>
        [...document.querySelectorAll("input, select, textarea")]
          .filter((e) => e.getClientRects().length > 0).length > n,
        before, { timeout: 15_000 }).catch(() => console.log(`    (no new fields appeared within 15s)`));
    }
    snap = await snapshotLive(page.mainFrame() as any).catch((e: any) => ({ error: String(e).slice(0, 140) } as any));
    console.log(`  fields after ticking: ${snap.fields?.length ?? 0}`);
    if (snap.fields) for (const f of snap.fields) console.log(`     ${f.required ? "*" : " "} ${String(f.label).slice(0, 54).padEnd(56)} ${f.htmlType}`);
  } else {
    console.log(`  no preferred-name checkbox found on the page`);
  }
}

// ---- read questions without answering them ----------------------------
//
// Two fields could not be resolved because the snapshot captured a
// control without the question it belongs to: a searchable input labelled
// "How Did You Hear About Us?" whose options are not in the DOM until it
// is opened, and a bare radio labelled "Yes". Reading is not answering:
// nothing is selected here.
if (process.argv.includes("--read-questions") && snap.fields?.length) {
  console.log(`\n--- reading question context (nothing is selected) ---`);

  // The radio's real question is the text of its enclosing group.
  const radios = await page.evaluate(() => {
    const vis = (e: Element) => e.getClientRects().length > 0;
    return [...document.querySelectorAll('input[type="radio"]')].filter(vis).map((el) => {
      // Walk up to the labelled group: a fieldset, a role=group, or the
      // nearest ancestor carrying an aria-label or legend.
      let n: HTMLElement | null = el.parentElement;
      let question = "", depth = 0;
      while (n && depth++ < 8) {
        const aria = n.getAttribute("aria-label") || n.getAttribute("aria-labelledby");
        const legend = n.querySelector("legend")?.textContent?.trim();
        if (legend) { question = legend; break; }
        if (aria && !/^yes$|^no$/i.test(aria)) { question = aria; break; }
        if (n.getAttribute("role") === "group" || n.tagName === "FIELDSET") {
          question = (n.innerText || "").split("\n")[0]!.trim(); break;
        }
        n = n.parentElement;
      }
      const groupText = (n?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300);
      const siblings = n ? [...n.querySelectorAll('input[type="radio"]')].map((r) => {
        const id = r.getAttribute("id");
        const lab = id ? document.querySelector(`label[for="${id}"]`)?.textContent?.trim() : null;
        return lab || (r.closest("label")?.textContent?.trim()) || r.getAttribute("value") || "?";
      }) : [];
      return { question, groupText, choices: [...new Set(siblings)], name: el.getAttribute("name") };
    });
  });
  for (const r of radios) {
    console.log(`\n  RADIO GROUP  name=${r.name ?? "-"}`);
    console.log(`    question: ${r.question || "(no legend or aria-label found)"}`);
    console.log(`    choices:  ${JSON.stringify(r.choices)}`);
    console.log(`    context:  ${r.groupText}`);
  }

  // The source-of-referral control. Its options load on open, so it is
  // opened and read, then closed with Escape. No option is chosen.
  const src = page.getByLabel(/how did you hear/i).first();
  if (await src.count()) {
    console.log(`\n  "How Did You Hear About Us?" -- opening to read the options`);
    await src.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const opts = await page.evaluate(() => {
      const vis = (e: Element) => e.getClientRects().length > 0;
      return [...document.querySelectorAll('[role="option"], li[data-automation-id], [data-automation-id*="promptOption"]')]
        .filter(vis).map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean).slice(0, 60);
    });
    console.log(`    ${opts.length} option(s): ${JSON.stringify(opts)}`);
    await page.keyboard.press("Escape").catch(() => {});
    console.log(`    closed without selecting anything`);
  } else {
    console.log(`\n  could not locate the "How Did You Hear About Us?" control by label`);
  }
}

// Persist what was found so the portal stops showing an empty form.
if (snap.fields?.length) {
  // The real column set, and the real enums. An earlier attempt invented
  // both -- an ON CONFLICT target that is not a constraint and a
  // provenance value that is not in the type -- and wrote nothing.
  //
  // Every discovered field lands BLOCKED with block_kind UNKNOWN: the
  // form has been read, and nothing has been answered. Resolution
  // against verified truth is the answer pipeline's job, not this
  // script's, and pre-filling here would bypass the evidence rules.
  const rows = snap.fields.map((f: any) => ({
    application_id: ID,
    question_text: String(f.label ?? f.name ?? "unlabelled field").slice(0, 500),
    field_key: String(f.selector ?? f.name ?? f.label ?? "").slice(0, 300),
    field_label: String(f.label ?? "").slice(0, 300),
    is_required: Boolean(f.required),
    options: f.options ?? null,
    category: "E_UNKNOWN" as const,
    provenance: "USER_RESPONSE" as const,
    confidence_state: "BLOCKED" as const,
    block_kind: "UNKNOWN" as const,
    blocked_reason: "discovered on the employer's form; not yet resolved against verified evidence",
    answer_text: null,
  }));
  // MERGE, never replace.
  //
  // This used to delete every answer row and re-insert from the DOM, so
  // each pass reset fields already resolved -- including HUMAN_CONFIRMED
  // answers, which a person supplied and no resolver can regenerate. On
  // a multi-step form it is worse still: page 2's DOM contains none of
  // page 1's questions, so a delete here would discard the whole first
  // page. See lib/applications/fieldMerge.ts.
  const { data: existing } = await db.from("application_answers")
    .select("id,field_key,question_text,is_required,answer_text,confidence_state,category,provenance,block_kind,blocked_reason,evidence_ids")
    .eq("application_id", ID);
  const merged = mergeDiscovery((existing ?? []) as any, rows.map((r: any) => ({
    field_key: r.field_key, question_text: r.question_text,
    is_required: r.is_required, options: r.options ?? null,
  })));
  const t = summarise(merged);
  console.log(`  merge: ${t.PRESERVED} preserved, ${t.ADDED} added, ${t.RECONCILE} need reconciliation, ${t.RETAINED_OFFPAGE} retained from earlier steps`);
  for (const m of merged.filter((x) => x.action === "RECONCILE")) {
    console.log(`    RECONCILE "${m.field.question_text}": ${m.changed?.join(", ")}`);
  }
  let error: any = null;
  for (const m of merged) {
    if (m.action === "RETAINED_OFFPAGE") continue;          // already correct on disk
    if (m.action === "PRESERVED") continue;                 // nothing to write
    const row: any = {
      application_id: ID, question_text: m.field.question_text, field_key: m.field.field_key,
      field_label: m.field.question_text, is_required: m.field.is_required,
      answer_text: m.field.answer_text, confidence_state: m.field.confidence_state,
      category: m.field.category ?? "E_UNKNOWN", provenance: m.field.provenance ?? "USER_RESPONSE",
      block_kind: m.field.block_kind, blocked_reason: m.field.blocked_reason,
      evidence_ids: m.field.evidence_ids ?? [],
    };
    const r = (m.field as any).id
      ? await db.from("application_answers").update(row).eq("id", (m.field as any).id)
      : await db.from("application_answers").insert(row);
    if (r.error) error = r.error;
  }
  console.log(error ? `\ncould not record fields: ${error.message}` : `\nrecorded ${rows.length} field(s) against the application`);
  if (!error) {
    // Status follows the actual state, not the act of discovering.
    //
    // This set BLOCKED_NEEDS_INPUT unconditionally, so a rediscovery of
    // a fully-resolved page pushed it back to blocked and undid the
    // AWAITING_REVIEW that resolving every field had earned.
    const { data: nowRows } = await db.from("application_answers")
      .select("confidence_state").eq("application_id", ID);
    const stillBlocked = (nowRows ?? []).filter((r: any) => r.confidence_state === "BLOCKED").length;
    await db.from("applications").update({
      status: stillBlocked > 0 ? "BLOCKED_NEEDS_INPUT" : "AWAITING_REVIEW",
      form_snapshot: snap as any,
      prepared_at: new Date().toISOString(),
      blocked_reason: stillBlocked > 0
        ? `${stillBlocked} field(s) on the employer's form need your answer`
        : null,
    }).eq("id", ID);
    console.log(`application is ${stillBlocked > 0 ? `BLOCKED_NEEDS_INPUT (${stillBlocked} blocked)` : "AWAITING_REVIEW (all fields resolved)"}`);
  }
}

// ---- fill the resolved answers into the employer's form ---------------
//
// Discovery and resolution produced answers in our database; until now
// nothing put them in the form, so Save and Continue failed validation
// on empty required inputs.
//
// Only resolved answers are typed, every value is read back from the
// control, and any mismatch or unfamiliar control stops the run before
// anything is clicked.
let fillOk = true;
if (process.argv.includes("--fill")) {
  const { data: answers } = await db.from("application_answers")
    .select("question_text,field_key,answer_text,confidence_state,is_required")
    .eq("application_id", ID);
  const blockedNow = (answers ?? []).filter((a: any) => a.confidence_state === "BLOCKED");
  if (blockedNow.length) {
    console.log(`\nNOT filling: ${blockedNow.length} field(s) are still blocked.`);
    for (const b of blockedNow) console.log(`   ${b.is_required ? "*" : " "} ${b.question_text}`);
    fillOk = false;
  } else {
    // A CAPTCHA or a page that moved is a stop, not a condition to work around.
    const pre = await observe(page, tenant);
    if (pre.signals.captcha) { console.log(`\nNOT filling: a CAPTCHA is present.`); fillOk = false; }
    else if (!pre.onTenant) { console.log(`\nNOT filling: the page left ${tenant.host}.`); fillOk = false; }
    else {
      console.log(`\nfilling ${answers!.length} resolved answer(s) and reading each back`);
      const reports: FillReport[] = [];
      for (const a of answers ?? []) {
        // A radio group's stored key is its identity, not a selector.
        // The selector needs the group name AND the chosen value, or it
        // matches every identically-labelled option on the page.
        const storedKey = String(a.field_key ?? "");
        const selector = storedKey.startsWith("radio-group:")
          ? radioOptionSelector(storedKey.slice("radio-group:".length), String(a.answer_text ?? ""))
          : storedKey;
        const target: FillTarget = {
          selector, label: String(a.question_text),
          value: String(a.answer_text ?? ""), confidence: String(a.confidence_state),
          required: Boolean(a.is_required),
        };
        if (!target.selector || target.selector === "radio-group:") {
          reports.push({ target, outcome: { status: "FAILED", why: "no selector recorded for this field" } });
          continue;
        }
        const outcome = await fillOne(page, target);
        reports.push({ target, outcome });
        const mark = outcome.status === "FAILED" ? "FAIL " : outcome.status === "SKIPPED_BLANK" ? "blank" : "ok   ";
        console.log(`  ${mark} ${target.label.slice(0, 30).padEnd(32)} ${outcome.status === "FAILED" ? outcome.why.slice(0, 76) : JSON.stringify(target.value).slice(0, 40)}`);
      }
      const bad = failures(reports);
      if (bad.length) {
        console.log(`\n${bad.length} field(s) did not verify. Nothing will be clicked.`);
        fillOk = false;
      } else {
        console.log(`\nall ${reports.length} field(s) written and read back correctly`);
      }
    }
  }
}

// ---- advance a page, only when this one is genuinely finished ---------
//
// Advancing is not submitting -- Workday's Review step is last, and Save
// and Continue moves between steps. But it IS employer-facing state, so
// it happens only under an explicit flag AND only when every field on
// this page is resolved. A page with a blocked field is a page with an
// unanswered question, and clicking past it would leave the employer's
// form holding a blank the system decided not to mention.
if (process.argv.includes("--advance") && fillOk) {
  const { data: open } = await db.from("application_answers")
    .select("question_text,is_required,confidence_state").eq("application_id", ID)
    .eq("confidence_state", "BLOCKED");
  if ((open ?? []).length) {
    console.log(`\nNOT advancing: ${open!.length} field(s) still blocked:`);
    for (const o of open!) console.log(`   ${o.is_required ? "*" : " "} ${o.question_text}`);
  } else {
    console.log(`\nevery recorded field is resolved; advancing one step`);
    let moved = false;
    for (const name of [/save and continue/i, /^continue$/i, /^next$/i]) {
      const b = page.getByRole("button", { name });
      if (await b.count()) {
        console.log(`  clicking "${(await b.first().innerText().catch(() => "")).trim() || String(name)}"`);
        await b.first().click({ timeout: 20_000 }).catch((e) =>
          console.log(`    click failed: ${String(e).split("\n")[0]!.slice(0, 90)}`));
        moved = true;
        break;
      }
    }
    if (!moved) console.log(`  no Save and Continue / Next control found; nothing clicked`);
    else {
      await settle();
      await page.locator('input:visible, textarea:visible, select:visible').first()
        .waitFor({ state: "visible", timeout: 25_000 }).catch(() => {});
      const next = await snapshotLive(page.mainFrame() as any).catch((e: any) => ({ error: String(e).slice(0, 140) } as any));
      console.log(`\n  after advancing: ${next.fields?.length ?? 0} field(s) on this step`);
      if (next.fields) for (const f of next.fields) console.log(`     ${f.required ? "*" : " "} ${String(f.label).slice(0, 54).padEnd(56)} ${f.htmlType}`);
      // Merge the new step in, preserving everything from step 1.
      if (next.fields?.length) {
        const { data: ex2 } = await db.from("application_answers")
          .select("id,field_key,question_text,is_required,answer_text,confidence_state,category,provenance,block_kind,blocked_reason,evidence_ids")
          .eq("application_id", ID);
        const m2 = mergeDiscovery((ex2 ?? []) as any, next.fields.map((f: any) => ({
          field_key: String(f.selector ?? f.name ?? f.label ?? ""), question_text: String(f.label ?? "unlabelled field"),
          is_required: Boolean(f.required), options: f.options ?? null,
        })));
        const t2 = summarise(m2);
        console.log(`  merge: ${t2.PRESERVED} preserved, ${t2.ADDED} added, ${t2.RECONCILE} reconcile, ${t2.RETAINED_OFFPAGE} retained`);
        for (const m of m2) {
          if (m.action === "PRESERVED" || m.action === "RETAINED_OFFPAGE") continue;
          const row: any = {
            application_id: ID, question_text: m.field.question_text, field_key: m.field.field_key,
            field_label: m.field.question_text, is_required: m.field.is_required,
            answer_text: m.field.answer_text, confidence_state: m.field.confidence_state,
            category: m.field.category ?? "E_UNKNOWN", provenance: m.field.provenance ?? "USER_RESPONSE",
            block_kind: m.field.block_kind, blocked_reason: m.field.blocked_reason,
            evidence_ids: m.field.evidence_ids ?? [],
          };
          if ((m.field as any).id) await db.from("application_answers").update(row).eq("id", (m.field as any).id);
          else await db.from("application_answers").insert(row);
        }
      }
    }
  }
}

console.log(`\nThe browser stays open so the session survives. touch ${DONE} to close it.`);
for (;;) {
  if (existsSync(DONE)) { unlinkSync(DONE); break; }
  await new Promise((r) => setTimeout(r, 3000));
}
await ctx.close();
console.log("closed.");
