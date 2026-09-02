/**
 * Ordering the Jobs feed by what deserves attention.
 *
 * PRESENTATION ONLY. Every input is a number Model 3 already computed
 * and stored; nothing here is recomputed, no verdict is consulted for
 * ranking, and nothing is written back. Formula 3 and Model 3 are
 * untouched, and a job's candidacy is exactly what it was.
 *
 * The problem this solves: 75% of actionable jobs meet zero substantive
 * hard requirements, and the previous sort ranked on credited-concept
 * count, which is dominated by generic matches like holding a bachelor's
 * degree. Jobs meeting five of nine stated requirements sorted below
 * jobs meeting none of one.
 *
 * The signal that separates them is hardDirect: how many SUBSTANTIVE
 * hard requirements are satisfied by DIRECT evidence. Samsara's Sales
 * Engineer and Stripe's Communities Partner role both score zero there,
 * while every job worth reading scores one or more.
 *
 * Deliberately NOT an input: the candidacy verdict. A Candidate does not
 * outrank a Stretch by label, only by evidence. The label is shown on
 * the card; it does not decide the order.
 */
import { assessCoverage } from "./genericRequirements.ts";

export type AttentionBand = "ASSESSABLE" | "GENERIC_REQUIREMENTS";

export interface AttentionInput {
  hardMet: number;
  hardTotal: number;
  /** Substantive hard requirements satisfied by DIRECT evidence. */
  hardDirect: number;
  transferableCount: number;
  /** Unmet occupational concepts, by name. */
  unmetConcepts: string[];
  /** Role-defining gaps. */
  coreGapCount: number;
  /** Highest stated salary, or null when the employer stated none. */
  salary: number | null;
}

export interface AttentionResult {
  band: AttentionBand;
  score: number;
  /** The plain ratio, for display. Null when the denominator was boilerplate. */
  coverage: number | null;
  /** The smoothed ratio the ranking actually used. */
  smoothedCoverage: number;
  genuineGaps: string[];
  ignoredRequirements: string[];
}

/**
 * Weights, and why each is where it is.
 *
 * Coverage dominates at 40: it is the only signal that speaks to what
 * the employer actually asked for. hardDirect at 10 per match (capped at
 * four) is the primary positive, and it is capped so a job cannot win on
 * volume alone. Transferable at 3 helps without overpowering coverage.
 * Genuine occupational gaps cost 6 each and role-defining gaps 12,
 * because the latter is a statement about the substance of the role.
 *
 * Salary is a modest positive ONLY when stated. An unstated salary
 * scores zero, which is neutral: 89% of these jobs state nothing, and
 * treating silence as a low number would bury almost the entire feed for
 * a fact nobody asserted.
 */
const W = {
  coverage: 40,
  /**
   * Pseudo-requirements added to the denominator before taking the
   * ratio: Laplace smoothing with a prior of two.
   *
   * Raw percentage let a job stating ONE requirement and meeting it
   * score the full 40, which is the strongest possible coverage signal
   * from the thinnest possible evidence. UChicago's Program Director
   * reached #2 that way with zero substantive requirements met by direct
   * evidence, above a Northern Trust role meeting five of nine.
   *
   * Smoothing asks the honest question: if there were two more
   * requirements we had not met, how confident would this look? 1/1
   * becomes 1/3, which is still clearly positive; 5/9 becomes 5/11 and
   * now wins. A compact posting stating three real requirements and
   * meeting all three still scores near the top, because the evidence is
   * genuinely there.
   *
   * The 1.5 restores the achievable range so the coverage term still
   * carries roughly its intended weight against the other signals.
   */
  coveragePrior: 2,
  coverageRescale: 1.5,
  hardDirect: 10, hardDirectCap: 4,
  transferable: 3, transferableCap: 3,
  occupationalGap: -6, occupationalGapCap: 3,
  coreGap: -12,
  salary130k: 8, salary100k: 6, salary85k: 3,
} as const;

/**
 * The one definition of what the ranking reads.
 *
 * The portal and any offline analysis must build inputs identically, or
 * a study of the ranking describes something the reader never sees. This
 * is the only place that decides which stored fields become which input,
 * and both callers go through it.
 */
export interface AttentionSources {
  /** job_candidacy row: hard_met, hard_total, transferable_matches, core_gaps. */
  candidacy: { hardMet: number; hardTotal: number; transferableMatches: number; coreGaps: number } | null;
  /** job_scores.fit_breakdown.conceptDetail. */
  conceptDetail: Array<{ concept?: string; hardness?: string; resolution?: string }>;
  /** Highest stated salary, or null. */
  salary: number | null;
}

