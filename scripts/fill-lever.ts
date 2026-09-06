/**
 * Fills one approved Lever application and hands it back to a person.
 *
 *   node scripts/fill-lever.ts <application_id> [--stay-open]
 *
 * The Lever counterpart to fill-application.ts, deliberately a separate
 * script: the Greenhouse adapter is frozen and nothing here may reach
 * into it. What IS shared is everything after the fill, because a stop
 * has to look the same to the operator whichever board produced it. Same
 * application_fill_runs row, same screenshot directory, same audit
 * events, same handoff inbox.
 *
 * There is no flag that submits. The submit control is resolved, checked
 * and reported so that a person knows it was found, and then left alone.
 */
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { required } from "../lib/env.ts";
import { fillLeverApplication, leverSubmitControl, type LeverAnswer } from "../lib/browser/leverFill.ts";
import { approvedArtifact } from "../lib/render/artifact.ts";
import { SubmitGuard } from "../lib/browser/submitGuard.ts";
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { startFillRun, recordFillRun } from "../lib/applications/fillRun.ts";
import { FILL_OUTCOMES, type FillOutcomeName } from "../lib/browser/stopReasons.ts";
import { watchForHumanSubmit, readLeverSnapshot } from "../lib/browser/leverConfirm.ts";

const applicationId = process.argv[2];
// --finish keeps the window open AFTER the fill, disarms the automated submit
// guard so the PERSON can submit, and then reconciles the outcome from the
// page's own confirmation state (never a retry, never an automated click).
const finish = process.argv.includes("--finish");
const stayOpen = process.argv.includes("--stay-open") || finish;
if (!applicationId) { console.error("usage: fill-lever.ts <application_id> [--stay-open] [--finish]"); process.exit(2); }

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const paged = async <T,>(t: string, c: string, f: (q: any) => any = (q) => q): Promise<T[]> => {
  const o: T[] = [];
  for (let x = 0; ; x += 500) {
    const { data, error } = await f(db.from(t).select(c)).order("id").range(x, x + 499);
    if (error) throw new Error(`${t}: ${error.message}`);
    o.push(...((data ?? []) as T[])); if ((data ?? []).length < 500) break;
  }
  return o;
};

const { data: app } = await db.from("applications")
  .select("id,job_id,status,human_approved,authorization_mode,all_fields_confident,form_snapshot,form_snapshot_hash,resume_id,approved_artifact_sha256,submitted_at,submit_click_attempted_at")
  .eq("id", applicationId).single();
if (!app) { console.error("no such application"); process.exit(1); }
if (app.submitted_at) { console.error(`already submitted at ${app.submitted_at}; nothing further attempted.`); process.exit(1); }
// Exactly-once for the assisted path: a prior --finish that saw a click but
// could not prove receipt leaves submit_click_attempted_at set. Do not fill or
// re-open: the outcome is uncertain and must be resolved in the portal (which
// asks whether the employer received it) before anything is attempted again.
if (app.submit_click_attempted_at) {
  console.error(`a submit was already attempted at ${app.submit_click_attempted_at} and receipt was never confirmed. `
    + `Resolve it in the portal (confirm received / not received) before running this again.`);
  process.exit(1);
}

const { data: job } = await db.from("jobs").select("id,title,source,apply_url,company_id").eq("id", app.job_id).single();
if (job!.source !== "LEVER") { console.error(`this is a ${job!.source} application`); process.exit(1); }
const { data: company } = await db.from("companies").select("name").eq("id", job!.company_id).single();

const snapshot = app.form_snapshot as any;
const approvedShape = snapshot?.lever?.shape ?? app.form_snapshot_hash ?? "";
if (!approvedShape) { console.error("this application has no approved Lever snapshot to compare against"); process.exit(1); }

// The exact approved artifact, or nothing.
const artifact = await approvedArtifact(db, applicationId);
if (!artifact.ok) { console.error(`cannot fill: ${artifact.why}`); process.exit(1); }
if (app.approved_artifact_sha256 && artifact.sha256 !== app.approved_artifact_sha256) {
  console.error(`the stored artifact ${artifact.sha256} is not the approved ${app.approved_artifact_sha256}`);
  process.exit(1);
}

const answers: LeverAnswer[] = (await paged<any>("application_answers",
  "field_key,field_label,answer_text,confidence_state,is_required",
  (q) => q.eq("application_id", applicationId))).map((a) => ({
    fieldKey: a.field_key, fieldLabel: a.field_label, answer: a.answer_text,
    isRequired: a.is_required, confidence: a.confidence_state,
  }));

