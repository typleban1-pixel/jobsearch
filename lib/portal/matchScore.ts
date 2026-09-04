/**
 * A human-readable 0–100 Match Score.
 *
 * PRESENTATION / DECISION-SUPPORT ONLY. Every input is a number Model 3
 * (Formula 3) or Model 4 already computed and stored; nothing here is
 * recomputed, no verdict is changed, and nothing is written back. This is
 * a display layer, deliberately separate from the raw, signed, unbounded
 * `fit_score` (which is a ranking quantity, not a percentage, and must
 * never be shown as /100).
 *
 * What the number means: "how good is this opportunity for someone with
 * Ty's verified background?" 100 = essentially the perfect currently-known
 * opportunity — every role-defining requirement supported by direct
 * evidence, appropriate seniority, good geography, compensation aligned,
 * no meaningful gaps, low uncertainty.
 *
 * Design rules Ty set:
 * - Role-defining (hard) requirements dominate. Missing one matters far
 *   more than missing a minor preference.
 * - A genuine hard DISQUALIFIER (a required credential not held, an unmet
 *   education gate, pay below the hard floor) can crush/cap the score,
 *   because it actually affects job fit.
 * - Model 4 candidacy is NOT a numerical ceiling. A MANUAL_REVIEW job can
 *   still score high; candidacy is shown as its own badge. Unresolved /
 *   uncertain information lowers CONFIDENCE (marks the score provisional),
 *   it does not cap the value.
 */

export type MatchConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface MatchScoreInput {
  /** Discriminating role-defining hard requirements met (direct + transferable). */
  hardMet: number;
  /** Discriminating role-defining hard requirements total (baseline degrees excluded). */
  hardTotal: number;
  /** Substantive hard requirements met by DIRECT evidence (bare degrees excluded). */
  hardDirect: number;
  /** Posting-level coverage ratio 0..1 (smoothed), or null when unassessable. */
  coverage: number | null;
  /** Role-defining requirements that are unmet (job_candidacy.core_gaps). */
  coreGaps: number;
  /** Disqualifying credential families not held (job_candidacy.gating_gaps / credentialFamiliesUnmet). */
  gatingGaps: number;
  /** Education gates unmet (fit_breakdown.educationGatesUnmet). */
  educationGatesUnmet: number;
  /** Role-defining requirements left UNKNOWN rather than resolved (job_candidacy.unresolved_core). */
  unresolvedCore: number;
  /** Requirements that could not be evaluated (fit_breakdown.excludedUnknown). */
  excludedUnknown: number;
  /** true match, false mismatch, null when the posting states no seniority. */
  seniorityAligned: boolean | null;
  /** Highest stated salary, or null when the employer stated none. */
  salary: number | null;
  /** Hard eligibility for geography/legal: scored jobs are ELIGIBLE. */
  eligibility: "ELIGIBLE" | "UNCERTAIN" | "INELIGIBLE" | string | null;
  /** job_scores.uncertainty_score (unbounded), or null. */
  uncertaintyScore: number | null;
  /** job_scores.scorable. */
  scorable: boolean;
  /** attention band ASSESSABLE (requirements concrete enough to judge). */
  assessable: boolean;
}

export interface MatchScoreResult {
  score: number;
  provisional: boolean;
  confidence: MatchConfidence;
  /** One short reason, safe to show, when provisional or capped; else null. */
  note: string | null;
}

/** Ty's stored compensation bands. */
const SALARY_FLOOR = 85_000;
const SALARY_TARGET = 100_000;
const SALARY_IDEAL = 115_000;

/** Coverage tops out near 0.43 in practice (k=6 smoothing); rescale so a
 * genuinely well-covered posting reads as strong rather than ~15%. */
const COVERAGE_FULL = 0.30;
/** Uncertainty above this reads as "the evidence is thin", not a fact. */
const UNCERTAINTY_HIGH = 40;
/**
 * How much a transferable-only hard match counts against a direct one.
 * Direct is worth 1.0, transferable 0.5 — a two-to-one advantage, so a
 * job whose "matches" are mostly adjacent evidence cannot read as a
 * strong fit.
 */
const SOFT_CREDIT = 0.5;
/**
 * Evidence depth: how many role-defining requirements the posting states.
 * The score is the direct-weighted hard RATIO multiplied by
 * min(1, hardTotal / DEPTH_FULL). This is the whole reason a thin 1/1 or
 * 2/2 posting cannot score high on the flimsiest possible evidence — its
 * perfect ratio is discounted for depth — while a posting stating three
 * or more requirements is judged on its ratio alone. It deliberately does
 * NOT distort the ratio itself, so missing one of three still hurts far
 * more than missing one of ten (0.67 vs 0.90), exactly as it should.
 */
const DEPTH_FULL = 3;
/** Below this many stated hard requirements, the score is an estimate. */
const THIN_POSTING = 3;
/** Context can only ever nudge, and only in proportion to role fit. */
const SALARY_IDEAL_PTS = 4, SALARY_TARGET_PTS = 3, SALARY_OK_PTS = 1;
const SENIORITY_MATCH_PTS = 3, SENIORITY_MISMATCH_PTS = -5;
/** An unassessable posting can never read as a confident strong match. */
const UNASSESSABLE_CAP = 50;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** 0..1 pay alignment; null when unstated. Below the hard floor is 0. */
function salarySignal(salary: number | null): number | null {
  if (salary == null) return null;
  if (salary < SALARY_FLOOR) return 0;
  if (salary >= SALARY_IDEAL) return 1;
  if (salary >= SALARY_TARGET) return 0.8 + 0.2 * ((salary - SALARY_TARGET) / (SALARY_IDEAL - SALARY_TARGET));
  return 0.5 + 0.3 * ((salary - SALARY_FLOOR) / (SALARY_TARGET - SALARY_FLOOR));
}

