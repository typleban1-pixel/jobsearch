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
import { FIT_FORMULA_VERSION } from "../scoring/fit.ts";
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

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
  stale: boolean;
};

export interface JobCard {
  id: string;
  openingId: string;
  title: string;
  company: string;
  url: string | null;
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
  variantCount: number;
}

const GATE_KINDS = new Set(["HARD_REQUIREMENT_MISSING"]);

/** PostgREST rejects an .in() with hundreds of uuids: the URL overflows
 *  the request header. Batched and issued together. */
async function byIds<T>(db: SupabaseClient, table: string, columns: string, column: string, ids: string[], size = 120): Promise<T[]> {
  const batches = await Promise.all(
    Array.from({ length: Math.ceil(ids.length / size) }, (_, i) =>
      db.from(table).select(columns).in(column, ids.slice(i * size, i * size + size))),
  );
  const out: T[] = [];
  for (const b of batches) {
    if (b.error) throw new Error(`${table}: ${b.error.message}`);
    out.push(...((b.data ?? []) as T[]));
  }
  return out;
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
      "id,company_id,title,url,posted_at,first_seen_at,last_seen_at,location_raw,remote_policy," +
      "salary_min,salary_max,salary_period,salary_is_estimated,seniority,eligibility,eligibility_reason," +
      "canonical_opening_id,status", "id", jobIds),
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
    "job_id,verdict,reason,reason_codes,hard_met,hard_total,profile_version,formula_version,taxonomy_version,model_version,created_at",
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
      stale: r.profile_version !== liveProfile?.profile_version
        || r.formula_version !== FIT_FORMULA_VERSION || r.taxonomy_version !== TAXONOMY_VERSION
        || r.model_version !== CANDIDACY_MODEL_VERSION,
    });
  }

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

    cards.push({
      id: j.id,
      openingId: j.canonical_opening_id,
      title: j.title,
      company: companyName.get(j.company_id) ?? "unknown",
      url: j.url,
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
      evaluableCount: b.evaluableConcepts ?? 0,
      excludedUnknown: b.excludedUnknown ?? 0,
      credentialFamiliesUnmet: b.credentialFamiliesUnmet ?? [],
      educationGatesUnmet: b.educationGatesUnmet ?? 0,
      interest: interestByOpening.get(j.canonical_opening_id) ?? null,
      applicationStatus: appliedByOpening.get(j.canonical_opening_id) ?? null,
      activeInterest: (() => {
        const v = interestByOpening.get(j.canonical_opening_id) ?? null;
        return v === "SAVED" || v === "NOT_INTERESTED" ? v : null;
      })(),
      variantCount: variantCounts.get(j.canonical_opening_id) ?? 1,
    });
  }
  return cards;
}
