/**
 * Fills one prepared application in a real browser, and stops.
 *
 *   node scripts/fill-application.ts <application_id>
 *   node scripts/fill-application.ts <application_id> --validate
 *
 * Runs headed, in a persistent Chrome profile you sign into yourself. No
 * credential is read or stored by this script; the session lives in the
 * profile directory on disk.
 *
 * There is no flag that submits. The filler has no code path that could.
 *
 * --validate exercises the whole path against an application that has
 * not been through the review queue, which is how the Greenhouse path
 * was first proven. It changes nothing about what is filled: BLOCKED
 * fields are still never filled, and a blocked REQUIRED field still
 * stops the run.
 */
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { required } from "../lib/env.ts";
import { fillApplication, type PreparedAnswer } from "../lib/browser/fill.ts";
import { loadContext, applicationScope } from "../lib/applications/prepare.ts";
import { approvedArtifact, loadArtifact } from "../lib/render/artifact.ts";
import { createHash } from "node:crypto";
import { isFailure } from "../lib/browser/stopReasons.ts";
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { pickResultPageIndex } from "../lib/browser/resultPage.ts";
import { startFillRun, recordFillRun, type UploadedArtifact } from "../lib/applications/fillRun.ts";
import { resolveFormUrl } from "../lib/applications/formUrl.ts";

const applicationId = process.argv[2];
const validate = process.argv.includes("--validate");
if (!applicationId) {
  console.error("usage: node scripts/fill-application.ts <application_id> [--validate]");
  process.exit(2);
}

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const paged = async (t: string, c: string, f: (q: any) => any = (q) => q, o = "id") => {
  const out: any[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await f(db.from(t).select(c)).order(o).range(from, from + 499);
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...data);
    if (data.length < 500) break;
  }
  return out;
};

// ---- the application, and whether it may be filled --------------------
const { data: app, error } = await db.from("applications")
  .select("id,job_id,job_version_id,status,human_approved,all_fields_confident,form_snapshot,form_snapshot_hash,resume_id,is_test")
  .eq("id", applicationId).single();
if (error || !app) { console.error(`no such application: ${error?.message}`); process.exit(1); }

if (validate && !process.argv.includes("--again")) {
  // One rehearsal per form. Every rehearsal uploads the resume and leaves a
  // draft on the employer's side under the applicant's email; Aleph's form
  // had seen seventeen such visits when Ashby flagged the real submission
  // as spam. A second rehearsal within a day has to be asked for.
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { data: recent } = await db.from("application_fill_runs").select("started_at,outcome")
    .eq("application_id", applicationId).gte("started_at", since).order("started_at", { ascending: false }).limit(1);
  if (recent?.length) {
    console.error(`this form was already exercised at ${recent[0]!.started_at} (${recent[0]!.outcome}).`);
    console.error("Each visit uploads the resume and leaves a draft with the employer; repeated visits read as spam.");
    console.error("Pass --again if a second rehearsal today is really needed.");
    process.exit(1);
  }
}

if (!validate) {
  // Filling an unreviewed package would put unread answers into an
  // employer's form. Approval is the gate for that, not just for
  // submission.
  if (app.status !== "READY_TO_SUBMIT" || !app.human_approved) {
    console.error(`this application is ${app.status}, human_approved=${app.human_approved}.`);
    console.error("Approve it in the portal first, or pass --validate to exercise the path without approving.");
    process.exit(1);
  }
}

const { data: job } = await db.from("jobs")
  .select("id,title,source,apply_url,url,application_form_url,application_form_url_verified_at,company_id")
  .eq("id", app.job_id).single();
const { data: company } = await db.from("companies").select("name").eq("id", job!.company_id).single();
// ---- where the form actually is --------------------------------------
//
// apply_url is the employer's canonical link and for a custom-branded
// board it is a job description, not a form. Opening it put the adapter
// on stripe.com with an "Apply for this role" button and no fields.
// application_form_url is the verified board route; when it is missing
// this refuses, because the alternative is hunting for an Apply link on
// an employer page and hoping it leads to the right requisition.
// Ashby publishes no separate verified form route: the form is revealed on
// the posting page itself, so its own posting URL is the form URL.
const formUrl: string | null = resolveFormUrl(job!);
if (!formUrl) {
  if (job!.source === "GREENHOUSE") {
    console.error(`no verified application form url for this job.`);
    console.error(`  apply_url is ${job!.apply_url}, which is the employer's page rather than a form.`);
    console.error(`  Run scripts/backfill-form-urls.ts --commit to resolve it, then try again.`);
    process.exit(1);
  }
  console.error(`no application form url for this ${job!.source} job, and no adapter to derive one.`);
  process.exit(1);
}
console.log(`  form url: ${formUrl}`);
console.log(`  verified: ${job!.application_form_url_verified_at ?? "never"}`);

