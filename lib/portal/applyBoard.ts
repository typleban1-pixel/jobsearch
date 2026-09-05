/**
 * Loading what Apply and the question wizard need.
 *
 * Everything here is read through the existing tables and the existing
 * presentation mapping. No new state is introduced; this only assembles
 * facts the system already holds into the shape the two pages render.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { present, type ApplicationFacts, type Presentation } from "./presentationState.ts";
import { revalidateBeforeSubmit } from "../applications/revalidate.ts";
import { groupBlockedQuestions, summarize, type BlockedField, type QuestionGroup } from "./questionGroups.ts";
import { staleBlockedStatus, isEmployerFormHandoff } from "./answerCompleteness.ts";
import { answerSetHash } from "../applications/approvalBinding.ts";
import { authoritativeCandidacy } from "../applications/authoritativeCandidacy.ts";
import { FIT_FORMULA_VERSION } from "../scoring/fit.ts";
import { TAXONOMY_VERSION } from "../scoring/requirementClass.ts";
import { CANDIDACY_MODEL_VERSION } from "../scoring/candidacy.ts";
import { loadMatchScores } from "./db.ts";
import type { MatchScoreResult } from "./matchScore.ts";

export interface ApplyRow {
  applicationId: string;
  jobId: string;
  company: string;
  title: string;
  provider: string;
  submittedAt: string | null;
  match: MatchScoreResult | null;
  presentation: Presentation;
}

export interface ApplyBoard {
  needsYou: ApplyRow[];
  preparing: ApplyRow[];
  ready: ApplyRow[];
  recentlySubmitted: ApplyRow[];
  closed: ApplyRow[];
  blocked: { blockedFields: number; answersNeeded: number; handoffs: number; applications: number };
}

/**
 * Guard refusals that are expected before a first approval, and only
 * meaningful after one. Blocked answers and unanswered fields are shown
 * by their own dedicated states, not as refusals.
 */
const NOT_YET_APPROVED_NOISE = new Set([
  "NOT_AUTHORIZED", "FIELDS_NOT_CONFIDENT", "BLOCKED_ANSWERS",
  "REQUIRED_UNANSWERED", "NO_APPROVED_ARTIFACT", "ARTIFACT_CHANGED",
]);

/**
 * The reason a person is needed, as one sentence.
 *
 * prepare-handoff writes a provider-specific explanation. Anything
 * longer than its first sentence belongs on the application page, not on
 * a card.
 *
 * Two things this has to get right, both learned from the real stored
 * text rather than from a tidy example:
 *
 *   The reason is HARD WRAPPED, so its first sentence spans several
 *   lines. Reading only the first line cut Northern Trust's mid-clause
 *   and produced "...cannot be read or", which then had another sentence
 *   appended to it. Whitespace is normalised before anything is cut.
 *
 *   The prefix is internal vocabulary and varies by provider: plain
 *   HANDOFF from prepare-handoff, ASHBY_HANDOFF and WORKDAY_HANDOFF
 *   elsewhere. All of them are stripped, because none of them is a word
 *   a person needs to read.
 *
 * If no sentence boundary is found at all, this returns null rather than
 * a fragment: a card with no reason falls back to naming the ATS, which
 * is worth more than half a sentence.
 */
export function firstSentenceOf(reason: string | null | undefined): string | null {
  const t = String(reason ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[A-Z_]*HANDOFF:\s*/i, "")
    .trim();
  if (!t) return null;
  const stop = t.search(/[.!?](\s|$)/);
  if (stop <= 0) return null;
  return t.slice(0, stop + 1).trim() || null;
}

const page = async (db: SupabaseClient, t: string, cols: string, f: (q: any) => any = (q) => q, order = "id") => {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(db.from(t).select(cols)).order(order, { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...data); if (data.length < 1000) break;
  }
  return out;
};

