/**
 * The applications page's data: every application with its one real
 * blocker, plus the compact summary a person reads in seconds.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadApplications, type ApplicationSummary } from "./applications.ts";
import { deriveBlocker, type Blocker, type BlockerFacts } from "./blocker.ts";
import { parseStopDetail, STOP_EVENT } from "../applications/stopReason.ts";
import { page } from "./db.ts";
import { revalidateBeforeSubmit } from "../applications/revalidate.ts";
import { authoritativeCandidacy } from "../applications/authoritativeCandidacy.ts";
import { FIT_FORMULA_VERSION } from "../scoring/fit.ts";
import { TAXONOMY_VERSION } from "../scoring/requirementClass.ts";
import { CANDIDACY_MODEL_VERSION } from "../scoring/candidacy.ts";

// Refusal codes that only mean something once an approval exists; before the
// first review they are what the reviewer is about to establish, not a fault.
// Same set the /apply board filters, so the two boards agree.
const NOT_YET_APPROVED_NOISE = new Set([
  "NOT_AUTHORIZED", "FIELDS_NOT_CONFIDENT", "BLOCKED_ANSWERS",
  "REQUIRED_UNANSWERED", "NO_APPROVED_ARTIFACT", "ARTIFACT_CHANGED",
]);

export interface BoardRow { app: ApplicationSummary; blocker: Blocker }
export interface BoardSummary {
  processing: number; needAnswer: number; needReview: number; ready: number;
  issue: number; stretchManual: number; submittedToday: number; submittedTotal: number;
}

const ISSUE_CODES = new Set(["AMBIGUOUS_SUBMIT_STATE", "SUBMISSION_FAILED", "REVALIDATION_FAILED", "FORM_NOT_READ"]);
const CLOSED = new Set(["REJECTED", "WITHDRAWN", "ABANDONED"]);

export async function loadBlockerBoard(db: SupabaseClient): Promise<{ rows: BoardRow[]; summary: BoardSummary }> {
  const apps = await loadApplications(db);

  const { data: jobRows } = await db.from("jobs").select("id,status,source,apply_url,application_form_url,url,eligibility,canonical_opening_id")
    .in("id", [...new Set(apps.map((a) => a.jobId))]);
  const jobById = new Map((jobRows ?? []).map((j: any) => [j.id, j]));
  const { data: ats } = await db.from("ats_policy").select("provider,paused,capability");
  const atsByProvider = new Map((ats ?? []).map((p: any) => [p.provider, p]));
  const { data: pol } = await db.from("automation_policy").select("max_applications_per_day").limit(1).maybeSingle();

  // The submit guard's refusals, computed exactly as the /apply board and the
  // /review page compute them, so no surface can disagree about whether this
  // application can be approved. Without this the board hardcoded refusals=[]
  // and always promised "it submits after you approve it" -- even for a job
  // the review page (and the submit path) refuse on qualification grounds.
  const jobIds = [...new Set(apps.map((a) => a.jobId).filter(Boolean))];
  const scoped = (col: string, ids: string[]) => (q: any) => q.in(col, ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  const [candidacy, profileRow, resumeRows, extraApp] = await Promise.all([
    page<any>(db, "job_candidacy", "job_id,verdict,created_at,profile_version,formula_version,taxonomy_version,model_version,reason_codes,hard_met,hard_total", scoped("job_id", jobIds), "job_id"),
    db.from("profile").select("profile_version").single(),
    page<any>(db, "resumes", "id,artifact_sha256", scoped("id", apps.map((a) => a.resumeId).filter(Boolean) as string[])),
    page<any>(db, "applications", "id,approved_artifact_sha256,approved_answers_sha256,authorization_mode,human_approved_at,all_fields_confident", scoped("id", apps.map((a) => a.id))),
  ]);
  const versionsNow = {
    profileVersion: (profileRow as any)?.data?.profile_version ?? -1,
    formulaVersion: FIT_FORMULA_VERSION, taxonomyVersion: TAXONOMY_VERSION, modelVersion: CANDIDACY_MODEL_VERSION,
  };
  const currentByJob = authoritativeCandidacy(candidacy as any, versionsNow);
  const candByJob = new Map<string, any>();
  for (const c of candidacy.sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)))) {
    const isAuthoritative = currentByJob.get(c.job_id) === c.verdict
      && c.profile_version === versionsNow.profileVersion && c.model_version === versionsNow.modelVersion;
    const eligible = jobById.get(c.job_id)?.eligibility === "ELIGIBLE";
    candByJob.set(c.job_id, { ...c, current: isAuthoritative && eligible });
  }
  const artifactByResume = new Map((resumeRows ?? []).map((r: any) => [r.id, r.artifact_sha256]));
  const extraById = new Map((extraApp ?? []).map((a: any) => [a.id, a]));
  const submittedOpenings = new Set<string>();
  for (const a of apps) { if (!a.submittedAt) continue; const j = jobById.get(a.jobId); if (j?.canonical_opening_id) submittedOpenings.add(j.canonical_opening_id); }

  const refusalsByApp = new Map<string, string[]>();
  for (const a of apps) {
    if (a.submittedAt) { refusalsByApp.set(a.id, []); continue; }
    const j = jobById.get(a.jobId); if (!j) { refusalsByApp.set(a.id, []); continue; }
    const cr = candByJob.get(a.jobId);
    const x = extraById.get(a.id) ?? {};
    const codes = revalidateBeforeSubmit({
      applicationId: a.id, jobStatus: j.status, eligibility: j.eligibility,
      candidacyVerdict: cr?.current ? cr.verdict : null,
      candidacyComputedAt: cr?.current ? cr.created_at : null,
      candidacyReasonCode: cr?.current ? (cr.reason_codes?.[0] ?? null) : null,
      hardMet: cr?.current ? cr.hard_met : null, hardTotal: cr?.current ? cr.hard_total : null,
      humanApproved: a.humanApproved, humanApprovedAt: x.human_approved_at ?? null,
      authorizationMode: x.authorization_mode ?? null, allFieldsConfident: a.allFieldsConfident,
      blockedAnswers: a.blocked, requiredUnanswered: Math.max(0, a.required - a.accountedFor),
      jobVersionIsCurrent: !a.postingChanged,
      // Artifact/answer hashes are passed matched so their post-approval drift
      // codes never fire here; those are not part of the approval-prohibiting
      // classification and have their own handling once an approval exists.
      storedArtifactSha256: artifactByResume.get(a.resumeId ?? "") ?? x.approved_artifact_sha256 ?? null,
      approvedArtifactSha256: x.approved_artifact_sha256 ?? artifactByResume.get(a.resumeId ?? "") ?? null,
      otherSubmittedOnOpening: Boolean(j.canonical_opening_id && submittedOpenings.has(j.canonical_opening_id)),
      currentAnswersSha256: x.approved_answers_sha256 ?? "x", approvedAnswersSha256: x.approved_answers_sha256 ?? "x",
      readbackPassed: true,
    }).refusals.map((r) => r.code)
      .filter((c) => !NOT_YET_APPROVED_NOISE.has(c) || a.humanApproved);
    refusalsByApp.set(a.id, codes);
  }

  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const submittedToday = apps.filter((a) => a.submittedAt && a.submittedAt >= midnight.toISOString()).length;
  const cap = pol?.max_applications_per_day ?? null;
  const capReached = cap !== null && submittedToday >= cap;

  // The last recorded stop, for applications whose most recent attempt
  // stopped safely. One query, newest first, first per application.
  const { data: stops } = await db.from("application_events")
    .select("application_id,detail,occurred_at").eq("event", STOP_EVENT)
    .in("application_id", apps.map((a) => a.id)).order("occurred_at", { ascending: false });
  const lastStop = new Map<string, string>();
  for (const s of stops ?? []) if (!lastStop.has(s.application_id)) lastStop.set(s.application_id, s.detail);

  // submit_outcome is not on the summary; read it in one sweep.
  const { data: outcomes } = await db.from("applications").select("id,submit_outcome")
    .in("id", apps.map((a) => a.id));
  const outcomeById = new Map((outcomes ?? []).map((o: any) => [o.id, o.submit_outcome]));

  const rows: BoardRow[] = apps.map((a) => {
    const job = jobById.get(a.jobId);
    const policy = atsByProvider.get(job?.source ?? "");
    const stop = lastStop.get(a.id) ?? null;
    const facts: BlockerFacts = {
      status: a.status, submittedAt: a.submittedAt,
      submitQueued: Boolean(a.submitRequestedAt && !a.submitStartedAt),
      submitRunning: Boolean(a.submitStartedAt && !a.submittedAt),
      submitOutcome: (outcomeById.get(a.id) ?? null) as any,
      lastStopCode: stop ? parseStopDetail(stop)?.code ?? null : null,
      lastStopDetail: stop,
      humanApproved: a.humanApproved,
      blockedAnswers: a.blocked,
      requiredUnanswered: a.required - a.accountedFor,
      discoveredFields: a.discoveredFields,
      refusals: refusalsByApp.get(a.id) ?? [],
      provider: job?.source ?? "UNKNOWN",
      providerCapability: policy?.capability ?? null,
      providerPaused: Boolean(policy?.paused),
      applyUrl: job?.application_form_url ?? job?.apply_url ?? job?.url ?? null,
      dailyCapReached: capReached,
      jobStatus: job?.status ?? "OPEN",
    };
    return { app: a, blocker: deriveBlocker(facts, a.id) };
  });

  const open = rows.filter((r) => !CLOSED.has(r.app.status));
  const summary: BoardSummary = {
    processing: open.filter((r) => r.blocker.code === "PROCESSING" || r.blocker.code === "SUBMISSION_IN_PROGRESS" || r.blocker.code === "ENQUEUED").length,
    needAnswer: open.filter((r) => r.blocker.code === "WAITING_FOR_MY_ANSWER").length,
    needReview: open.filter((r) => r.blocker.code === "WAITING_FOR_MY_REVIEW").length,
    ready: open.filter((r) => r.blocker.code === "READY_TO_SUBMIT" || r.blocker.code === "DAILY_CAP_REACHED").length,
    issue: open.filter((r) => ISSUE_CODES.has(r.blocker.code)
      || r.blocker.code === "ATS_NOT_AUTOMATED" || r.blocker.code === "AUTHENTICATION_REQUIRED").length,
    stretchManual: open.filter((r) => r.blocker.code === "MANUAL_OPTIONAL_QUALIFICATION_GAP" || r.blocker.code === "NOT_A_MATCH").length,
    submittedToday,
    submittedTotal: rows.filter((r) => r.app.submittedAt).length,
  };
  return { rows, summary };
}
