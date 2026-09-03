/**
 * Submits one approved application, and proves it landed.
 *
 *   node scripts/submit-application.ts <application_id>
 *
 * This is the only file in the system that clicks a submit control, and
 * it exists because the user asked for it three times, the last time
 * naming exactly what it would cost. fill-application.ts still has no
 * code path that submits, and SubmitGuard is unchanged: what this uses
 * is the release the guard ALREADY performs at HANDOFF, when the page is
 * handed to a person. Nothing is disarmed beyond that.
 *
 * The click is the least important part. A click is not a submission and
 * a 200 is not a confirmation: forms re-render with validation errors,
 * boards warn about duplicates, sessions expire into login walls, and
 * every one of those returns a perfectly healthy page. So the page after
 * the click has to say, in its own words, that the application was
 * received, and it has to say nothing that contradicts that, before
 * anything is written down.
 *
 * A CAPTCHA is a full stop. This does not solve them and does not try.
 */
import { createClient } from "@supabase/supabase-js";
import { chromium, type Page } from "playwright";
import { basename, join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { required } from "../lib/env.ts";
import { fillApplication, type PreparedAnswer } from "../lib/browser/fill.ts";
import { asksForCode } from "../lib/gmail/verification.ts";
import { guardScreenshot, type GmailDeps } from "../lib/gmail/otp.ts";
import { searchIds, getMessage, APPLICATION_SENDERS } from "../lib/gmail/client.ts";
import {
  resolveVerificationStep, readPageContext, type VerificationOutcome,
} from "../lib/applications/verificationStep.ts";
import { loadContext, applicationScope } from "../lib/applications/prepare.ts";
import { approvedArtifact } from "../lib/render/artifact.ts";

import { revalidateBeforeSubmit } from "../lib/applications/revalidate.ts";
import { answerSetHash } from "../lib/applications/approvalBinding.ts";
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { startFillRun, recordFillRun } from "../lib/applications/fillRun.ts";
import { formatStopDetail, fillStopCode, STOP_EVENT, type StopCode, type StopStage, type StopRecord }
  from "../lib/applications/stopReason.ts";

const applicationId = process.argv[2];
const hold = process.argv.includes("--hold");
if (!applicationId) { console.error("usage: submit-application.ts <application_id>"); process.exit(2); }

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const paged = async (t: string, c: string, f: (q: any) => any = (q) => q, o = "id") => {
  const out: any[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await f(db.from(t).select(c)).order(o).range(from, from + 499);
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...data); if (data.length < 500) break;
  }
  return out;
};

/**
 * Record why this run is stopping, then stop.
 *
 * Every non-submitting exit below goes through here. The listener used to
 * be the only thing that wrote an outcome, and it only ever knew "no click
 * happened" — the stage, the page, and the cause all died with this
 * process. Writing it here, from the code that is actually standing at the
 * failure, is the only place the reason exists.
 *
 * The event is always written before the process ends, so it is on the
 * record before the listener clears submit_requested_at.
 */
async function stopAt(
  code: StopCode, stage: StopStage, detail: string,
  opts: { mismatches?: StopRecord["mismatches"]; page?: any } = {},
): Promise<never> {
  let url: string | null = null, title: string | null = null, pageReached = false;
  if (opts.page) {
    pageReached = true;
    url = await Promise.resolve(opts.page.url()).catch(() => null);
    title = await opts.page.title().catch(() => null);
  }
  const record: StopRecord = { code, stage, detail, pageReached, url, title, mismatches: opts.mismatches ?? [] };
  console.error(`\nSTOP [${code} @ ${stage}] ${detail}`);
  await db.from("application_events").insert({
    application_id: applicationId, event: STOP_EVENT, actor: "worker",
    detail: formatStopDetail(record),
  }).then(() => undefined, (e: any) => console.error(`  (could not record stop: ${e?.message})`));
  // Past the browser's existence, releasing it is the caller's business.
  if (typeof (globalThis as any).__releaseBrowser === "function") {
    await (globalThis as any).__releaseBrowser().catch(() => undefined);
  }
  process.exit(1);
}

