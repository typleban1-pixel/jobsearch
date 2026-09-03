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
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { tenantFromToken, candidateHomeUrl } from "../lib/workday/tenant.ts";
import { observe, waitForWorkdayReady } from "../lib/workday/probe.ts";
import { snapshotLive } from "../lib/browser/liveSnapshot.ts";
import { mergeDiscovery, summarise } from "../lib/applications/fieldMerge.ts";
import { fillOne, selectRadioByLabel, type FillTarget } from "../lib/workday/fill.ts";
import { radioGroupKey, collapseRadioGroups } from "../lib/workday/radioGroups.ts";
import { resolveField, type ResolveContext, type BankedAnswer } from "../lib/applications/answer.ts";
import { chooseAdvance } from "../lib/workday/advance.ts";

const ID = process.argv[2] ?? "35eaed21-599e-4480-bc7b-192677c80f18";
const DONE = ".workday-signin-done";
const MAX_PAGES = 12;
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

// ---- the record ------------------------------------------------------
const { data: app } = await db.from("applications").select("id,job_id,status,resume_id").eq("id", ID).single();
if (!app) { console.error("no such application"); process.exit(1); }
const { data: job } = await db.from("jobs").select("id,title,company_id,source,application_form_url,remote_policy").eq("id", app.job_id).single();
const { data: co } = await db.from("companies").select("id,name,ats_token").eq("id", job!.company_id).single();
const { data: profile } = await db.from("profile").select("*").single();
const { data: employment } = await db.from("employment").select("*").order("start_date", { ascending: false });
const { data: bankRows } = await db.from("question_bank").select("*").eq("reuse_allowed", true);
const { data: jobLoc } = await db.from("job_locations").select("city,state,metro").eq("job_id", job!.id).maybeSingle();
const tenant = tenantFromToken(co!.ats_token);

const bank = new Map<string, BankedAnswer>();
for (const b of bankRows ?? []) {
  if (!b.intent_key || !b.approved_answer) continue;
  bank.set(b.intent_key, { answer: b.approved_answer, provenance: (b.answer_provenance ?? "PROFILE") as any,
    evidenceIds: b.evidence_ids ?? [], sensitive: Boolean(b.sensitive) } as BankedAnswer);
}
const ctx: ResolveContext = {
  profileRowId: profile!.id, profile: profile as Record<string, any>,
  employment: (employment ?? []) as any, bank,
  application: { provider: job!.source, employer: co?.name ?? null, jobId: job!.id,
    conditions: { locationCity: jobLoc?.city ?? null, locationState: jobLoc?.state ?? null,
      locationMetro: jobLoc?.metro ?? null, remotePolicy: job!.remote_policy ?? null } },
};

console.log(`${co!.name} — ${job!.title}`);
console.log(`  application ${ID.slice(0, 8)}  ${app.status}`);
console.log(`  tenant ${tenant.host}/${tenant.site}\n`);

// ---- open, and wait for a person to sign in --------------------------
const browser = await launchApplicationContext();
const page = await browser.newPage();
page.setDefaultTimeout(60_000);
await page.goto(candidateHomeUrl(tenant), { waitUntil: "domcontentloaded" });
await waitForWorkdayReady(page, 30_000);

console.log("This window is the automated profile (.browser-profile). SIGN IN HERE.");
console.log("Nothing is typed for you and no consent control is touched.");
console.log(`Waiting for an authenticated session... (touch ${DONE} to abandon)\n`);

let signedIn = false;
for (let i = 0; i < 2400; i++) {                    // up to ~2 hours
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
  const heading = t('[data-automation-id="jobApplicationHeader"]') || t("h1") || t("h2");
  const prog = [...document.querySelectorAll('[data-automation-id="progressBar"] *, [role="navigation"] li')]
    .map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean).slice(0, 12);
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
    if (vis(q('[data-automation-id="jobSearchPage"]')) || vis(q('[data-automation-id="jobSearch"]'))) return false;
    return vis(q('[data-automation-id="progressBar"]'))
      || vis(q('[data-automation-id="jobApplicationHeader"]'))
      || /\/job\/|apply|application/i.test(location.pathname);
  });
}