export async function loadApplyBoard(db: SupabaseClient): Promise<ApplyBoard> {
  // Applications first, because everything else is scoped to them.
  //
  // This used to fetch the ENTIRE jobs table and the entire candidacy
  // table and filter in memory: 19,000 jobs paged in twenty round trips,
  // six seconds, to render sixty applications. The board only ever needs
  // the jobs those applications reference, so the rest is scoped to that
  // set and the page loads in milliseconds. is_test is filtered in the
  // query so a rehearsal never becomes a card.
  const apps = await page(db, "applications",
    "id,job_id,job_version_id,status,human_approved,human_approved_at,all_fields_confident," +
    "submitted_at,confirmation_email_received,confirmation_reference,blocked_reason," +
    "approved_artifact_sha256,approved_answers_sha256,resume_id,is_test," +
    "submit_requested_at,submit_started_at,submit_outcome,prepare_started_at",
    (q) => q.or("is_test.is.null,is_test.eq.false"));
  const jobIds = [...new Set(apps.map((a) => a.job_id).filter(Boolean))];
  const versionIds = [...new Set(apps.map((a) => a.job_version_id).filter(Boolean))];
  const appIds = apps.map((a) => a.id);
  const scopedIn = (col: string, ids: string[]) => (q: any) => q.in(col, ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);

  const [jobs, answers, candidacy, versions, profileRow, matchScores] = await Promise.all([
    page(db, "jobs", "id,title,company_id,source,status,eligibility,canonical_opening_id,application_form_url,url",
      scopedIn("id", jobIds)),
    page(db, "application_answers", "application_id,confidence_state,is_required,answer_text,field_key",
      scopedIn("application_id", appIds)),
    page(db, "job_candidacy",
      "job_id,verdict,created_at,profile_version,formula_version,taxonomy_version,model_version,reason_codes,hard_met,hard_total",
      scopedIn("job_id", jobIds), "job_id"),
    versionIds.length ? page(db, "job_versions", "id,is_current", scopedIn("id", versionIds)) : Promise.resolve([]),
    db.from("profile").select("profile_version").single(),
    loadMatchScores(db, jobIds),
  ]);
  const companyIds = [...new Set(jobs.map((j) => j.company_id).filter(Boolean))];
  const companies = await page(db, "companies", "id,name", scopedIn("id", companyIds));
  const liveProfile = (profileRow as any)?.data ?? null;

  const jobById = new Map(jobs.map((j: any) => [j.id, j]));
  const nameById = new Map(companies.map((c: any) => [c.id, c.name]));
  const versionCurrent = new Map(versions.map((v: any) => [v.id, v.is_current]));

  // The CURRENT verdict, not the newest row.
  //
  // This took whichever row sorted last by created_at, across every
  // profile and model version, which is the same defect that had the
  // application worker acting on 1,004 stale verdicts. A row written
  // under profile v12 or model 3 is history; it is not what the system
  // believes now.
  //
  // A job whose eligibility has since changed is a second kind of stale.
  // Its verdict was computed while the job was eligible and remains true
  // of that moment, but it is not an actionable candidacy today: a job
  // below the salary floor is not a candidate whatever Model 4 last
  // concluded. Those are surfaced as historical, never as current.
  const versionsNow = {
    profileVersion: liveProfile?.profile_version ?? -1,
    formulaVersion: FIT_FORMULA_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    modelVersion: CANDIDACY_MODEL_VERSION,
  };
  const eligibilityOf = new Map(jobs.map((j: any) => [j.id, j.eligibility]));
  const currentByJob = authoritativeCandidacy(candidacy as any, versionsNow);

  const latestVerdict = new Map<string, { verdict: string; at: string; current: boolean; reasonCode: string | null; hardMet: number | null; hardTotal: number | null }>();
  for (const c of candidacy.sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)))) {
    const isAuthoritative = currentByJob.get(c.job_id) === c.verdict
      && c.profile_version === versionsNow.profileVersion
      && c.model_version === versionsNow.modelVersion;
    const jobStillEligible = eligibilityOf.get(c.job_id) === "ELIGIBLE";
    latestVerdict.set(c.job_id, {
      verdict: c.verdict, at: c.created_at,
      current: isAuthoritative && jobStillEligible,
      reasonCode: (c as any).reason_codes?.[0] ?? null,
      hardMet: (c as any).hard_met ?? null, hardTotal: (c as any).hard_total ?? null,
    });
  }

  const byApp = new Map<string, any[]>();
  for (const a of answers) {
    const arr = byApp.get(a.application_id) ?? [];
    arr.push(a); byApp.set(a.application_id, arr);
  }

  const submittedOpenings = new Set<string>();
  for (const a of apps) {
    if (!a.submitted_at) continue;
    const j = jobById.get(a.job_id);
    if (j?.canonical_opening_id) submittedOpenings.add(j.canonical_opening_id);
  }

  // Reconcile a status that no longer matches its answers.
  //
  // BLOCKED_NEEDS_INPUT with nothing blocked is a cached summary that
  // fell behind, usually because the request that resolved the last
  // answer did not complete its follow-up write. Correcting it here uses
  // the ordinary transition, so the state machine and its audit trail
  // are unchanged; the alternative is a count that reports work nobody
  // can do.
  for (const a of apps) {
    if (a.submitted_at) continue;
    const blocked = (byApp.get(a.id) ?? []).filter((x) => x.confidence_state === "BLOCKED").length;
    const shouldBe = staleBlockedStatus(a.status, blocked, isEmployerFormHandoff(a.blocked_reason));
    if (!shouldBe) continue;
    const { error } = await db.from("applications").update({ status: shouldBe }).eq("id", a.id);
    if (!error) a.status = shouldBe;
  }

  const board: ApplyBoard = {
    needsYou: [], preparing: [], ready: [], recentlySubmitted: [], closed: [],
    blocked: { blockedFields: 0, answersNeeded: 0, handoffs: 0, applications: 0 },
  };

  for (const a of apps) {
    const j = jobById.get(a.job_id);
    if (!j) continue;
    const mine = byApp.get(a.id) ?? [];
    const blockedAnswers = mine.filter((x) => x.confidence_state === "BLOCKED").length;
    const verdict = latestVerdict.get(a.job_id) ?? null;

    // The same guard the submit path runs, so a row can never offer
    // Submit on an approval the guard would refuse.
    const refusals = a.submitted_at ? [] : revalidateBeforeSubmit({
      applicationId: a.id,
      jobStatus: j.status,
      eligibility: j.eligibility,
      // Null when the verdict is not current: a stale row must not be
      // able to read as an active candidacy anywhere downstream.
      candidacyVerdict: verdict?.current ? verdict.verdict : null,
      candidacyComputedAt: verdict?.current ? verdict.at : null,
      candidacyReasonCode: verdict?.current ? verdict.reasonCode : null,
      hardMet: verdict?.current ? verdict.hardMet : null,
      hardTotal: verdict?.current ? verdict.hardTotal : null,
      humanApproved: Boolean(a.human_approved),
      humanApprovedAt: a.human_approved_at ?? null,
      authorizationMode: null,
      allFieldsConfident: Boolean(a.all_fields_confident),
      blockedAnswers,
      requiredUnanswered: mine.filter((x) => x.is_required && !x.answer_text).length,
      jobVersionIsCurrent: Boolean(versionCurrent.get(a.job_version_id)),
      storedArtifactSha256: a.approved_artifact_sha256 ?? null,
      approvedArtifactSha256: a.approved_artifact_sha256 ?? null,
      otherSubmittedOnOpening: Boolean(
        j.canonical_opening_id && submittedOpenings.has(j.canonical_opening_id) && !a.submitted_at),
      currentAnswersSha256: answerSetHash(mine as any),
      approvedAnswersSha256: a.approved_answers_sha256 ?? null,
      readbackPassed: true,
    }).refusals.map((r) => r.code)
      // Refusals that only mean something once an approval exists.
      //
      // An application on its way to a first review has no approved
      // artifact yet, and saying so as though something had gone wrong
      // sent every freshly prepared application to "needs another look".
      // These conditions are what the reviewer is about to establish,
      // not evidence that anything is amiss.
      .filter((c) => !NOT_YET_APPROVED_NOISE.has(c) || Boolean(a.human_approved));

    const facts: ApplicationFacts = {
      status: a.status,
      humanApproved: Boolean(a.human_approved),
      allFieldsConfident: Boolean(a.all_fields_confident),
      blockedAnswers,
      // Zero is not coverage. See ApplicationFacts.discoveredFields.
      discoveredFields: mine.length,
      submittedAt: a.submitted_at ?? null,
      confirmationReceived: Boolean(a.confirmation_email_received || a.confirmation_reference),
      provider: j.source,
      refusals,
      handoff: isEmployerFormHandoff(a.blocked_reason),
      applyUrl: j.application_form_url ?? j.url ?? null,
      // The first line of the recorded reason, which prepare-handoff
      // writes as a provider-specific sentence.
      handoffReason: firstSentenceOf(a.blocked_reason),
      submitQueued: Boolean(a.submit_requested_at && !a.submit_started_at),
      submitRunning: Boolean(a.submit_requested_at && a.submit_started_at),
      submitOutcome: a.submit_outcome ?? null,
      // A worker holds a fresh prepare claim, or the row is mid-transition
      // in PREPARING: only then does the card read "Preparing". A DRAFT that
      // came back parked with a reason is surfaced, never left "Preparing".
      activelyPreparing: Boolean(a.prepare_started_at) || a.status === "PREPARING",
      blockedReason: a.blocked_reason ?? null,
    };

    const row: ApplyRow = {
      applicationId: a.id, jobId: a.job_id,
      company: nameById.get(j.company_id) ?? "Unknown",
      title: j.title, provider: j.source,
      submittedAt: a.submitted_at ?? null,
      match: matchScores.get(a.job_id) ?? null,
      presentation: present(facts, a.id),
    };

    switch (row.presentation.state) {
      case "NEEDS_YOU": board.needsYou.push(row); break;
      case "READY": board.ready.push(row); break;
      case "SUBMITTED": board.recentlySubmitted.push(row); break;
      case "CLOSED": board.closed.push(row); break;
      default: board.preparing.push(row);
    }
  }

  board.recentlySubmitted.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
  board.recentlySubmitted = board.recentlySubmitted.slice(0, 5);

  const groups = await loadBlockedGroups(db);
  board.blocked = summarize(groups);
  return board;
}