const { data: version } = await db.from("job_versions")
  .select("id,is_current").eq("id", app.job_version_id).single();

if (!version?.is_current) {
  console.error("the employer has published a newer version of this posting since it was reviewed.");
  console.error("Re-prepare it rather than applying against text nobody read.");
  process.exit(1);
}

// ---- the answers ------------------------------------------------------
const answers: PreparedAnswer[] = (await paged("application_answers",
  "field_key,field_label,answer_text,confidence_state,is_required",
  (q) => q.eq("application_id", applicationId))).map((a) => ({
    fieldKey: a.field_key, fieldLabel: a.field_label,
    answer: a.answer_text, confidence: a.confidence_state, isRequired: a.is_required,
  }));

// ---- the resume, as a file -------------------------------------------
const runDir = join(".fill-runs", `${applicationId}-${Date.now()}`);
await mkdir(runDir, { recursive: true });

const { data: master } = await db.from("resumes").select("id,label").eq("is_master", true).single();
const profileVersion = Number(String(master?.label ?? "").match(/profile version (\d+)/)?.[1] ?? 0);
const frozen = await paged("profile_version_rows", "row_id,source_table,row_data",
  (q) => q.eq("profile_version", profileVersion), "row_id");
const { data: profile } = await db.from("profile").select("legal_first_name,legal_last_name,preferred_name").single();

// ---- the resume: the artifact that was approved, and only that ------
//
// Nothing is rendered here. The document a person read and approved is
// the document that goes to the employer, and if the stored bytes no
// longer hash to the approved value this stops rather than producing a
// fresh one.
const artifact = await approvedArtifact(db, applicationId);
let resumePdfPath: string | null = null;
// What is actually handed to the employer's file input, recorded with
// the run. Set only where bytes were written; never inferred from
// app.resume_id, because holding a resume is not uploading one.
let uploaded: UploadedArtifact | null = null;
if (artifact.ok) {
  resumePdfPath = join(runDir, `${profile!.preferred_name ?? profile!.legal_first_name} ${profile!.legal_last_name} - Resume.pdf`);
  await writeFile(resumePdfPath, artifact.pdf);
  uploaded = { resumeId: app.resume_id!, sha256: artifact.sha256, path: resumePdfPath };
  console.log(`  approved resume artifact ${artifact.sha256.slice(0, 12)} (${artifact.pdf.length} bytes)`);
} else if (!validate) {
  console.error(`cannot fill: ${artifact.why}`);
  process.exit(1);
} else {
  // Validation needs the upload leg exercised, and an unapproved
  // application has no approved artifact by definition. So the STORED
  // bytes are used, verified against the hash recorded on the resume row
  // before anything touches a file input.
  //
  // This is not a way around approval. approvedArtifact stays the only
  // path for a real fill, submission remains impossible in this script,
  // and nothing here sets human_approved or approved_artifact_sha256.
  // What it buys is the one thing validation cannot otherwise test:
  // whether the exact bytes we hold survive the employer's upload
  // control.
  const stored = await loadArtifact(db, app.resume_id!);
  if (!stored) {
    console.log(`  no approved artifact (${artifact.why}) and no stored PDF; running without a resume upload`);
  } else {
    const actual = createHash("sha256").update(stored.pdf).digest("hex");
    if (actual !== stored.sha256) {
      console.error(`  the stored PDF does not hash to its recorded value (${actual} vs ${stored.sha256}).`);
      console.error("  refusing to upload bytes that are not what the record says they are.");
      process.exit(1);
    }
    resumePdfPath = join(runDir, `${profile!.preferred_name ?? profile!.legal_first_name} ${profile!.legal_last_name} - Resume.pdf`);
    await writeFile(resumePdfPath, stored.pdf);
    uploaded = { resumeId: app.resume_id!, sha256: actual, path: resumePdfPath };
    console.log(`  VALIDATE: no approved artifact (${artifact.why})`);
    console.log(`  VALIDATE: uploading the stored artifact ${actual.slice(0, 12)} (${stored.pdf.length} bytes), hash verified`);
  }
}