function geographySignal(eligibility: MatchScoreInput["eligibility"]): number {
  return eligibility === "ELIGIBLE" ? 1 : eligibility === "INELIGIBLE" ? 0 : 0.5;
}

export function matchScore(input: MatchScoreInput): MatchScoreResult {
  const coverageSignal = input.coverage != null ? clamp01(input.coverage / COVERAGE_FULL) : null;
  const pay = salarySignal(input.salary);
  const assessableHard = input.hardTotal > 0 && input.scorable && input.assessable;

  // 1. Role-defining fit: the backbone. The direct-weighted hard RATIO
  //    (direct counts fully, transferable half), multiplied by an
  //    evidence-depth factor that discounts thin postings so a 1/1 or 2/2
  //    cannot buy a top score on the flimsiest evidence. The ratio itself
  //    is NOT distorted, so missing one of three (0.67) still hurts far
  //    more than missing one of ten (0.90). 90s require near-complete
  //    coverage; a job needs several role-defining reqs met by direct
  //    evidence to get there.
  let roleFit = 0;
  let base: number;
  if (assessableHard) {
    const direct = Math.min(input.hardDirect, input.hardTotal);
    const soft = Math.max(0, Math.min(input.hardMet, input.hardTotal) - direct);
    const ratio = clamp01((direct + SOFT_CREDIT * soft) / input.hardTotal);
    const depth = Math.min(1, input.hardTotal / DEPTH_FULL);
    roleFit = ratio * depth;
    base = 100 * roleFit;
  } else {
    // No discriminating hard requirements, or the posting can't be
    // assessed: we cannot claim a strong match. Lean on coverage, held
    // under a cap and always provisional.
    base = Math.min(UNASSESSABLE_CAP, 100 * 0.5 * (coverageSignal ?? 0));
  }

  // 2. Context nudges, scaled BY role fit so a high salary or seniority
  //    match can never compensate for a role-fit deficit — a weak-fit job
  //    earns almost nothing from context. Geography is a gate, not a
  //    match signal: every scored job is already eligible, so it earns no
  //    points and only bites if somehow not eligible.
  let bonus = 0;
  if (input.seniorityAligned === true) bonus += SENIORITY_MATCH_PTS;
  else if (input.seniorityAligned === false) bonus += SENIORITY_MISMATCH_PTS;
  if (pay != null && pay > 0) bonus += pay >= 1 ? SALARY_IDEAL_PTS : pay >= 0.8 ? SALARY_TARGET_PTS : SALARY_OK_PTS;
  let score = base + roleFit * bonus;
  const geo = geographySignal(input.eligibility);
  if (geo < 1) score -= (1 - geo) * 40; // only bites if not fully eligible

  // 3. Hard disqualifiers crush the score — they genuinely affect fit.
  let disqualified = false;
  if (input.gatingGaps > 0 || input.educationGatesUnmet > 0) { score = Math.min(score, 20); disqualified = true; }
  if (pay === 0) score = Math.min(score, 35); // below the hard floor

  score = Math.round(Math.max(0, Math.min(100, score)));

  // 5. Confidence, and whether to show the number as provisional. NONE of
  //    this caps the value — it governs how sure we are of it.
  const highUncertainty = input.uncertaintyScore != null && input.uncertaintyScore >= UNCERTAINTY_HIGH;
  const unassessable = !input.scorable || !input.assessable || input.hardTotal === 0;
  const thin = input.hardTotal > 0 && input.hardTotal < THIN_POSTING;
  const provisional = unassessable || thin || input.unresolvedCore > 0 || input.excludedUnknown > 0 || highUncertainty;
  const confidence: MatchConfidence = unassessable ? "LOW" : provisional ? "MEDIUM" : "HIGH";

  // 6. One honest line for why, most-decisive first.
  let note: string | null = null;
  if (disqualified) note = "missing a required credential";
  else if (pay === 0) note = "below your salary floor";
  else if (input.unresolvedCore > 0) note = `${input.unresolvedCore} important requirement${input.unresolvedCore > 1 ? "s" : ""} unresolved`;
  else if (!input.assessable || input.hardTotal === 0) note = "requirements too generic to score precisely";
  else if (input.excludedUnknown > 0) note = `${input.excludedUnknown} requirement${input.excludedUnknown > 1 ? "s" : ""} couldn't be evaluated`;
  else if (highUncertainty) note = "limited evidence, treat as an estimate";

  return { score, provisional, confidence, note };
}

/**
 * The single human-readable fit label, derived from the Match Score alone
 * so the number and the words always tell one coherent story. Bands are
 * ABSOLUTE descriptions of fit, matched to the calibration (which is
 * deliberately harsh: role-fit dominates and 100 means a perfect fit), not
 * relative to the current corpus -- so most jobs honestly read as weak.
 *
 * A provisional score is one the system is not confident enough to stand
 * behind (thin/unassessable/high-uncertainty). It never gets a confident
 * fit label; it reads "Needs more evaluation" while the numeric ~score is
 * still shown beside it. This does not change the Match Score itself.
 */
export function matchLabel(score: number, provisional: boolean): string {
  if (provisional) return "Needs more evaluation";
  if (score >= 90) return "Exceptional match";
  if (score >= 80) return "Very strong match";
  if (score >= 70) return "Strong match";
  if (score >= 60) return "Good match";
  if (score >= 50) return "Worth considering";
  return "Weak match";
}