const runDir = join(".fill-runs", `lever-${applicationId}-${Date.now()}`);
await mkdir(runDir, { recursive: true });
const { data: profile } = await db.from("profile")
  .select("legal_first_name,legal_last_name,preferred_name,city,state").single();
const resumePath = join(runDir, `${profile!.preferred_name ?? profile!.legal_first_name} ${profile!.legal_last_name} - Resume.pdf`);
await writeFile(resumePath, artifact.pdf);

// The office the operator reviewed for THIS application, if the posting
// offered a choice. Stored as an ordinary answer, so it is
// application-specific by construction and never becomes a preference.
const reviewedOffice = answers.find((a) =>
  a.fieldKey === "opportunityLocationId" || a.fieldKey === "opportunityLocationIds")?.answer ?? undefined;
const reviewedLocation = profile!.city && profile!.state
  ? `${profile!.city}, ${profile!.state}, US` : null;

console.log(`${company?.name} — ${job!.title}`);
console.log(`  approved artifact ${artifact.sha256.slice(0, 12)} (${artifact.pdf.length} bytes)`);
console.log(`  form ${job!.apply_url}`);
console.log(`  reviewed office: ${reviewedOffice ?? "none needed"}\n`);

const run = startFillRun({
  applicationId, provider: "LEVER", runDir,
  fillMode: "AUTOMATED", formSnapshotHash: app.form_snapshot_hash,
});
const startedMs = Date.now();
const context = await launchApplicationContext();

let outcome: any = null;
let filledPage: import("playwright").Page | null = null;
let guardReport: unknown = {};
let stopReason: FillOutcomeName = "BROWSER_ERROR";
let stopDetail = "";
let submitFound: string | null = null;
// Installed before any page script runs, and never disarmed here: this
// script has no submit path, so the guard stays armed for the whole run.
let guard: Awaited<ReturnType<typeof SubmitGuard.install>> | null = null;