/**
 * The blocked questions across every live application, grouped.
 *
 * Options come from the application's own frozen form snapshot, so the
 * reader is offered exactly what the employer offered, and equivalence
 * is judged on those same options rather than on a label.
 */
export async function loadBlockedGroups(db: SupabaseClient): Promise<QuestionGroup[]> {
  // The blocked applications first; jobs and companies are scoped to
  // them rather than scanned whole, the same fix as the board above.
  const scopedIn = (col: string, ids: string[]) => (q: any) => q.in(col, ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  const apps = await page(db, "applications", "id,job_id,status,form_snapshot",
    (q) => q.eq("status", "BLOCKED_NEEDS_INPUT").or("is_test.is.null,is_test.eq.false"));
  const jobIds = [...new Set(apps.map((a) => a.job_id).filter(Boolean))];
  const appIds = apps.map((a) => a.id);
  const [jobs, blocked] = await Promise.all([
    page(db, "jobs", "id,title,company_id,url,application_form_url", scopedIn("id", jobIds)),
    page(db, "application_answers",
      "id,application_id,field_key,field_label,question_text,is_required,category,block_kind,blocked_reason",
      (q) => scopedIn("application_id", appIds)(q).eq("confidence_state", "BLOCKED")),
  ]);
  const companyIds = [...new Set(jobs.map((j) => j.company_id).filter(Boolean))];
  const companies = await page(db, "companies", "id,name", scopedIn("id", companyIds));
  const jobById = new Map(jobs.map((j: any) => [j.id, j]));
  const nameById = new Map(companies.map((c: any) => [c.id, c.name]));
  const appById = new Map(apps.map((a: any) => [a.id, a]));

  const fields: BlockedField[] = [];
  for (const b of blocked) {
    const app = appById.get(b.application_id);
    if (!app) continue;
    const job = jobById.get(app.job_id);
    const snapshot = (app.form_snapshot?.fields ?? []) as any[];
    const spec = snapshot.find((f) => f.key === b.field_key);
    fields.push({
      applicationId: b.application_id,
      applicationLabel: `${nameById.get(job?.company_id) ?? "Unknown"} — ${job?.title ?? ""}`,
      fieldKey: b.field_key,
      label: b.field_label ?? spec?.label ?? b.field_key,
      questionText: b.question_text ?? spec?.label ?? null,
      options: Array.isArray(spec?.options) ? spec.options : [],
      type: spec?.type ?? "text",
      required: Boolean(b.is_required),
      category: b.category ?? null,
      blockKind: b.block_kind ?? null,
      blockedReason: b.blocked_reason ?? null,
      // Where a file upload is actually completed: the employer's own form.
      // Same canonical target the board's handoff uses (form URL, else posting).
      applyUrl: job?.application_form_url ?? job?.url ?? null,
    });
  }
  return groupBlockedQuestions(fields);
}

/** The answer row ids behind one group, so the wizard can write them. */
export async function answerIdsFor(db: SupabaseClient, group: QuestionGroup): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const { data } = await db.from("application_answers")
    .select("id,application_id,field_key")
    .in("application_id", group.fields.map((f) => f.applicationId));
  for (const r of data ?? []) {
    const match = group.fields.find((f) => f.applicationId === r.application_id && f.fieldKey === r.field_key);
    if (match) ids.set(`${r.application_id}:${r.field_key}`, r.id);
  }
  return ids;
}