/** Finds the in-progress application and opens it. */
async function openApplication(): Promise<boolean> {
  if (await onApplicationPage()) return true;
  const base = candidateHomeUrl(tenant).replace(/\/$/, "");
  for (const url of [`${base}/candidatehome`, job!.application_form_url ?? "", base]) {
    if (!url) continue;
    console.log(`  looking at ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await waitForWorkdayReady(page, 30_000).catch(() => undefined);
    await page.waitForTimeout(1500);
    if (await onApplicationPage()) { console.log("  application page reached"); return true; }

    // Candidate home lists tasks. Take the one naming this posting, or a
    // plain Continue; never guess between several.
    const links = await page.evaluate(() =>
      [...document.querySelectorAll('a, button, [role="button"], [role="link"]')]
        .filter((e) => e.getClientRects().length > 0)
        .map((e) => ((e as HTMLElement).innerText || e.getAttribute("aria-label") || "").trim())
        .filter(Boolean));
    console.log(`  controls here: ${links.slice(0, 18).join(" | ").slice(0, 300)}`);
    const title = String(job!.title ?? "");
    const wanted = links.filter((l) => l === title || /continue application|continue|resume application/i.test(l));
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
  // Radio options collapse to one row keyed by their shared name; every
  // other control keeps its own selector. htmlType is carried across
  // because the resolver needs to know a dropdown from a text box.
  const typeBySelector = new Map<string, string>(
    (raw.fields ?? []).map((f: any) => [String(f.selector ?? f.key ?? ""), String(f.htmlType ?? "text")]));
  const live = collapseRadioGroups((raw.fields ?? []).map((f: any) => ({
    label: String(f.label ?? ""), htmlType: String(f.htmlType ?? "text"), name: f.name ?? null,
    selector: String(f.selector ?? f.key ?? ""), required: Boolean(f.required), value: null,
  }))).map((r: any) => ({ ...r, htmlType: typeBySelector.get(r.key) ?? "text" }));
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
    const row: any = { application_id: ID, question_text: m.field.question_text, field_key: m.field.field_key,
      field_label: m.field.question_text, is_required: m.field.is_required, answer_text: m.field.answer_text,
      confidence_state: m.field.confidence_state, category: m.field.category ?? "E_UNKNOWN",
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
    if (r.confidence_state === "HUMAN_CONFIRMED") continue;
    const match = live.find((f: any) => String(f.key) === r.field_key);
    if (!match) continue;
    const res: any = resolveField({ key: r.field_key, label: r.question_text, required: Boolean(r.is_required),
      type: match.htmlType, options: match.options ?? [] } as any, ctx);
    if (!res || res.refused) continue;
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
  for (const a of here as any[]) {
    if (!a.answer_text || a.confidence_state === "BLOCKED") continue;
    const target: FillTarget = { selector: a.field_key, label: a.question_text, value: a.answer_text,
      confidence: a.confidence_state, required: Boolean(a.is_required) };
    const out = a.field_key.startsWith("radio-group:")
      ? await selectRadioByLabel(page, radioGroupKey(a.field_key), a.answer_text)
      : await fillOne(page, target);
    if (out.status === "FAILED") { failed++; console.log(`   FAIL ${a.question_text}: ${out.why}`); }
    else { filled++; console.log(`   ok   ${String(a.question_text).slice(0, 40).padEnd(42)} ${JSON.stringify((out as any).readBack ?? "")}`); }
  }
  console.log(`filled ${filled}, failed ${failed}`);

  const blocked = (here as any[]).filter((a) => a.is_required && (!a.answer_text || a.confidence_state === "BLOCKED"));
  if (blocked.length) {
    console.log(`\nSTOPPING: ${blocked.length} required question(s) this system will not answer for you:`);
    for (const b of blocked) console.log(`   - ${b.question_text}`);
    break;
  }
  if (failed) { console.log("\nSTOPPING: a control did not accept its value; not advancing on a partial page."); break; }

  const next = await advance();
  if (!next) { console.log("\nno Continue control advanced the page; stopping here."); break; }
  console.log(`advanced to: ${next}`);
}

console.log(`\nThe browser stays open so the session survives. touch ${DONE} to close it.`);
for (;;) {
  if (existsSync(DONE)) { unlinkSync(DONE); break; }
  await new Promise((r) => setTimeout(r, 3000));
}
await browser.close();
console.log("closed.");