try {
  guard = await SubmitGuard.install(context);
  const page = context.pages()[0] ?? await context.newPage();
  filledPage = page;
  await page.goto(job!.apply_url!, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(runDir, "01-loaded.png"), fullPage: true }).catch(() => undefined);

  // Privacy first, and it also removes two buttons that would otherwise
  // sit outside the form looking clickable.
  await page.locator("#onetrust-reject-all-handler, button:has-text('Deny')").first()
    .click({ timeout: 4000 }).catch(() => undefined);

  outcome = await fillLeverApplication({
    page, answers, resumePath, approvedShape, reviewedLocation, preferOffice: reviewedOffice,
  });
  stopReason = outcome.reason;
  stopDetail = outcome.message;
  await page.screenshot({ path: join(runDir, "03-filled.png"), fullPage: true }).catch(() => undefined);

  // Resolved and reported, never touched.
  try {
    const btn = await leverSubmitControl(page);
    submitFound = (await btn.innerText()).trim() || "(unlabelled)";
  } catch (e) { submitFound = `NOT RESOLVED: ${(e as Error).message.slice(0, 120)}`; }

  if (finish && stopReason === "HANDOFF") {
    // The fill reached a clean, filled form. Hand the submit guard off so the
    // PERSON can complete Lever's hCaptcha and click Submit; this process
    // never clicks it. Then watch the form's own state for a proven receipt.
    await guard!.handoff(page);
    console.log("\n" + "=".repeat(64));
    console.log("Application prepared. Solve the Lever check, review, and submit.");
    console.log("This window will remain open so confirmation can be detected.");
    console.log("Nothing is submitted by this process; only you can submit.");
    console.log("=".repeat(64) + "\n");
    const before = await readLeverSnapshot(page);
    const { verdict, after } = await watchForHumanSubmit(page, before, { timeoutMs: 30 * 60_000, pollMs: 2500 });
    await page.screenshot({ path: join(runDir, "12-confirmation.png"), fullPage: true }).catch(() => undefined);
    const evidenceReference = `fill-run:${runDir.split("/").pop()}`;
    const nowIso = new Date().toISOString();
    if (verdict.outcome === "CONFIRMED") {
      await db.from("applications").update({
        status: "SUBMITTED", submitted_at: nowIso, submit_click_attempted_at: nowIso,
        confirmation_reference: evidenceReference, submission_mode: "MANUAL",
        submit_outcome: "CONFIRMED", submit_outcome_at: nowIso,
      }).eq("id", applicationId).is("submitted_at", null);
      await db.from("application_events").insert({ application_id: applicationId, event: "SUBMITTED",
        actor: "assisted-lever", detail: `Lever confirmed receipt (${verdict.reason}). Evidence ${evidenceReference}. ${after?.url ?? ""}` });
      console.log(`\n✅ Lever confirmed receipt. Application recorded as submitted. Evidence: ${runDir}`);
    } else if (verdict.outcome === "AMBIGUOUS") {
      await db.from("applications").update({
        submit_click_attempted_at: nowIso, submit_outcome: "AMBIGUOUS", submit_outcome_at: nowIso,
      }).eq("id", applicationId);
      await db.from("application_events").insert({ application_id: applicationId, event: "SUBMISSION_UNCERTAIN",
        actor: "assisted-lever", detail: `${verdict.reason}. Evidence ${evidenceReference}. Not retried; awaiting your confirmation in the portal.` });
      console.log(`\n⚠️  Submission could not be confirmed (${verdict.reason}). Do not retry yet. `
        + `Check the portal: it will ask whether Lever received it. Evidence: ${runDir}`);
    } else {
      console.log(`\nNo submission detected (${verdict.reason}). The application is still prepared; nothing was recorded.`);
    }
    stopDetail = `${stopDetail} | assisted-finish: ${verdict.outcome} (${verdict.reason})`;
  } else if (stayOpen) {
    console.log("\nthe form is open. Nothing will be submitted by this process.");
    await page.waitForTimeout(15 * 60_000);
  }
} catch (err) {
  const e = err as any;
  stopReason = (FILL_OUTCOMES as readonly string[]).includes(String(e?.reason))
    ? (e.reason as FillOutcomeName) : "BROWSER_ERROR";
  stopDetail = e?.message ?? String(err);
  console.error(`\nstopped: ${stopReason}: ${stopDetail}`);
} finally {
  // Recorded whatever happened. A stop nobody can see becomes a stalled
  // application, which is the defect this closed for Greenhouse.
  // Read before the context closes, and never allowed to mask the real
  // stop: a guard report that cannot be read is an empty one.
  if (guard && filledPage) {
    guardReport = await guard.report(filledPage).catch(() => ({}));
  }
  // One writer, in lib/applications/fillRun.ts: the row, run.json and
  // the audit event all come from the same record, so they cannot
  // describe different runs.
  const { warnings } = await recordFillRun(db, { ...run, formSnapshotHash: outcome?.snapshotHashAtFill ?? run.formSnapshotHash }, {
    outcome: stopReason,
    detail: stopDetail,
    filled: outcome?.filled ?? [],
    leftBlank: outcome?.leftBlank ?? [],
    parserReconciliation: outcome?.parserReconciliation ?? [],
    guardReport,
    artifact: { resumeId: app.resume_id!, sha256: artifact.sha256, path: resumePath },
    // Nothing in this script can click submit.
    submitClickAttempted: false,
    extra: { ...outcome, submitFound },
  });
  for (const w of warnings) console.log(`  (${w})`);

  console.log(`\n${stopReason}: ${stopDetail}`);
  if (outcome) {
    console.log(`\nfilled ${outcome.filled.length}:`);
    for (const f of outcome.filled) console.log(`  ${f.field}: ${String(f.value).slice(0, 60)}`);
    if (outcome.parserReconciliation.length) {
      console.log(`\nwhat Lever's resume parser did:`);
      for (const p of outcome.parserReconciliation) {
        console.log(`  ${p.field}: ${p.action}  parsed=${JSON.stringify(String(p.parsed).slice(0, 34))} prepared=${JSON.stringify(String(p.prepared ?? "").slice(0, 34))}`);
      }
    }
    if (outcome.handoffs.length) {
      console.log(`\nneeds you (${outcome.handoffs.length}):`);
      for (const h of outcome.handoffs) console.log(`  ${h.field}: ${h.why}`);
    }
    if (outcome.leftBlank.length) {
      console.log(`\nleft blank (${outcome.leftBlank.length}):`);
      for (const b of outcome.leftBlank.slice(0, 8)) console.log(`  ${b.field}: ${b.why}`);
    }
    console.log(`\noffice: ${outcome.office ?? "single location"}`);
  }
  console.log(`submit control: ${submitFound}`);
  console.log(`guards: ${JSON.stringify(guardReport)}`);
  console.log(`evidence: ${runDir}`);
  await context.close().catch(() => undefined);
}