// ---- nothing proceeds unless the package is exactly as approved ------
const { data: app } = await db.from("applications")
  .select("id,job_id,job_version_id,status,human_approved,human_approved_at,authorization_mode,all_fields_confident,form_snapshot,form_snapshot_hash,resume_id,approved_artifact_sha256,approved_content_sha256,approved_answers_sha256,submitted_at")
  .eq("id", applicationId).single();
if (!app) { console.error("no such application"); process.exit(1); }
if (app.submitted_at) await stopAt("ALREADY_SUBMITTED", "preflight",
  `This application was already submitted at ${app.submitted_at}; nothing further was attempted.`);
// Either authorization path may submit, and which one it was stays
// visible. human_approved means a person read this application;
// POLICY_AUTHORIZED means it matched rules enabled in advance and nobody
// read it. Both still require READY_TO_SUBMIT and, below, an approved
// artifact hash that matches the bytes on disk.
const authorized = app.human_approved || app.authorization_mode === "POLICY_AUTHORIZED";
if (app.status !== "READY_TO_SUBMIT" || !authorized) {
  await stopAt("REVALIDATION_REFUSED", "preflight",
    `The application is ${app.status} with authorization=${app.authorization_mode ?? "none"}; `
    + `submitting needs READY_TO_SUBMIT plus an approval or a policy authorization.`);
}
console.log(app.human_approved
  ? "authorized by you"
  : "authorized by policy; no person reviewed this application");
const artifact = await approvedArtifact(db, applicationId);
if (!artifact.ok) {
  await stopAt("ARTIFACT_MISMATCH", "preflight",
    `The approved resume artifact could not be loaded: ${artifact.why}`);
  // stopAt calls process.exit, so this never runs. It is here because a
  // Promise<never> does not end control flow for the type checker, and
  // without it every later use of the artifact widens back to the
  // failure shape.
  throw new Error("unreachable");
}
if (artifact.sha256 !== app.approved_artifact_sha256) {
  await stopAt("ARTIFACT_MISMATCH", "preflight",
    `The stored artifact ${artifact.sha256?.slice(0, 12)} is not the approved `
    + `${app.approved_artifact_sha256?.slice(0, 12)}; the bytes on disk changed after approval.`);
}

const { data: job } = await db.from("jobs")
  .select("id,title,source,application_form_url,company_id").eq("id", app.job_id).single();
const { data: company } = await db.from("companies").select("name,domain,ats_token").eq("id", job!.company_id).single();
const { data: version } = await db.from("job_versions").select("id,is_current").eq("id", app.job_version_id).single();
if (!version?.is_current) await stopAt("STALE_JOB_VERSION", "preflight",
  "The posting has a newer version than the one approved; re-prepare rather than submitting.");

// Revalidate against facts read now, not facts read at approval time.
// See lib/applications/revalidate.ts for why an approval alone is not
// enough. Nothing here decides candidacy or eligibility; it only refuses
// to act on an approval the present no longer supports.
{
  const [{ data: freshJob }, { data: verdictRows }, { data: answerRows }, { data: siblings }] = await Promise.all([
    db.from("jobs").select("status,eligibility,canonical_opening_id").eq("id", app.job_id).single(),
    db.from("job_candidacy").select("verdict,created_at").eq("job_id", app.job_id)
      .order("created_at", { ascending: false }).limit(1),
    db.from("application_answers").select("confidence_state,is_required,answer_text,field_key")
      .eq("application_id", applicationId),
    db.from("applications").select("id,job_id,submitted_at").not("submitted_at", "is", null),
  ]);

  let otherSubmittedOnOpening = false;
  if (freshJob?.canonical_opening_id) {
    const otherIds = (siblings ?? []).filter((s: any) => s.id !== applicationId).map((s: any) => s.job_id);
    if (otherIds.length) {
      const { data: otherJobs } = await db.from("jobs").select("canonical_opening_id").in("id", otherIds);
      otherSubmittedOnOpening = (otherJobs ?? [])
        .some((j: any) => j.canonical_opening_id === freshJob.canonical_opening_id);
    }
  }

  const answers2 = answerRows ?? [];
  const check = revalidateBeforeSubmit({
    applicationId,
    jobStatus: freshJob?.status ?? "unknown",
    eligibility: freshJob?.eligibility ?? null,
    candidacyVerdict: verdictRows?.[0]?.verdict ?? null,
    candidacyComputedAt: verdictRows?.[0]?.created_at ?? null,
    humanApproved: Boolean(app.human_approved),
    humanApprovedAt: (app as any).human_approved_at ?? null,
    authorizationMode: app.authorization_mode ?? null,
    allFieldsConfident: Boolean(app.all_fields_confident),
    blockedAnswers: answers2.filter((a: any) => a.confidence_state === "BLOCKED").length,
    requiredUnanswered: answers2.filter((a: any) => a.is_required && !a.answer_text).length,
    jobVersionIsCurrent: Boolean(version?.is_current),
    storedArtifactSha256: artifact.sha256 ?? null,
    approvedArtifactSha256: app.approved_artifact_sha256 ?? null,
    otherSubmittedOnOpening,
    currentAnswersSha256: answerSetHash(answers2 as any),
    approvedAnswersSha256: (app as any).approved_answers_sha256 ?? null,
    readbackPassed: true,
  });
  if (!check.ok) {
    for (const r of check.refusals) console.error(`  ${r.code}: ${r.detail}`);
    await stopAt("REVALIDATION_REFUSED", "revalidation",
      `The approval no longer matches current facts: `
      + check.refusals.map((r: any) => `${r.code} (${r.detail})`).join("; ")
      + `. The application and its approval are unchanged.`,
      { mismatches: check.refusals.map((r: any) => ({ field: r.code, expected: "approved", actual: r.detail })) });
  }
}