/**
 * A credential that names a LEVEL but no FIELD.
 *
 * Excluded from hardDirect for the same reason candidacy treats it as
 * baseline: holding one discriminates nothing about the role.
 *
 * The first version required the text to END in "degree", so "bachelor
 * degree" was excluded and "bachelor degree in related field" was not.
 * Both come from the same employer sentence, and the matcher's own
 * rationale on each is "generic BACHELOR requirement met by a verified
 * degree at or above that level". "In related field" adds three words
 * and no field. That gap inflated 105 counts across the corpus and put
 * two UChicago roles into the top fifteen on nothing but a degree.
 *
 * The trailing qualifiers matter: "or equivalent", "or higher" and "in
 * a related field/discipline" all decline to name a field, so none of
 * them may rescue a credential. Anything that DOES name one - finance,
 * life sciences, computer science - is a real requirement and is left
 * alone, which the tests pin from both directions.
 */
const FIELDLESS_TAIL =
  String.raw`(\s+or\s+(equivalent|higher))?`
  + String.raw`(\s+in\s+(a\s+|an\s+)?related\s+(field|discipline))?`
  + String.raw`(\s+or\s+(equivalent|higher))?`;

export const BARE_DEGREE = new RegExp(
  String.raw`^(a\s+|an\s+)?(bachelor|master|associate|doctoral|high school)\b[^,]*?`
  + String.raw`(degree|diploma|ged)${FIELDLESS_TAIL}\s*$`
  + "|"
  + String.raw`^(a\s+|an\s+)?(degree|diploma)${FIELDLESS_TAIL}\s*$`
  + "|"
  + String.raw`^(a\s+|an\s+)?high school (diploma|degree)(\s+or\s+(ged|equivalent))?\s*$`,
  "i");

export function buildAttentionInput(src: AttentionSources): AttentionInput {
  const hard = src.conceptDetail.filter((c) => c.hardness === "HARD");
  return {
    hardMet: src.candidacy?.hardMet ?? 0,
    hardTotal: src.candidacy?.hardTotal ?? 0,
    hardDirect: hard.filter((c) =>
      c.resolution === "DIRECT" && !BARE_DEGREE.test(String(c.concept ?? "").trim())).length,
    transferableCount: src.candidacy?.transferableMatches ?? 0,
    unmetConcepts: hard.filter((c) => c.resolution === "ABSENT").map((c) => String(c.concept ?? "")),
    coreGapCount: src.candidacy?.coreGaps ?? 0,
    salary: src.salary,
  };
}

export function attentionScore(input: AttentionInput): AttentionResult {
  const cov = assessCoverage({
    hardMet: input.hardMet,
    hardTotal: input.hardTotal,
    unmetConcepts: input.unmetConcepts,
  });

  // Boilerplate is excluded from the gap penalty as well as from the
  // denominator, so a job is never charged twice for a requirement the
  // employer did not really state.
  const gaps = cov.genuineGaps.length;

  // Smoothed coverage. cov.ratio stays the honest unsmoothed number for
  // display; only the ranking contribution is smoothed.
  const smoothed = cov.assessable && input.hardTotal >= 0
    ? (input.hardMet / (input.hardTotal + W.coveragePrior))
    : 0;

  let score = 0;
  score += smoothed * W.coverage * W.coverageRescale;
  score += Math.min(input.hardDirect, W.hardDirectCap) * W.hardDirect;
  score += Math.min(input.transferableCount, W.transferableCap) * W.transferable;
  score += Math.min(gaps, W.occupationalGapCap) * W.occupationalGap;
  score += input.coreGapCount * W.coreGap;
  if (input.salary !== null) {
    score += input.salary >= 130_000 ? W.salary130k
      : input.salary >= 100_000 ? W.salary100k
      : input.salary >= 85_000 ? W.salary85k
      : 0;
  }

  return {
    band: cov.assessable ? "ASSESSABLE" : "GENERIC_REQUIREMENTS",
    score,
    coverage: cov.ratio,
    smoothedCoverage: smoothed,
    genuineGaps: cov.genuineGaps,
    ignoredRequirements: cov.ignored,
  };
}

/**
 * Band first, then score.
 *
 * Band 1 sits above Band 2 because a computed match is worth more than
 * an uncomputable one. Nothing is hidden: every job still appears, and a
 * Band 2 job says why it is there rather than looking arbitrarily
 * demoted.
 */
export function compareAttention(a: AttentionResult, b: AttentionResult): number {
  if (a.band !== b.band) return a.band === "ASSESSABLE" ? -1 : 1;
  return b.score - a.score;
}

export const BAND_LABEL: Record<AttentionBand, string> = {
  ASSESSABLE: "",
  GENERIC_REQUIREMENTS: "Requirements too generic to assess",
};

export const BAND_EXPLANATION: Record<AttentionBand, string> = {
  ASSESSABLE: "",
  GENERIC_REQUIREMENTS:
    "The employer's requirements are too generic to calculate a reliable match "
    + "percentage. This does not affect the underlying candidacy decision.",
};
