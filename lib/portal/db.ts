/**
 * Portal data access.
 *
 * Server-side only. The service-role key never reaches the browser, and
 * this module has no client entry point: every caller is a server
 * component or a server action.
 *
 * Reads the stored scores rather than recomputing. The portal shows what
 * the worker decided; if the two could disagree, the number on screen
 * would not be the number in the database.
 */
import { CANDIDACY_MODEL_VERSION } from "../scoring/candidacy.ts";
import { TAXONOMY_VERSION } from "../scoring/requirementClass.ts";
import { attentionScore, buildAttentionInput, type AttentionResult } from "./attentionRank.ts";
import { matchScore, type MatchScoreResult } from "./matchScore.ts";
import { ontologyDelta, withOntology, makeProfileHas } from "./matchScoreOntology.ts";
import { FIT_FORMULA_VERSION } from "../scoring/fit.ts";
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { present, factsFromRow, stateHref, STATE_LABEL, type PresentationState } from "./presentationState.ts";

/**
 * Every read here runs through a caller-supplied client bound to the
 * signed-in user, so RLS decides what comes back. This module holds no
 * client of its own and never reads the service-role key: nothing under
 * app/ may import a path that leads to it.
 */

/** PostgREST caps an unranged select at 1000 rows. Nothing here may forget that. */
export async function page<T = any>(
  db: SupabaseClient,
  table: string,
  columns: string,
  refine: (q: any) => any = (q) => q,
  orderBy = "id",
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await refine(db.from(table).select(columns))
      .order(orderBy, { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

/**
 * Match scores for an arbitrary set of jobs, keyed by job id.
 *
 * The same 0-100 read the Jobs page shows, computed from the same stored
 * fields through the same matchScore() function -- so a card on /apply
 * and the same job on /jobs never disagree. Used where the full JobCard
 * is not loaded (the Apply board, review).
 */
/**
 * The profile predicate the Match Score ontology (A + B1) resolves against.
 * Built from the live profile version's skill rows -- the same skills the
 * stored scores were computed against -- so the read-time ontology can never
 * credit a capability the profile does not actually hold.
 */
async function loadProfileHas(db: SupabaseClient): Promise<(n: string) => boolean> {
  const { data: p } = await db.from("profile").select("profile_version").single();
  const pv = p?.profile_version;
  if (pv == null) return () => false;
  const { data: rows } = await db.from("profile_version_rows")
    .select("row_data").eq("profile_version", pv).eq("source_table", "skills");
  return makeProfileHas((rows ?? []).map((r: any) => r.row_data?.name ?? ""));
}

export async function loadMatchScores(db: SupabaseClient, jobIds: string[]): Promise<Map<string, MatchScoreResult>> {
  const out = new Map<string, MatchScoreResult>();
  if (!jobIds.length) return out;
  const [allScores, cand, jobRows, profileHas] = await Promise.all([
    // Current scores only. Unfiltered, this pulled every historical score
    // row for these jobs -- 1,586 rows and 5.6MB of fit_breakdown for 62
    // jobs on the /apply board -- to keep about 62 of them.
    byIds<any>(db, "job_scores", "id,job_id,uncertainty_score,scorable,fit_breakdown,is_current", "job_id", jobIds,
      (q) => q.or("is_current.is.null,is_current.eq.true")),
    byIds<any>(db, "job_candidacy",
      "job_id,hard_met,hard_total,core_gaps,gating_gaps,unresolved_core,transferable_matches,created_at", "job_id", jobIds),
    byIds<any>(db, "jobs", "id,salary_min,salary_max,eligibility", "id", jobIds),
    loadProfileHas(db),
  ]);
  const scores = allScores.filter((s) => s.is_current !== false);
  const scoreByJob = new Map(scores.map((s) => [s.job_id, s]));
  const jobById = new Map(jobRows.map((j) => [j.id, j]));
  const candByJob = new Map<string, any>();
  for (const r of cand.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
    if (!candByJob.has(r.job_id)) candByJob.set(r.job_id, r);
  }
  const seniorityByScore = new Map<string, number>();
  const reasons = await byIds<any>(db, "score_reasons", "score_id,kind", "score_id", scores.map((s) => s.id));
  for (const r of reasons) {
    if (r.kind === "SENIORITY_MATCH") seniorityByScore.set(r.score_id, 1);
    else if (r.kind === "SENIORITY_MISMATCH") seniorityByScore.set(r.score_id, -1);
  }

  for (const jobId of jobIds) {
    const s = scoreByJob.get(jobId); const c = candByJob.get(jobId); const j = jobById.get(jobId);
    if (!s || !j) continue;
    const b = s.fit_breakdown ?? {};
    const ai = buildAttentionInput({
      candidacy: c ? { hardMet: c.hard_met, hardTotal: c.hard_total, transferableMatches: c.transferable_matches ?? 0, coreGaps: (c.core_gaps ?? []).length } : null,
      conceptDetail: b.conceptDetail ?? [], salary: j.salary_max ?? j.salary_min ?? null,
    });
    const sen = seniorityByScore.get(s.id) ?? 0;
    // A + B1 applied as a delta on the stored inputs; candidacy is untouched.
    const fit = withOntology(
      { hardMet: c?.hard_met ?? 0, hardTotal: c?.hard_total ?? 0, hardDirect: ai.hardDirect },
      ontologyDelta(b.conceptDetail ?? [], profileHas),
    );
    out.set(jobId, matchScore({
      hardMet: fit.hardMet, hardTotal: fit.hardTotal, hardDirect: fit.hardDirect,
      coverage: typeof b.coverage === "number" ? b.coverage : null,
      coreGaps: (c?.core_gaps ?? []).length, gatingGaps: (c?.gating_gaps ?? []).length,
      educationGatesUnmet: b.educationGatesUnmet ?? 0, unresolvedCore: (c?.unresolved_core ?? []).length,
      excludedUnknown: b.excludedUnknown ?? 0,
      seniorityAligned: sen > 0 ? true : sen < 0 ? false : null,
      salary: j.salary_max ?? j.salary_min ?? null, eligibility: j.eligibility,
      uncertaintyScore: s.uncertainty_score === null ? null : Number(s.uncertainty_score),
      scorable: s.scorable !== false, assessable: attentionScore(ai).band === "ASSESSABLE",
    }));
  }
  return out;
}

/**
 * The whole open universe in three honest numbers, so the Jobs page can
 * say what it is showing and what it is not.
 *
 * `ranked` is the count the page actually presents: jobs with a current
 * score. `awaiting` is every other open job that has not been ruled out
 * by a hard gate -- the extraction/eligibility backlog #269 works
 * through, which turns into ranked jobs as it clears. `excludedByGates`
 * is the open jobs a hard geography/eligibility gate already ruled out;
 * they are decided, not pending, and never enter the ranking.
 *
 * ranked is passed in (the caller already loaded exactly those cards, so
 * counting them again would be a second full scan); the rest are cheap
 * head-only counts.
 */
export async function loadUniverseCounts(
  db: SupabaseClient, rankedCount: number | PromiseLike<number>,
): Promise<{ openTotal: number; ranked: number; awaiting: number; excludedByGates: number }> {
  const count = async (refine: (q: any) => any): Promise<number> => {
    const { count: n } = await refine(db.from("jobs").select("id", { count: "exact", head: true }));
    return n ?? 0;
  };
  const [openTotal, excludedByGates, ranked] = await Promise.all([
    count((q) => q.eq("status", "OPEN")),
    count((q) => q.eq("status", "OPEN").eq("eligibility", "INELIGIBLE")),
    rankedCount,
  ]);
  // Open, not ranked yet, and not ruled out by a gate. Clamped because
  // the three counts are taken independently and a job can change state
  // between them; a small negative would only ever be rounding noise.
  const awaiting = Math.max(0, openTotal - ranked - excludedByGates);
  return { openTotal, ranked, awaiting, excludedByGates };
}

export interface ScoreReasonRow {
  dimension: string; kind: string; subject: string | null; detail: string | null; points: number;
}

export interface JobLocationRow {
  city: string | null; state: string | null; region: string | null; country: string | null;
  metro: string | null; is_remote: boolean; remote_scope: string | null;
  confidence: string; raw_segment: string; position: number;
}

export type CandidacyBadge = {
  verdict: "APPLICATION_CANDIDATE" | "STRETCH" | "REJECT" | "MANUAL_REVIEW";
  /**
   * The badge text. Presentation only: `verdict` above keeps the stored
   * value, and "NOT A CANDIDATE" is how REJECT is shown so the reader is
   * never told an employer rejected them by a model that decided not to
   * apply.
   */
  label: "CANDIDATE" | "STRETCH" | "NOT A CANDIDATE" | "REVIEW";
  reason: string;
  reasonCode: string;
  hardMet: number;
  hardTotal: number;
  /** Role-defining gaps, disqualifying credentials, unresolved core reqs, evidence counts. */
  coreGaps: number;
  gatingGaps: number;
  unresolvedCore: number;
  directMatches: number;
  transferableMatches: number;
  stale: boolean;
};

export interface JobCard {
  id: string;
  openingId: string;
  title: string;
  company: string;
  url: string | null;
  /** The ATS the posting was fetched from (jobs.source): where the system found it. */
  source: string;
  /** The employer's canonical apply link, a person's click-through when url is absent. */
  applyUrl: string | null;
  /** The posting's own lifecycle: OPEN, or a closed/removed state and when that was recorded. */
  status: string;
  statusChangedAt: string | null;
  postedAt: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  locationRaw: string | null;
  locations: JobLocationRow[];
  remotePolicy: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryPeriod: string | null;
  salaryIsEstimated: boolean;
  seniority: string | null;
  eligibility: string;
  eligibilityReason: string | null;

  /**
   * The candidacy DECISION, kept separate from the Fit SCORE.
   *
   * Null when candidacy has never been assessed, or when the stored
   * verdict was computed against a different profile or formula. A stale
   * verdict is not shown as current: it describes a different state.
   */
  candidacy: CandidacyBadge | null;

  fit: number;
  opportunity: number | null;
  generalist: number | null;
  specialist: number | null;
  uncertainty: number | null;
  recommendation: string | null;
  scorable: boolean;
  profileVersion: number;
  weightsVersion: number;
  fitFormulaVersion: number;

  /** Fit decomposed, so a rank can be argued with. */
  coveragePoints: number;
  titleMatchPoints: number;
  seniorityPoints: number;
  gatePenaltyPoints: number;
  otherPoints: number;

  directConcepts: string[];
  transferableConcepts: string[];
  absentConcepts: string[];
  gaps: string[];
  coverage: number | null;
  creditedCount: number;
  /**
   * Substantive hard requirements satisfied by DIRECT evidence.
   *
   * Read from the stored breakdown, not recomputed. Bare degrees are
   * excluded because "bachelor degree" satisfied by holding one says
   * nothing about whether the job is a fit, and counting it let jobs
   * with no real match outrank jobs with several.
   */
  hardDirect: number;
  attention: AttentionResult;
  /**
   * The human-readable 0-100 Match Score (display/decision-support only).
   * Derived from stored authoritative fields; never the raw fit_score.
   */
  match: MatchScoreResult;
  evaluableCount: number;
  excludedUnknown: number;
  credentialFamiliesUnmet: string[];
  educationGatesUnmet: number;

  /**
   * UNDECIDED is a withdrawn decision, kept because clearing is an UPDATE
   * rather than a DELETE. It means the same thing to the UI as no row at
   * all, and `activeInterest` is the value everything should read.
   */
  interest: "SAVED" | "NOT_INTERESTED" | "UNDECIDED" | null;
  activeInterest: "SAVED" | "NOT_INTERESTED" | null;

  /**
   * The status of an application against this OPENING, not this job row.
   *
   * prepare.ts and the worker both already refuse a second application
   * for an opening one exists on, so nothing could be applied to twice.
   * Nothing told the reader, though: a Stripe role submitted on
   * 2026-09-01 kept appearing in ranked opportunity lists as if it were
   * fresh, and the duplicate was only caught when preparation refused
   * it. Dedup that works but is invisible wastes the reader's attention.
   *
   * Null means no application exists for the opening.
   */
  applicationStatus: string | null;
  /** The live application's id, so a card can lead to its review. */
  applicationId: string | null;
  /**
   * The application's human state, by the same rules the Applications page
   * uses (presentationState), with where a click should go. Live, never
   * stored; null when no application exists for the opening.
   */
  applicationState: { state: PresentationState; label: string; href: string } | null;
  variantCount: number;
}

const GATE_KINDS = new Set(["HARD_REQUIREMENT_MISSING"]);

/** PostgREST rejects an .in() with hundreds of uuids: the URL overflows
 *  the request header. Batched and issued together. */
/**
 * Rows for a set of ids, batched so the URL stays short. Each batch is
 * paged too: PostgREST caps an unranged select at 1,000 rows and returns
 * the cap silently, and 120 current scores own about 1,140 score_reasons
 * rows -- so the unpaged version dropped roughly one reason row in eleven,
 * a different set on each load, and Match Scores drifted between page
 * views. Order is (column, id) so paging is stable across non-unique keys.
 */
async function byIds<T>(
  db: SupabaseClient, table: string, columns: string, column: string, ids: string[],
  refine: (q: any) => any = (q) => q, size = 120,
): Promise<T[]> {
  const batch = async (slice: string[]): Promise<T[]> => {
    const rows: T[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await refine(db.from(table).select(columns).in(column, slice))
        .order(column, { ascending: true }).order("id", { ascending: true }).range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      rows.push(...((data ?? []) as T[]));
      if ((data ?? []).length < 1000) return rows;
    }
  };
  const batches = await Promise.all(
    Array.from({ length: Math.ceil(ids.length / size) }, (_, i) => batch(ids.slice(i * size, i * size + size))),
  );
  return batches.flat();
}

/**
 * One page of the portal was making about 25 sequential PostgREST round
 * trips and taking 13 seconds. These reads do not depend on each other,
 * so they are issued together, and the three that are keyed by score or
 * job id wait only for the id list rather than for a full table scan.
 */
export async function loadJobCards(db: SupabaseClient): Promise<JobCard[]> {
  const [scores, openingCounts, companiesRes, interestsRes, appsRes] = await Promise.all([
    page<any>(db,
      "job_scores",
      "id,job_id,fit_score,opportunity_score,generalist_score,specialist_score,uncertainty_score," +
        "recommendation,scorable,profile_version,weights_version,fit_formula_version,fit_breakdown,is_current",
      (q: any) => q.eq("is_current", true),
    ),
    // Two columns over every open job, purely to count published variants
    // per opening. Cheap, and it keeps the heavy job read scoped below.
    page<any>(db, "jobs", "id,canonical_opening_id", (q: any) => q.eq("status", "OPEN")),
    // Paged. An unranged select caps at 1000 rows, and the corpus passed
    // that the moment discovery started adding companies: every company
    // beyond row 1000 rendered as "unknown" on its own job cards.
    page<any>(db, "companies", "id,name"),
    db.from("job_interest").select("canonical_opening_id,state"),
    db.from("applications").select("job_id,status,submitted_at"),
  ]);
  if (scores.length === 0) return [];

  const jobIds = scores.map((s) => s.job_id as string);
  const scoreIds = scores.map((s) => s.id as string);

  const [reasons, jobs, locations] = await Promise.all([
    byIds<any>(db, "score_reasons", "score_id,dimension,kind,subject,detail,points", "score_id", scoreIds),
    byIds<any>(db, "jobs",
      "id,company_id,title,url,apply_url,source,posted_at,first_seen_at,last_seen_at,location_raw,remote_policy," +
      "salary_min,salary_max,salary_period,salary_is_estimated,seniority,eligibility,eligibility_reason," +
      "canonical_opening_id,status,status_changed_at", "id", jobIds),
    byIds<any>(db, "job_locations",
      "job_id,city,state,region,country,metro,is_remote,remote_scope,confidence,raw_segment,position",
      "job_id", jobIds),
  ]);

  const reasonsByScore = new Map<string, ScoreReasonRow[]>();
  for (const r of reasons) {
    const a = reasonsByScore.get(r.score_id) ?? [];
    a.push(r); reasonsByScore.set(r.score_id, a);
  }

  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const variantCounts = new Map<string, number>();
  for (const j of openingCounts) variantCounts.set(j.canonical_opening_id, (variantCounts.get(j.canonical_opening_id) ?? 0) + 1);

  const companyName = new Map(companiesRes.map((c: any) => [c.id, c.name as string]));

  const locsByJob = new Map<string, JobLocationRow[]>();
  for (const l of locations) {
    const a = locsByJob.get(l.job_id) ?? [];
    a.push(l); locsByJob.set(l.job_id, a);
  }
  for (const a of locsByJob.values()) a.sort((x, y) => x.position - y.position);

  const interestByOpening = new Map((interestsRes.data ?? []).map((i: any) => [i.canonical_opening_id, i.state]));

  // Keyed by opening, matching how prepare and the worker deduplicate.
  // A submitted application wins over a draft one, so a reposted job
  // never reads as merely "in progress" when it has already been sent.
  const appliedByOpening = new Map<string, string>();
  for (const a of (appsRes.data ?? []) as any[]) {
    const j = jobById.get(a.job_id);
    const opening = j?.canonical_opening_id;
    if (!opening) continue;
    const prior = appliedByOpening.get(opening);
    if (!prior || a.submitted_at) appliedByOpening.set(opening, a.status);
  }

  // Candidacy, joined the same way scores are. A verdict computed
  // against a different profile, formula, taxonomy or model is marked
  // stale rather than shown as current: it is not wrong, it is about a
  // different state, and the queue must not present it as an answer.
  const { data: liveProfile } = await db.from("profile").select("profile_version").single();
  const candidacyRows = await byIds<any>(db, "job_candidacy",
    "job_id,verdict,reason,reason_codes,hard_met,hard_total,core_gaps,gating_gaps,unresolved_core,"
      + "direct_matches,transferable_matches,profile_version,formula_version,taxonomy_version,model_version,created_at",
    "job_id", jobs.map((j: any) => j.id)).catch(() => [] as any[]);
  // "REJECT" is the stored verdict and stays that way everywhere below
  // the presentation layer. The reader sees "NOT A CANDIDATE": no
  // employer has rejected anything here, and a badge saying REJECT on a
  // job nobody has applied to reads as though one had.
    const BADGE = { APPLICATION_CANDIDATE: "CANDIDATE", STRETCH: "STRETCH", REJECT: "NOT A CANDIDATE", MANUAL_REVIEW: "REVIEW" } as const;
  const candidacyByJob = new Map<string, CandidacyBadge>();
  for (const r of candidacyRows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
    if (candidacyByJob.has(r.job_id)) continue;
    candidacyByJob.set(r.job_id, {
      verdict: r.verdict, label: BADGE[r.verdict as keyof typeof BADGE] ?? "REVIEW",
      reason: r.reason, reasonCode: (r.reason_codes ?? [])[0] ?? "",
      hardMet: r.hard_met, hardTotal: r.hard_total,
      coreGaps: (r.core_gaps ?? []).length, gatingGaps: (r.gating_gaps ?? []).length,
      unresolvedCore: (r.unresolved_core ?? []).length,
      directMatches: r.direct_matches ?? 0, transferableMatches: r.transferable_matches ?? 0,
      stale: r.profile_version !== liveProfile?.profile_version
        || r.formula_version !== FIT_FORMULA_VERSION || r.taxonomy_version !== TAXONOMY_VERSION
        || r.model_version !== CANDIDACY_MODEL_VERSION,
    });
  }

  const profileHas = await loadProfileHas(db);
  const cards: JobCard[] = [];
  for (const s of scores) {
    const j = jobById.get(s.job_id);
    if (!j || j.status !== "OPEN") continue;
    const rs = reasonsByScore.get(s.id) ?? [];
    const fitReasons = rs.filter((r) => r.dimension === "FIT");

    const sum = (pred: (r: ScoreReasonRow) => boolean) =>
      fitReasons.filter(pred).reduce((n, r) => n + Number(r.points), 0);

    const coveragePoints = sum((r) => r.kind === "SKILL_MATCH");
    const titleMatchPoints = sum((r) => r.kind === "TITLE_MATCH");
    const seniorityPoints = sum((r) => r.kind === "SENIORITY_MATCH" || r.kind === "SENIORITY_MISMATCH");
    const gatePenaltyPoints = sum((r) => GATE_KINDS.has(r.kind));
    const otherPoints =
      Number(s.fit_score) - coveragePoints - titleMatchPoints - seniorityPoints - gatePenaltyPoints;

    // The stored breakdown, not a recomputation. A portal that recomputed
    // could show a number that disagrees with the row beside it.
    const b = s.fit_breakdown ?? {};
    const directConcepts: string[] = b.direct ?? [];
    const transferableConcepts: string[] = b.transferable ?? [];
    const absentConcepts: string[] = b.absent ?? [];
    const gaps = [
      ...fitReasons.filter((r) => GATE_KINDS.has(r.kind))
        .map((r) => `${r.subject ?? "requirement"}: ${r.detail ?? ""}`.trim()),
      ...absentConcepts.slice(0, 6),
    ];

    // Built through the shared constructor so the portal and any
    // offline analysis of the ranking read the same fields.
    const cand = candidacyByJob.get(j.id) ?? null;
    const attentionInput = buildAttentionInput({
      candidacy: cand ? {
        hardMet: cand.hardMet, hardTotal: cand.hardTotal,
        transferableMatches: transferableConcepts.length,
        coreGaps: 0,
      } : null,
      conceptDetail: (b.conceptDetail ?? []) as any[],
      salary: j.salary_max ?? j.salary_min ?? null,
    });
    const hardDirect = attentionInput.hardDirect;
    const attention = attentionScore(attentionInput);
    // A + B1 applied as a delta on the stored inputs; candidacy is untouched.
    const fit = withOntology(
      { hardMet: cand?.hardMet ?? 0, hardTotal: cand?.hardTotal ?? 0, hardDirect },
      ontologyDelta(b.conceptDetail ?? [], profileHas),
    );

    cards.push({
      id: j.id,
      openingId: j.canonical_opening_id,
      title: j.title,
      company: companyName.get(j.company_id) ?? "unknown",
      url: j.url,
      source: j.source,
      applyUrl: j.apply_url ?? null,
      status: j.status,
      statusChangedAt: j.status_changed_at ?? null,
      postedAt: j.posted_at,
      firstSeenAt: j.first_seen_at,
      lastSeenAt: j.last_seen_at,
      locationRaw: j.location_raw,
      locations: locsByJob.get(j.id) ?? [],
      remotePolicy: j.remote_policy,
      salaryMin: j.salary_min,
      salaryMax: j.salary_max,
      salaryPeriod: j.salary_period,
      salaryIsEstimated: j.salary_is_estimated,
      seniority: j.seniority,
      eligibility: j.eligibility,
      eligibilityReason: j.eligibility_reason,
      candidacy: candidacyByJob.get(j.id) ?? null,
      fit: Number(s.fit_score),
      opportunity: s.opportunity_score === null ? null : Number(s.opportunity_score),
      generalist: s.generalist_score === null ? null : Number(s.generalist_score),
      specialist: s.specialist_score === null ? null : Number(s.specialist_score),
      uncertainty: s.uncertainty_score === null ? null : Number(s.uncertainty_score),
      recommendation: s.recommendation,
      scorable: s.scorable !== false,
      profileVersion: s.profile_version,
      weightsVersion: s.weights_version,
      fitFormulaVersion: s.fit_formula_version,
      coveragePoints, titleMatchPoints, seniorityPoints, gatePenaltyPoints, otherPoints,
      directConcepts, transferableConcepts, absentConcepts, gaps,
      coverage: typeof b.coverage === "number" ? b.coverage : null,
      creditedCount: b.creditedConcepts ?? directConcepts.length + transferableConcepts.length,
      hardDirect,
      attention,
      match: matchScore({
        hardMet: fit.hardMet, hardTotal: fit.hardTotal, hardDirect: fit.hardDirect,
        coverage: typeof b.coverage === "number" ? b.coverage : null,
        coreGaps: cand?.coreGaps ?? 0,
        gatingGaps: cand?.gatingGaps ?? (b.credentialFamiliesUnmet ?? []).length,
        educationGatesUnmet: b.educationGatesUnmet ?? 0,
        unresolvedCore: cand?.unresolvedCore ?? 0,
        excludedUnknown: b.excludedUnknown ?? 0,
        seniorityAligned: seniorityPoints > 0 ? true : seniorityPoints < 0 ? false : null,
        salary: j.salary_max ?? j.salary_min ?? null,
        eligibility: j.eligibility,
        uncertaintyScore: s.uncertainty_score === null ? null : Number(s.uncertainty_score),
        scorable: s.scorable !== false,
        assessable: attention.band === "ASSESSABLE",
      }),
      evaluableCount: b.evaluableConcepts ?? 0,
      excludedUnknown: b.excludedUnknown ?? 0,
      credentialFamiliesUnmet: b.credentialFamiliesUnmet ?? [],
      educationGatesUnmet: b.educationGatesUnmet ?? 0,
      interest: interestByOpening.get(j.canonical_opening_id) ?? null,
      applicationStatus: appliedByOpening.get(j.canonical_opening_id) ?? null,
      applicationId: null,
      activeInterest: (() => {
        const v = interestByOpening.get(j.canonical_opening_id) ?? null;
        return v === "SAVED" || v === "NOT_INTERESTED" ? v : null;
      })(),
      applicationState: null,
      variantCount: variantCounts.get(j.canonical_opening_id) ?? 1,
    });
  }
  return cards;
}

// ---------------------------------------------------------------------------
// The precomputed list: job_card_summary.
//
// loadJobCards() above is the authoritative card build and now runs in the
// pipeline (scripts/materialize-job-cards.ts), not per request. The portal
// reads the result through the two functions below: one bounded, indexed,
// sorted, paginated query for the list, one row (plus tiny rank counts) for
// a detail page. User state -- interest and application status -- is never
// stored in the summary; it is overlaid live from its small source tables so
// a save or a submission shows immediately.
// ---------------------------------------------------------------------------

export type InterestTab = "active" | "saved" | "dismissed" | "all";

export interface JobCardPage {
  /** This page, in rank order, with interest/application state overlaid. */
  cards: JobCard[];
  /** Rows matching the tab + search across every page. */
  total: number;
  /** Every currently ranked job, regardless of tab. What "ranked for you" reports. */
  ranked: number;
  page: number;
  pageCount: number;
  perPage: number;
  startIndex: number;
}

/** Live user state, keyed by opening, from the two small tables that carry it. */
async function loadOverlays(db: SupabaseClient) {
  const [interestRes, appsRes, policyRes] = await Promise.all([
    db.from("job_interest").select("canonical_opening_id,state"),
    // Same read loadJobCards makes: a submitted application wins over a
    // draft one for the same opening, so a repost never reads as "in
    // progress" once it has been sent. The columns the presentation rules
    // read ride along, so a card can say "Needs you" with the same meaning
    // the Applications page gives it.
    db.from("applications")
      .select("id,job_id,status,submitted_at,canonical_opening_id,human_approved,all_fields_confident,"
        + "confirmation_email_received,confirmation_reference,submit_requested_at,submit_started_at,submit_not_before,"
        + "submit_outcome,blocked_reason,prepare_started_at")
      .or("is_test.is.null,is_test.eq.false"),
    db.from("ats_policy").select("provider,paused,capability"),
  ]);
  const interestByOpening = new Map<string, string>();
  for (const i of (interestRes.data ?? []) as any[]) interestByOpening.set(i.canonical_opening_id, i.state);
  const applicationByOpening = new Map<string, any>();
  for (const a of (appsRes.data ?? []) as any[]) {
    if (!a.canonical_opening_id) continue;
    const prior = applicationByOpening.get(a.canonical_opening_id);
    if (!prior || a.submitted_at) applicationByOpening.set(a.canonical_opening_id, a);
  }
  const policyByProvider = new Map(((policyRes.data ?? []) as any[]).map((p) => [p.provider, p]));
  return { interestByOpening, applicationByOpening, policyByProvider };
}

function overlay(card: JobCard, o: Awaited<ReturnType<typeof loadOverlays>>): JobCard {
  const v = o.interestByOpening.get(card.openingId) ?? null;
  const app = o.applicationByOpening.get(card.openingId) ?? null;
  let applicationState: JobCard["applicationState"] = null;
  if (app) {
    // The blocked-answer count is not loaded here; BLOCKED_NEEDS_INPUT
    // carries the same meaning by status alone.
    const p = present(factsFromRow(app, card.source, o.policyByProvider.get(card.source),
      { blockedAnswers: app.status === "BLOCKED_NEEDS_INPUT" ? 1 : 0, applyUrl: card.applyUrl ?? card.url }), app.id);
    applicationState = { state: p.state, label: STATE_LABEL[p.state], href: stateHref(p, app.id) };
  }
  return {
    ...card,
    interest: (v as JobCard["interest"]) ?? null,
    activeInterest: v === "SAVED" || v === "NOT_INTERESTED" ? v : null,
    applicationStatus: app?.status ?? null,
    applicationId: app?.id ?? null,
    applicationState,
  };
}

/** PostgREST `in` lists are comma-separated inside parentheses. */
const inList = (ids: string[]) => `(${ids.join(",")})`;

/**
 * One page of the Jobs list.
 *
 * Mirrors applyFilters()+sortCards("match") exactly, in SQL: the actionable
 * gate (candidacy REJECT hidden, unassessed kept visible), the interest tab,
 * the title/company search, and the Match Score ordering. The parity
 * selftest (scripts/portal-card-summary-selftest.ts) holds the two paths
 * to the same ordered ids.
 */
export async function loadJobCardPage(
  db: SupabaseClient,
  opts: { interest: InterestTab; q: string; page: number; perPage?: number },
): Promise<JobCardPage> {
  const perPage = opts.perPage ?? 50;
  const overlays = await loadOverlays(db);

  const saved: string[] = [], dismissed: string[] = [];
  for (const [opening, state] of overlays.interestByOpening) {
    if (state === "SAVED") saved.push(opening);
    else if (state === "NOT_INTERESTED") dismissed.push(opening);
  }
  const withInterest = [...saved, ...dismissed];
  // An opening you have already applied to is finished business for this
  // page: it lives on Submitted. Excluded on every tab, so a repost of the
  // same requisition never reads as a fresh chance either.
  const submitted: string[] = [];
  for (const [opening, app] of overlays.applicationByOpening) if (app.submitted_at) submitted.push(opening);

  const empty = (ranked: number): JobCardPage =>
    ({ cards: [], total: 0, ranked, page: 1, pageCount: 1, perPage, startIndex: 0 });

  const rankedCount = db.from("job_card_summary").select("job_id", { count: "exact", head: true });

  // A tab whose interest set is empty has nothing to show; do not ask.
  if ((opts.interest === "saved" && saved.length === 0) || (opts.interest === "dismissed" && dismissed.length === 0)) {
    return empty((await rankedCount).count ?? 0);
  }

  // Commas and parentheses are PostgREST syntax inside an or-filter.
  const q = opts.q.replace(/[,()]/g, " ").trim();
  // Builders are mutable, so each request starts from a fresh one with
  // the same filters applied.
  const filtered = (select: string, head = false) => {
    let qb = db.from("job_card_summary").select(select, { count: "exact", head })
      // actionable: REJECT hidden; a job with no verdict stays visible.
      .or("candidacy_verdict.is.null,candidacy_verdict.neq.REJECT");
    if (submitted.length) qb = qb.not("opening_id", "in", inList(submitted));
    if (opts.interest === "active" && withInterest.length) qb = qb.not("opening_id", "in", inList(withInterest));
    if (opts.interest === "saved") qb = qb.in("opening_id", saved);
    if (opts.interest === "dismissed") qb = qb.in("opening_id", dismissed);
    if (q) qb = qb.or(`title.ilike.%${q}%,company.ilike.%${q}%`);
    return qb;
  };
  const pageOf = (from: number) => matchOrder(filtered("card")).range(from, from + perPage - 1);

  // The page is asked for with the filters applied, so the rank number is
  // the position in the full filtered ranking, not in the slice.
  const requested = Math.max(1, opts.page || 1);
  let [pageRes, ranked] = await Promise.all([pageOf((requested - 1) * perPage), rankedCount]);
  let total = pageRes.count ?? 0;
  // Asked past the end: PostgREST answers 416 rather than an empty page.
  // Count the filtered set, then read its last page instead of nothing.
  if (pageRes.error?.code === "PGRST103") {
    total = (await filtered("job_id", true)).count ?? 0;
    pageRes = await pageOf((Math.max(1, Math.ceil(total / perPage)) - 1) * perPage);
  }
  if (pageRes.error) throw new Error(`job_card_summary: ${pageRes.error.message}`);

  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(requested, pageCount);
  const rows = (pageRes.data ?? []) as any[];
  return {
    cards: rows.map((r) => overlay(r.card as JobCard, overlays)),
    total, ranked: ranked.count ?? 0, page, pageCount, perPage, startIndex: (page - 1) * perPage,
  };
}

/**
 * sortCards("match"), in SQL: Match Score desc, firm before provisional,
 * then compareAttention (assessable band first, attention score desc), then
 * stored Fit desc, then job id. The attention pair lives inside the card
 * json; PostgREST orders json paths natively (jsonb numbers compare as
 * numbers), and at ~1,600 rows the sort is not what costs anything.
 */
function matchOrder<T extends { order: (c: string, o: { ascending: boolean }) => T }>(qb: T): T {
  return qb.order("match_score", { ascending: false })
    .order("match_provisional", { ascending: true })
    .order("card->attention->>band", { ascending: true })
    .order("card->attention->score", { ascending: false })
    .order("fit_score", { ascending: false })
    .order("job_id", { ascending: true });
}

export interface JobCardDetail {
  card: JobCard;
  /** Other published variants of the same opening. */
  siblings: JobCard[];
  /** Position by Match Score among every ranked job, and how many there are. */
  matchRank: number;
  fitRank: number;
  evidenceRank: number;
  total: number;
}

/** One job for its detail page: its card, siblings, and rank-of-N counts. */
export async function loadJobCardById(db: SupabaseClient, jobId: string): Promise<JobCardDetail | null> {
  const { data: row, error } = await db.from("job_card_summary")
    .select("card,opening_id,match_score,fit_score,credited_count").eq("job_id", jobId).maybeSingle();
  if (error) throw new Error(`job_card_summary: ${error.message}`);
  if (!row) return null;

  const count = async (refine: (q: any) => any): Promise<number> =>
    (await refine(db.from("job_card_summary").select("job_id", { count: "exact", head: true }))).count ?? 0;

  // Rank = rows that sort strictly above this one, plus one -- under the
  // list's exact ordering (match desc, firm before provisional, fit desc,
  // job_id), so the number here is the position the list shows.
  const c = row.card as JobCard;
  const m = row.match_score, p = Boolean(c.match?.provisional), f = row.fit_score ?? 0;
  const band = c.attention?.band ?? "ASSESSABLE", att = c.attention?.score ?? 0;
  const tie = `match_score.eq.${m},match_provisional.eq.${p}`;
  const sameBand = `${tie},card->attention->>band.eq.${band}`;
  const above = [
    `match_score.gt.${m}`,
    ...(p ? [`and(match_score.eq.${m},match_provisional.eq.false)`] : []),
    ...(band !== "ASSESSABLE" ? [`and(${tie},card->attention->>band.eq.ASSESSABLE)`] : []),
    `and(${sameBand},card->attention->score.gt.${att})`,
    `and(${sameBand},card->attention->score.eq.${att},fit_score.gt.${f})`,
    `and(${sameBand},card->attention->score.eq.${att},fit_score.eq.${f},job_id.lt.${jobId})`,
  ].join(",");

  const [overlays, sibs, aboveMatch, total, aboveFit, aboveEvidence] = await Promise.all([
    loadOverlays(db),
    db.from("job_card_summary").select("card").eq("opening_id", row.opening_id).neq("job_id", jobId),
    count((q) => q.or(above)),
    count((q) => q),
    count((q) => q.gt("fit_score", row.fit_score ?? 0)),
    count((q) => q.gt("credited_count", row.credited_count ?? 0)),
  ]);

  return {
    card: overlay(row.card as JobCard, overlays),
    siblings: ((sibs.data ?? []) as any[]).map((s) => overlay(s.card as JobCard, overlays)),
    matchRank: aboveMatch + 1, fitRank: aboveFit + 1, evidenceRank: aboveEvidence + 1, total,
  };
}
