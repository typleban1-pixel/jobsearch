/**
 * Reading the resume the way an employer's software would.
 *
 * Every other check in this system asks whether the document is TRUE.
 * This one asks whether it COMMUNICATES, which is a different failure
 * and needs a different reader. A resume can be entirely honest, pass
 * every provenance guard, parse cleanly, and still be discarded because
 * the one paragraph that answers the posting's central demand sits
 * fourth in a list under a job title that gives no hint it is there.
 *
 * The evaluator therefore sees what an employer sees and nothing else.
 * It has no access to the evidence database, so it cannot tell the
 * difference between "he never did this" and "he did this and the
 * resume failed to say so". That distinction is made afterwards, by
 * code that can read the evidence, and it is the whole point: the first
 * case is a writing problem and the second is a fact.
 *
 * What the evaluator produces is an opinion. It can point at something
 * and say a recruiter would miss it. It cannot authorize a sentence.
 */

export const SCREENING_VERSION = 1;

/**
 * What a screening reader can conclude, and nothing beyond it.
 *
 * The list is closed. An evaluator returning a kind not on it is
 * rejected rather than accommodated, because a finding type nobody
 * designed a response to is a finding nobody can act on safely.
 */
export type FindingKind =
  | "REQUIREMENT_CLEARLY_SUPPORTED"
  | "REQUIREMENT_PARTIALLY_SUPPORTED"
  | "REQUIREMENT_UNSUPPORTED"
  | "CAPABILITY_BURIED"
  | "TERMINOLOGY_MISMATCH"
  | "CLAIM_TOO_VAGUE"
  | "CHRONOLOGY_CONFUSING"
  | "STRONGEST_EVIDENCE_UNDEREMPHASIZED"
  | "IRRELEVANT_MATERIAL_DOMINATES"
  | "PRESENTATION_RISK";

/** Findings that might be fixable by writing, if the evidence exists. */
export const COMMUNICATION_KINDS: FindingKind[] = [
  "REQUIREMENT_PARTIALLY_SUPPORTED", "REQUIREMENT_UNSUPPORTED", "CAPABILITY_BURIED",
  "TERMINOLOGY_MISMATCH", "CLAIM_TOO_VAGUE", "STRONGEST_EVIDENCE_UNDEREMPHASIZED",
  "IRRELEVANT_MATERIAL_DOMINATES", "PRESENTATION_RISK",
];

export interface ScreeningFinding {
  kind: FindingKind;
  /** The posting's demand this is about, in the posting's own words. */
  requirement: string | null;
  /** What a screening reader would conclude, and why. */
  detail: string;
  /** The resume text it is about, quoted from what the evaluator saw. */
  quotedFromResume: string | null;
  severity: "HIGH" | "MEDIUM" | "LOW";
}

export interface RequirementCoverage {
  requirement: string;
  /** How the resume READS, which is not whether it is true. */
  appears: "CLEAR" | "PARTIAL" | "ABSENT";
  where: string | null;
}

/**
 * A comparison number, and never anything else.
 *
 * Useful for asking whether one draft reads better than another. It is
 * not evidence, it does not enter fit scoring, it cannot make an
 * application eligible or ineligible, and nothing downstream is allowed
 * to branch on it. Those are enforced structurally, not by convention.
 */
export interface ScreeningAssessment {
  /** 0 to 100. Comparative only. */
  score: number;
  summary: string;
  strongestSignal: string | null;
  weakestSignal: string | null;
}

export interface ScreeningResult {
  findings: ScreeningFinding[];
  coverage: RequirementCoverage[];
  assessment: ScreeningAssessment;
  evaluatorVersion: number;
  model: string;
}

/** Which side of the line a finding falls on, once evidence is consulted. */
export type GapKind =
  /** Evidence exists; the resume failed to communicate it. Fixable. */
  | "COMMUNICATION_GAP"
  /** The evidence does not establish it. Stays a gap, truthfully. */
  | "REAL_EVIDENCE_GAP"
  /**
   * About the page rather than the evidence, and pointing at a sentence
   * that actually exists. Safe to act on.
   */
  | "ACTIONABLE_PRESENTATION_GAP"
  /**
   * About the page, but naming nothing in particular. Worth reading and
   * worth storing; not something a rewrite can be aimed at, because
   * aiming it would mean choosing a target the evaluator did not name.
   */
  | "DIAGNOSTIC_PRESENTATION_FINDING"
  /** The finding names a requirement this posting does not have. */
  | "UNMATCHED";

export interface ReconciledFinding {
  finding: ScreeningFinding;
  gap: GapKind;
  /** What the evidence system actually holds, in its own terms. */
  evidenceSays: string;
  /** Concepts from the authoritative breakdown that bear on it. */
  conceptKeys: string[];
  /** The scored requirement this was joined to, when one was established. */
  requirementIds: string[];
  /** How the join was made, or why it was not. */
  joinedBy: "exact-text" | "normalized-text" | "high-overlap" | "concept-fallback" | "none";
  /** The resume sentence a presentation finding points at, once verified. */
  target: string | null;
  /** Whether a revision pass may act on this finding at all. */
  actionable: boolean;
}