// ---- the browser ------------------------------------------------------
console.log(`${company?.name} — ${job!.title}  [${job!.source}]`);
console.log(`  ${answers.filter((a) => a.confidence !== "BLOCKED").length} answers available, ${answers.filter((a) => a.confidence === "BLOCKED").length} blocked`);
console.log(`  run directory: ${runDir}\n`);

const context = await launchApplicationContext();

const resolveContext = await loadContext(db);
// Where this posting is, so a previously confirmed answer can be reused
// only where the conditions it was given under actually hold.
resolveContext.application = await applicationScope(db, job!.id).catch(() => undefined);

// ---- the repeatable education section --------------------------------
//
// Verified, completed records only, most recent first, so the rows land
// in the order a reader expects. The degree vocabulary comes from the
// board rather than from us: a degree we cannot name in its terms is a
// row we do not add.
const { data: co2 } = await db.from("companies").select("ats_token").eq("id", job!.company_id).maybeSingle();
const boardTokenForFill: string | null = co2?.ats_token ?? null;

const DEGREE_LEVEL: Array<[RegExp, string]> = [
  [/\bassociate/i, "Associate's Degree"],
  [/\bbachelor|^b\.?[as]\b/i, "Bachelor's Degree"],
  [/\bm\.?b\.?a\b/i, "Master of Business Administration (M.B.A.)"],
  [/\bmaster/i, "Master's Degree"],
  [/\bph\.?d|doctor of philosophy/i, "Doctor of Philosophy (Ph.D.)"],
  [/\bj\.?d\b|juris doctor/i, "Juris Doctor (J.D.)"],
  [/\bm\.?d\b|doctor of medicine/i, "Doctor of Medicine (M.D.)"],
  [/high school|diploma/i, "High School"],
];
const educationRecords = (await paged("education", "institution,credential,field_of_study,status,completed,end_month"))
  .filter((e: any) => e.status === "VERIFIED" && e.completed && e.institution && e.credential)
  .sort((a: any, b: any) => String(b.end_month ?? "").localeCompare(String(a.end_month ?? "")))
  .map((e: any) => ({
    institution: String(e.institution),
    // The board names degree LEVELS. "Bachelor of Science" is a
    // bachelor's degree in its vocabulary; anything this table cannot
    // place is passed through unchanged and will fail the exact-option
    // check rather than being approximated.
    degree: DEGREE_LEVEL.find(([re]) => re.test(String(e.credential)))?.[1] ?? String(e.credential),
  }));

