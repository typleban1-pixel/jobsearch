/**
 * Recognizing employer boilerplate that cannot be matched.
 *
 * PRESENTATION ONLY. Nothing here reads or writes a candidacy verdict, a
 * requirement row, or any stored classification. It exists so the Jobs
 * feed can order jobs sensibly, and its worst possible failure is a job
 * appearing in the wrong band. It must never be used to decide anything.
 *
 * The problem it addresses: 99 of 224 actionable jobs, all from one
 * employer's Workday template, state exactly one substantive hard
 * requirement and it reads "work experience in related field". That
 * names no field, so nothing can satisfy it, so those jobs report 0%
 * coverage forever. The 0% is an artifact of the wording, not a fact
 * about the applicant, and ranking on it buries jobs that may be
 * perfectly reasonable.
 *
 * Deliberately isolated in its own module, and deliberately narrow. It
 * is tuned to boilerplate actually observed in the corpus rather than
 * trying to be clever about generic-sounding text, because the cost of
 * over-matching is real: a genuine requirement dismissed as boilerplate
 * would flatter a job it should not. When in doubt it should NOT match.
 */

/**
 * Requirement text that states a demand without naming what it is for.
 *
 * "work experience in a related field" is the canonical case: it has the
 * grammar of a requirement and none of the content. Compare "work
 * experience in clinical research", which names a field and is a real
 * requirement this must never touch.
 */
const FIELDLESS_PATTERNS: RegExp[] = [
  // "work experience in a related field / discipline / job discipline"
  /^\s*(knowledge and skills developed through\s+)?[<>≤≥]?\s*\d*\+?\s*(years?\s+of\s+)?work experience in (a |an )?related (field|discipline|job discipline)\s*$/i,
  /^\s*related job discipline\s*$/i,
  /^\s*experience in (a |an )?related field\s*$/i,
  // Bare role-shaped nouns with no object, seen where extraction split a
  // sentence badly: "professional", "administrative".
  /^\s*(professional|administrative)\s*$/i,
];

/** Whether one requirement concept is unmatchable boilerplate. */
export function isFieldlessRequirement(concept: string): boolean {
  const t = String(concept ?? "").trim();
  if (!t) return false;
  return FIELDLESS_PATTERNS.some((re) => re.test(t));
}

export interface CoverageInput {
  /** Substantive hard requirements met, as Model 3 counted them. */
  hardMet: number;
  /** Substantive hard requirements total, as Model 3 counted them. */
  hardTotal: number;
  /** Unmet occupational concepts, by name. */
  unmetConcepts: string[];
}

export interface CoverageAssessment {
  /** False when the denominator is entirely boilerplate. */
  assessable: boolean;
  /** Coverage in 0..1, or null when not assessable. */
  ratio: number | null;
  /** Unmet concepts that are real requirements, boilerplate removed. */
  genuineGaps: string[];
  /** Boilerplate that was set aside, for explaining the band. */
  ignored: string[];
}

/**
 * Whether attention-coverage can be computed for a job.
 *
 * Only the case that actually occurs is treated as unassessable: nothing
 * met, and every unmet requirement is boilerplate. A job that meets some
 * of its requirements has a denominator worth trusting even if part of
 * it is generic, so it stays assessable and keeps its real ratio.
 *
 * The same boilerplate is removed from the gap list, because counting it
 * as a coverage failure AND as an occupational gap penalizes a job twice
 * for a requirement the employer never really made.
 */
export function assessCoverage(input: CoverageInput): CoverageAssessment {
  const ignored = input.unmetConcepts.filter(isFieldlessRequirement);
  const genuineGaps = input.unmetConcepts.filter((c) => !isFieldlessRequirement(c));

  const nothingMet = input.hardMet === 0 && input.hardTotal > 0;
  const allBoilerplate = input.unmetConcepts.length > 0 && genuineGaps.length === 0;

  if (nothingMet && allBoilerplate) {
    return { assessable: false, ratio: null, genuineGaps, ignored };
  }
  return {
    assessable: true,
    ratio: input.hardTotal > 0 ? input.hardMet / input.hardTotal : 0,
    genuineGaps,
    ignored,
  };
}