const answers: PreparedAnswer[] = (await paged("application_answers",
  "field_key,field_label,answer_text,confidence_state,is_required",
  (q) => q.eq("application_id", applicationId))).map((a) => ({
    fieldKey: a.field_key, fieldLabel: a.field_label, answer: a.answer_text,
    confidence: a.confidence_state, isRequired: a.is_required,
  }));

const capture = async (page: Page, file: string) => {
  guardScreenshot();
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
};

const runDir = join(".fill-runs", `submit-${applicationId}-${Date.now()}`);
// The durable pointer to this run's evidence, in the form the portal
// resolves. Derived from runDir so the two can never disagree.
const evidenceReference = `fill-run:${basename(runDir)}`;
await mkdir(runDir, { recursive: true });
const { data: profile } = await db.from("profile")
  .select("legal_first_name,legal_last_name,preferred_name,email_job_search").single();
const resumePdfPath = join(runDir, `${profile!.preferred_name ?? profile!.legal_first_name} ${profile!.legal_last_name} - Resume.pdf`);
await writeFile(resumePdfPath, artifact.pdf);

// The repeatable-education inputs, same as the filler uses.
const DEGREE_LEVEL: Array<[RegExp, string]> = [
  [/\bassociate/i, "Associate's Degree"], [/\bbachelor|^b\.?[as]\b/i, "Bachelor's Degree"],
  [/\bm\.?b\.?a\b/i, "Master of Business Administration (M.B.A.)"], [/\bmaster/i, "Master's Degree"],
  [/\bph\.?d|doctor of philosophy/i, "Doctor of Philosophy (Ph.D.)"],
  [/\bj\.?d\b|juris doctor/i, "Juris Doctor (J.D.)"], [/\bm\.?d\b|doctor of medicine/i, "Doctor of Medicine (M.D.)"],
  [/high school|diploma/i, "High School"],
];
const educationRecords = (await paged("education", "institution,credential,status,completed,end_month"))
  .filter((e: any) => e.status === "VERIFIED" && e.completed && e.institution && e.credential)
  .sort((a: any, b: any) => String(b.end_month ?? "").localeCompare(String(a.end_month ?? "")))
  .map((e: any) => ({ institution: String(e.institution),
    degree: DEGREE_LEVEL.find(([re]) => re.test(String(e.credential)))?.[1] ?? String(e.credential) }));