let degreeOptions: string[] = [];
if (job!.source === "GREENHOUSE" && boardTokenForFill) {
  degreeOptions = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardTokenForFill)}/education/degrees`)
    .then((r) => (r.ok ? r.json() : { items: [] }))
    .then((b: any) => (b.items ?? []).map((i: any) => String(i.text)))
    .catch(() => []);
}
console.log(`  education records: ${educationRecords.map((e) => `${e.institution} / ${e.degree}`).join(" | ") || "none"}`);

const run = startFillRun({
  applicationId, provider: job!.source, runDir,
  fillMode: "AUTOMATED", formSnapshotHash: app.form_snapshot_hash,
});
const outcome = await fillApplication({
  db, context, applicationId,
  provider: job!.source,
  applyUrl: formUrl,
  storedHash: app.form_snapshot_hash,
  storedFields: (app.form_snapshot as any)?.fields ?? [],
  answers, resumePdfPath, runDir,
  resolveContext,
  boardToken: boardTokenForFill,
  educationRecords,
  degreeOptions,
});

// ---- the record -------------------------------------------------------
//
// One writer, in lib/applications/fillRun.ts. The run directory is the
// durable artifact and is always written; the table and the audit event
// are written when they can be.
const { warnings } = await recordFillRun(db, run, {
  outcome: outcome.reason,
  detail: outcome.message,
  filled: outcome.filled,
  leftBlank: outcome.leftBlank,
  parserReconciliation: outcome.parserReconciliation,
  guardReport: outcome.guard,
  artifact: uploaded,
  // This script has no code path that clicks submit.
  submitClickAttempted: false,
  extra: outcome as unknown as Record<string, unknown>,
});
for (const w of warnings) console.log(`  (${w})`);

// ---- what happened ----------------------------------------------------
console.log(`\n${outcome.reason}: ${outcome.message}`);
console.log(`\nfilled ${outcome.filled.length}:`);
for (const f of outcome.filled) console.log(`  ${f.field}: ${String(f.value).slice(0, 70)}`);
if (outcome.leftBlank.length) {
  console.log(`\nleft blank ${outcome.leftBlank.length}:`);
  for (const f of outcome.leftBlank.slice(0, 20)) console.log(`  ${f.field}: ${f.why}`);
}
if (outcome.parserReconciliation.length) {
  console.log(`\nwhat the ATS parser did (${outcome.parserReconciliation.length}):`);
  for (const r of outcome.parserReconciliation) {
    console.log(`  ${r.field}: parsed ${JSON.stringify(String(r.parsed).slice(0, 40))} -> ${r.action}`);
  }
}
const guard = outcome.guard as any;
const guardHits = (guard?.submitAttempts?.length ?? 0) + (guard?.programmatic?.length ?? 0) + (guard?.blockedRequests?.length ?? 0);
console.log(`\nsubmission guards: ${guardHits === 0 ? "nothing attempted" : `${guardHits} ATTEMPT(S) BLOCKED`}`);
console.log(`screenshots: ${outcome.screenshots.length} in ${runDir}`);

if (outcome.reason === "HANDOFF") {
  console.log("\nThe browser is open on the completed form. Read it, then submit it yourself.");
  console.log("When you have, mark it submitted in the portal.");
} else {
  console.log("\nStopped. The browser is open where it stopped; nothing was submitted.");
}

// Holding the browser open actually requires staying alive.
//
// This script has always said the browser is left open, and it was not:
// Playwright ends the browser with the process that launched it, so the
// filled form vanished the moment this exited and there was nothing for
// a person to submit. --stay-open keeps the process parked so the window
// survives for however long the review takes.
//
// It adds no capability. Nothing is clicked here, SubmitGuard is
// untouched, and the only way out is closing the browser or stopping
// this process.
if (process.argv.includes("--stay-open")) {
  // Watch the page rather than assert it is fine.
  //
  // The filled form used to vanish at handoff and the reason was a
  // page.reload in the guard's teardown. It is gone, and this is how
  // that stays true: every navigation and lifecycle event is reported,
  // and the fields are counted on a timer so a silent re-render shows up
  // as a number rather than as a surprise later.
  // The page holding the form, not the blank one launchPersistentContext
  // opens first. Watching pages()[0] measured about:blank and reported a
  // form that survived perfectly while telling us nothing.
  const wpages = context.pages();
  const watched = wpages[pickResultPageIndex(wpages.map((p) => p.url()), formUrl)] ?? wpages[wpages.length - 1]!;
  let navigations = 0;
  watched.on("framenavigated", (f) => {
    if (f === watched.mainFrame()) { navigations++; console.log(`  [nav] main frame -> ${f.url().slice(0, 80)}`); }
  });
  watched.on("load", () => console.log("  [nav] load event on the top document"));
  watched.on("domcontentloaded", () => console.log("  [nav] domcontentloaded on the top document"));

  const census = async () => watched.evaluate(() => {
    const inputs = [...document.querySelectorAll("input,textarea")] as HTMLInputElement[];
    const filled = inputs.filter((i) => i.type !== "file" && i.type !== "hidden" && (i.value ?? "").trim() !== "");
    return { url: location.href.slice(0, 70), filled: filled.length, controls: inputs.length,
             sample: filled.slice(0, 3).map((i) => `${i.id || i.name}=${i.value.slice(0, 18)}`) };
  }).catch((e) => ({ url: "unreadable", filled: -1, controls: -1, sample: [String(e).slice(0, 60)] }));

  const first = await census();
  console.log(`\n  [t=0s]  ${first.filled}/${first.controls} controls hold a value  ${first.url}`);
  console.log(`          ${first.sample.join("  ")}`);

  for (const t of [15, 30, 45, 60]) {
    await new Promise((r) => setTimeout(r, 15_000));
    const c = await census();
    const verdict = c.filled === first.filled ? "unchanged" : `CHANGED from ${first.filled}`;
    console.log(`  [t=${t}s] ${c.filled}/${c.controls} hold a value, ${verdict}, ${navigations} navigation(s)  ${c.url}`);
  }
  console.log(navigations === 0
    ? "\n  the form survived 60s with no navigation and no reset."
    : `\n  ${navigations} NAVIGATION(S) OCCURRED; the filled state was not preserved.`);

  console.log("\nHolding the browser open. Close the window, or stop this process, when you are done.");
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
  console.log("released.");
}
process.exit(isFailure(outcome.reason) ? 1 : 0);
