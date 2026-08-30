import type { EligibilityStatus } from "./eligibility.ts";

export const FEATURE_VERSION = 1;

export type ScoreDimension = "FIT" | "OPPORTUNITY" | "GENERALIST" | "SPECIALIST" | "UNCERTAINTY";

export type ScoreReasonKind =
  | "SKILL_MATCH" | "SKILL_GAP" | "TRANSFERABLE_SKILL"
  | "TITLE_MATCH" | "TITLE_MISMATCH"
  | "SENIORITY_MATCH" | "SENIORITY_MISMATCH"
  | "LOCATION_MATCH" | "LOCATION_MISMATCH"
  | "REMOTE_ELIGIBLE" | "REMOTE_INELIGIBLE"
  | "SALARY_MATCH" | "SALARY_BELOW_FLOOR" | "SALARY_UNKNOWN"
  | "HARD_REQUIREMENT_MET" | "HARD_REQUIREMENT_MISSING" | "HARD_REQUIREMENT_UNCLEAR"
  | "PREFERENCE_MATCH" | "PREFERENCE_CONFLICT"
  | "COMPANY_SIGNAL" | "GENERALIST_SIGNAL" | "SPECIALIST_SIGNAL" | "UNKNOWN_DATA";

/** The verified profile, and nothing else. SUGGESTED rows never reach here. */
export interface ScoringProfile {
  profileVersion: number;
  skills: Array<{
    id: string; name: string; relatedTerms: string[];
    level: string; interest: string; importance: string;
  }>;
  salaryHardFloor: number | null;
  salaryTargetMin: number | null;
  salaryTargetIdeal: number | null;
  targetMetros: string[];
  acceptsRemote: boolean;
  preferences: Array<{ kind: "WANT" | "AVOID"; statement: string; weight: number }>;
}

/**
 * A requirement as the JOB states it. Deliberately carries no match
 * result.
 *
 * Matching depends on the profile, and job_features is supposed to be a
 * pure function of the job so that a profile change can be rescored from
 * cache with no refetch. Embedding match results here made features
 * silently profile-dependent: a self-test scoring cached features against
 * an emptied profile still reported skill matches, because the matches
 * had been frozen in at build time. Matching now happens inside the
 * scorer, where the profile actually is.
 */
export interface RequirementFeature {
  id: string;
  term: string;
  kind: string;
  hardness: "HARD" | "PREFERRED" | "UNCLEAR";
  minimumYears: number | null;
}

export interface JobFeatures {
  featureVersion: number;
  eligibility: EligibilityStatus | null;
  requirementsExtracted: boolean;
  requirements: RequirementFeature[];
  seniority: string;
  managesPeople: boolean | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryKnown: boolean;
  remotePolicy: string;
  metro: string | null;
  mentionsEquity: boolean | null;
  hasQuotaOrCommission: boolean | null;
  travelRequirementPct: number | null;
  crossFunctionalLanguage: boolean;
  ownershipLanguage: boolean;
  deepDomainLanguage: boolean;
  distinctDomains: number;
  /** Named, not counted: the report has to say WHICH field was unknown. */
  unknownFields: string[];
}

export interface ScoreReason {
  dimension: ScoreDimension;
  kind: ScoreReasonKind;
  subject: string | null;
  detail: string | null;
  points: number;
  requirementId?: string | null;
  skillId?: string | null;
}

export interface ScoreResult {
  fit: number;
  opportunity: number;
  generalist: number;
  specialist: number;
  uncertainty: number;
  unknownFieldCount: number;
  unclearRequirementCount: number;
  /** Soft-trait coverage signal. Reported, never scored against fit. */
  traitCount: number;
  /** Legal and logistical conditions awaiting evaluation against the profile. */
  constraintCount: number;
  reasons: ScoreReason[];
  profileVersion: number;
  weightsVersion: number;
  extractionVersion: number;
}