const degreeOptions: string[] = company?.ats_token
  ? await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.ats_token)}/education/degrees`)
      .then((r) => (r.ok ? r.json() : { items: [] })).then((b: any) => (b.items ?? []).map((i: any) => String(i.text)))
      .catch(() => [])
  : [];

console.log(`${company?.name} — ${job!.title}`);
console.log(`  approved artifact ${artifact.sha256.slice(0, 12)} (${artifact.pdf.length} bytes)`);
console.log(`  form ${job!.application_form_url}\n`);

const runStarted = Date.now();
const fillRun = startFillRun({
  applicationId, provider: job!.source, runDir,
  fillMode: "AUTOMATED", formSnapshotHash: app.form_snapshot_hash,
});
const stayOpen = process.argv.includes("--stay-open");
const context = await launchApplicationContext();

/**
 * Releasing the browser, exactly once, whatever happens next.
 *
 * Nothing here used to close anything. The failure paths all called
 * process.exit, which tore the browser down as a side effect, so only
 * the success path was affected: it ran off the end of the module, the
 * persistent context kept the event loop alive, and Node sat there
 * forever holding .browser-profile/SingletonLock. A confirmed submission
 * therefore blocked every subsequent browser run on this machine,
 * including the scheduled worker, until someone noticed and killed it.
 *
 * --stay-open is the one exception, for handing a filled form to a
 * person. It has to be asked for; it is never the default.
 */
let released = false;
// stopAt is defined above the browser exists, so it reaches the releaser
// through a slot rather than a forward reference it cannot have.
async function releaseBrowser(): Promise<void> {
  if (released || stayOpen) return;
  released = true;
  await context.close().catch(() => undefined);
}

(globalThis as any).__releaseBrowser = releaseBrowser;

/** Ends the process deterministically rather than waiting on the loop. */
async function finish(code: number): Promise<never> {
  await releaseBrowser();
  process.exit(code);
}

// A throw anywhere below must not strand the profile either.
// A crash is still a stop, and it still needs a reason on the record.
// Best effort by necessity: the process is already unwinding.
async function recordCrash(what: string): Promise<void> {
  await db.from("application_events").insert({
    application_id: applicationId, event: STOP_EVENT, actor: "worker",
    detail: formatStopDetail({
      code: "RUNNER_CRASHED", stage: "fill", pageReached: false,
      detail: `The run threw and did not reach the submit click: ${what}`,
    }),
  }).then(() => undefined, () => undefined);
}
process.on("uncaughtException", (e) => {
  console.error(`unhandled: ${(e as Error).message}`);
  void recordCrash((e as Error).message)
    .then(() => releaseBrowser()).finally(() => process.exit(1));
});
process.on("unhandledRejection", (e) => {
  console.error(`unhandled rejection: ${String(e)}`);
  void recordCrash(String(e)).then(() => releaseBrowser()).finally(() => process.exit(1));
});


const resolveContext = await loadContext(db);
resolveContext.application = await applicationScope(db, job!.id).catch(() => undefined);

const outcome = await fillApplication({
  db, context, applicationId, provider: job!.source,
  applyUrl: job!.application_form_url!, storedHash: app.form_snapshot_hash,
  storedFields: (app.form_snapshot as any)?.fields ?? [],
  answers, resumePdfPath, runDir, resolveContext,
  boardToken: company?.ats_token ?? null, educationRecords, degreeOptions,
});

// Record the run. fill-application.ts has always done this; this script
// never did, so every worker-driven fill was invisible in the handoff
// inbox and in the audit trail. A stop nobody can see is a stop that
// silently becomes a stalled application.
{
  // Recorded BEFORE the submit click. The fill and the click are two
  // different events and the fill must be on the record whether or not
  // the click ever happens, so submit_click_attempted is false here and
  // the boundary column on applications remains the authority for the
  // click itself.
  const { warnings } = await recordFillRun(db, fillRun, {
    outcome: outcome.reason,
    detail: outcome.message,
    filled: outcome.filled,
    leftBlank: outcome.leftBlank,
    parserReconciliation: outcome.parserReconciliation ?? [],
    guardReport: outcome.guard ?? {},
    artifact: { resumeId: app.resume_id!, sha256: artifact.sha256, path: resumePdfPath },
    submitClickAttempted: false,
    extra: outcome as unknown as Record<string, unknown>,
  });
  for (const w of warnings) console.log(`  (${w})`);
}

console.log(`fill outcome: ${outcome.reason}`);
console.log(`  filled ${outcome.filled.length}, left blank ${outcome.leftBlank.length}`);
if (outcome.reason !== "HANDOFF") {
  await stopAt(fillStopCode(outcome.reason), "fill",
    `The fill ended as ${outcome.reason} rather than HANDOFF: ${outcome.message}`,
    { page: context.pages()[context.pages().length - 1] ?? undefined,
      mismatches: (outcome.leftBlank ?? []).map((f: any) => ({
        field: typeof f === "string" ? f : (f?.label ?? f?.key ?? "unknown"),
        expected: "filled", actual: "left blank" })) });
}

const page: Page = context.pages().find((p) => p.url().includes("greenhouse.io")) ?? context.pages()[context.pages().length - 1]!;

// ---- what the page looked like before the click ---------------------
const before = await page.evaluate(() => ({
  url: location.href,
  controls: document.querySelectorAll("input,select,textarea").length,
  text: (document.body.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 40000),
}));
await capture(page, join(runDir, "10-before-submit.png"));

// ---- the one click ---------------------------------------------------
//
// Resolved structurally, inside the form, never by hunting page text for
// something that looks clickable.
const submit = page.locator("form button[type=submit], form input[type=submit]")
  .or(page.getByRole("button", { name: /submit application/i }));
const count = await submit.count();
if (count !== 1) {
  await stopAt("SUBMIT_CONTROL_AMBIGUOUS", "pre-submit",
    `The submit control resolved to ${count} elements, not exactly one, so no click was attempted.`,
    { page });
}
console.log(`\nclicking submit (${await submit.first().innerText().catch(() => "?")})`);
const requestedAt = new Date();

// The point of no return, recorded before crossing it.
//
// Everything above this line can be retried freely: nothing has reached
// the employer. Everything below may have. If this process is SIGKILLed
// at the listener's 20-minute timeout, or dies outright, this column is
// the only surviving evidence that a click may have happened, and the
// listener reads it to decide between SAFE_STOP and AMBIGUOUS.
//
// Written before the click rather than after, deliberately. Writing it
// after would leave the one case that matters most - killed mid-click -
// looking exactly like a run that never clicked at all.
await db.from("applications")
  .update({ submit_click_attempted_at: requestedAt.toISOString() })
  .eq("id", applicationId);

await submit.first().click({ timeout: 15_000 });

// Give the board time to answer, then let it settle.
await page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => undefined);
await page.waitForTimeout(4000);
await capture(page, join(runDir, "11-after-submit.png"));

// ---- did it actually land? ------------------------------------------
const after = await page.evaluate(() => {
  const text = (document.body.innerText ?? "").replace(/\s+/g, " ").trim();
  const hasCaptchaFrame = [...document.querySelectorAll("iframe")]
    .some((f) => /recaptcha|hcaptcha|turnstile/i.test(f.getAttribute("src") ?? ""));
  return {
    url: location.href,
    controls: document.querySelectorAll("input,select,textarea").length,
    text: text.slice(0, 40000),
    // A visible challenge, not merely the invisible widget every
    // Greenhouse page loads.
    captchaVisible: [...document.querySelectorAll("iframe")].some((f) => {
      const src = f.getAttribute("src") ?? "";
      if (!/recaptcha|hcaptcha|turnstile/i.test(src)) return false;
      const r = f.getBoundingClientRect();
      return /bframe|challenge/i.test(src) && r.width > 100 && r.height > 100;
    }),
    hasCaptchaFrame,
    errors: [...document.querySelectorAll("[class*='error' i], [role='alert'], [aria-invalid='true']")]
      .map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8),
  };
});

// ---- a code challenge, if the board raised one ----------------------
//
// Gmail is not consulted unless the submitted form actually asked for a
// code, and even then the form's own wording decides whether the mailbox
// is touched at all. Stripe says it is confirming a human, so this stops.
const gmail: GmailDeps = { searchIds, getMessage, now: () => Date.now() };
let verification: VerificationOutcome = { kind: "NO_CHALLENGE" };

if (asksForCode(after.text)) {
  verification = await resolveVerificationStep({
    page, gmail, log: (line) => console.log(`  ${line}`),
    context: {
      applicationId,
      employer: { name: company?.name ?? "", domain: company?.domain ?? null },
      boardSenders: APPLICATION_SENDERS,
      recipient: profile!.email_job_search,
      requestedAt,
    },
  });
  if (verification.kind === "VERIFIED") {
    // The step was satisfied. Whether the application landed is a
    // different question, so the page is re-read and judged again below
    // on exactly the same terms as an application with no challenge.
    await page.waitForTimeout(3000);
    const fresh = await readPageContext(page);
    after.text = fresh.text;
    after.controls = fresh.controls;
    after.url = fresh.url;
    await capture(page, join(runDir, "11b-after-verification.png"));
  }
}

const SUCCESS = /thank you|application (?:has been )?(?:received|submitted)|we[’']?ve received|successfully submitted|your application was/i;
const DUPLICATE = /already (?:applied|submitted)|duplicate application/i;
const LOGIN = /sign in|log in to continue|session (?:has )?expired/i;
const VALIDATION = /please (?:enter|select|complete|correct)|this field is required/i;
// An emailed code is a human check, not a form error. It is the employer
// asking for a person, and answering it is not this system's to do.
let humanVerification = false;

// Greenhouse prints "* indicates a required field" on every form, before
// the click as much as after it. Judging the result on text the page was
// already showing would fail every submission, including a real one, so
// only text the click ACTUALLY introduced counts as a complaint.
const introduced = (re: RegExp) => re.test(after.text) && !re.test(before.text);

let succeeded = SUCCESS.test(after.text);
const problems: string[] = [];
if (after.captchaVisible) problems.push("a CAPTCHA challenge is displayed; this system does not solve them");
if (verification.kind === "HANDOFF") {
  problems.push(`${verification.classification}: ${verification.reason}`);
  humanVerification = true;
}
if (introduced(DUPLICATE)) problems.push("the page mentions an existing or duplicate application");
// A sign-in offer on a confirmation page is not a sign-in wall.
//
// Home Chef's confirmation page reads "Thank you for applying!" beside a
// card offering "Sign in to MyGreenhouse to keep tabs on your
// application". The submission had plainly succeeded: the URL moved to
// /confirmation and every control was gone. Treating the word "sign in"
// anywhere on the page as a barrier meant a real, completed application
// was recorded as not submitted, which is the more dangerous error of
// the two: it invites applying to the same employer twice.
//
// A genuine wall keeps the form and does not congratulate you. When the
// page says the application was received, an invitation to track it is
// an invitation, not an obstacle.
if (introduced(LOGIN) && !succeeded) problems.push("the page is asking to sign in");
if (introduced(VALIDATION)) problems.push("the page introduced validation text");
if (after.errors.length) problems.push(`error elements present: ${after.errors.join(" | ").slice(0, 200)}`);
if (after.controls >= before.controls && !succeeded && !humanVerification)
  problems.push(`the form is still present (${after.controls} controls)`);

console.log(`\nafter the click`);
console.log(`  url        ${after.url}`);
console.log(`  controls   ${before.controls} -> ${after.controls}`);
console.log(`  success signal: ${succeeded ? "YES" : "no"}`);
console.log(`  page says: ...${after.text.slice(-260)}`);
for (const p of problems) console.log(`  PROBLEM: ${p}`);

// ---- the part only a person can do --------------------------------
//
// Stripe emails an 8-character code and will not accept the application
// without it. Answering that is the applicant's to do, not this script's.
// So the form is left open with the code entry in view, and this waits,
// watching for the board to confirm receipt on its own terms.
let confirmText = after.text;
if (hold && humanVerification && !succeeded) {
  const codeBox = page.locator("input[name*='security' i], input[name*='code' i], input[autocomplete='one-time-code']").first();
  await codeBox.scrollIntoViewIfNeeded().catch(() => undefined);
  await codeBox.focus().catch(() => undefined);
  console.log(`\nthe form is open and waiting.`);
  console.log(`  Stripe emailed an 8-character code to the address on the application.`);
  console.log(`  enter it, then click Submit application. watching for up to 20 minutes.\n`);

  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    const now = await page.evaluate(() => ({
      text: (document.body.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 40000),
      controls: document.querySelectorAll("input,select,textarea").length,
    })).catch(() => null);
    if (!now) { console.log("the browser was closed before any confirmation appeared."); break; }
    if (SUCCESS.test(now.text)) {
      succeeded = true; confirmText = now.text;
      problems.length = 0;
      console.log(`confirmed by the page: ${now.text.slice(0, 200)}`);
      await capture(page, join(runDir, "12-confirmed.png"));
      break;
    }
  }
  if (!succeeded) console.log("no confirmation appeared within the window.");
}

const evidence = {
  clicked_at: new Date().toISOString(),
  url_before: before.url, url_after: after.url,
  controls_before: before.controls, controls_after: after.controls,
  success_signal: succeeded,
  verification: verification.kind === "VERIFIED"
    ? { kind: "VERIFIED", ...verification.provenance }
    : verification,
  held_for_human: hold && humanVerification, human_verification_required: humanVerification, problems,
  page_text: confirmText.slice(0, 900),
  screenshots: [join(runDir, "10-before-submit.png"), join(runDir, "11-after-submit.png")],
  guard_report: outcome.guard,
};
await writeFile(join(runDir, "submission-evidence.json"), JSON.stringify(evidence, null, 2));

if (!succeeded || problems.length) {
  console.error(`\nNOT MARKED SUBMITTED. ${problems.length ? problems.join("; ") : "no clear confirmation was shown"}`);
  console.error(`The application stays ${app.status} and is recoverable. Evidence in ${runDir}`);
  await db.from("application_events").insert({
    // The trail should say which of the three it was. An unrecognized
    // challenge and an explicit human check are both handoffs, but they
    // are not the same finding.
    application_id: applicationId,
    event: verification.kind === "HANDOFF"
      ? (verification.classification === "HUMAN_PRESENCE"
        ? "SUBMIT_BLOCKED_HUMAN_VERIFICATION"
        : "SUBMIT_BLOCKED_VERIFICATION_UNRESOLVED")
      : "SUBMIT_ATTEMPTED_NO_CONFIRMATION",
    detail: `submit was clicked and the page did not confirm receipt. ${problems.join("; ") || "no success text"}. `
      + `url ${after.url}. Left ${app.status}; nothing recorded as submitted.`,
    actor: "user:plebantyler@gmail.com",
  });
  await finish(1);
}

// ---- only now is anything written -----------------------------------
const submittedAt = new Date().toISOString();
// confirmation_reference is written here and nowhere else.
//
// This line is inside the branch that only runs once the confirmation
// checks above have passed, so the reference can never point at a run
// that did not actually confirm. Recording SUBMITTED without it left
// two real submissions looking unconfirmed until someone went and found
// the evidence directory by hand.
const { error } = await db.from("applications")
  .update({
    status: "SUBMITTED",
    submitted_at: submittedAt,
    confirmation_reference: evidenceReference,
  }).eq("id", applicationId);
if (error) { console.error(`confirmed, but could not record it: ${error.message}`); await finish(1); }

if (verification.kind === "VERIFIED") {
  await db.from("application_events").insert({
    application_id: applicationId, event: "EMAIL_VERIFICATION_COMPLETED",
    detail: `An ordinary email verification step was completed from message `
      + `${verification.provenance.messageId} sent ${verification.provenance.sentAt} by `
      + `${verification.provenance.from}. The code itself is not recorded anywhere.`,
    actor: "system",
  });
}

await db.from("application_events").insert({
  application_id: applicationId, event: "SUBMIT_CONFIRMED",
  detail: `Confirmed by the live page. artifact ${app.approved_artifact_sha256}, content ${app.approved_content_sha256}, `
    + `snapshot ${app.form_snapshot_hash}, job ${app.job_id}, application ${applicationId}, `
    + `${answers.length} answers, ${outcome.filled.length} filled. Confirmation: ${JSON.stringify(confirmText.slice(0, 300))}. `
    + `Evidence in ${runDir} (${evidenceReference}).`,
  actor: "user:plebantyler@gmail.com",
});

console.log(`\nSUBMITTED and recorded at ${submittedAt}`);
console.log(`  artifact ${app.approved_artifact_sha256}`);
console.log(`  content  ${app.approved_content_sha256}`);
console.log(`  snapshot ${app.form_snapshot_hash}`);
console.log(`  evidence ${runDir}`);

// Terminal. The submission is confirmed and recorded, so the browser has
// no further purpose and the next run needs the profile back.
await finish(0);
