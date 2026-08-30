import { FEATURE_VERSION, type JobFeatures, type RequirementFeature } from "./types.ts";
import type { EligibilityStatus } from "./eligibility.ts";

/**
 * Builds the complete deterministic scoring input for one job.
 *
 * A pure function of the JOB. It contains nothing derived from the
 * profile, which is what lets a profile change be rescored straight from
 * cache: no refetch, no model call, no network. Skill matching lives in
 * the scorer for exactly this reason.
 *
 * Language signals are keyword scans over the description. They are
 * crude, and they are deterministic, which is the requirement. If they
 * prove too crude, extraction replaces them and the feature version bumps.
 */

const CROSS_FUNCTIONAL = /\b(cross[- ]functional|partner with|collaborate with|work closely with|stakeholder|matrixed|cross[- ]team)\b/i;
const OWNERSHIP = /\b(own(?:s|ing|ership)?\b|end[- ]to[- ]end|autonomy|autonomous|drive\b|from scratch|zero to one|0 to 1|wear many hats|generalist)\b/i;
const DEEP_DOMAIN = /\b(deep (?:expertise|knowledge|understanding)|specialist|subject matter expert|\bSME\b|world[- ]class|cutting[- ]edge|PhD|research scientist)\b/i;

export interface BuildFeaturesInput {
  job: {
    eligibility: EligibilityStatus | null;
    seniority: string | null;
    manages_people: boolean | null;
    salary_min: number | null;
    salary_max: number | null;
    remote_policy: string | null;
    metro: string | null;
    mentions_equity: boolean | null;
    has_quota_or_commission: boolean | null;
    travel_requirement_pct: number | null;
  };
  descriptionText: string;
  requirements: Array<{
    id: string; normalized_term: string | null; raw_text: string;
    is_hard_requirement: string; minimum_years: number | null; kind: string;
  }>;
}

export function buildFeatures(input: BuildFeaturesInput): JobFeatures {
  const { job, descriptionText, requirements } = input;

  const reqFeatures: RequirementFeature[] = requirements.map((r) => ({
    id: r.id,
    term: r.normalized_term ?? r.raw_text,
    kind: r.kind,
    hardness: (r.is_hard_requirement as RequirementFeature["hardness"]) ?? "UNCLEAR",
    minimumYears: r.minimum_years,
  }));

  // Named rather than counted. "3 unknown fields" is not actionable;
  // "salary and remote policy unknown" is.
  const unknownFields: string[] = [];
  if (job.salary_min === null && job.salary_max === null) unknownFields.push("salary");
  if (!job.seniority || job.seniority === "UNKNOWN") unknownFields.push("seniority");
  if (!job.remote_policy || job.remote_policy === "UNCLEAR") unknownFields.push("remote_policy");
  if (job.manages_people === null) unknownFields.push("manages_people");
  if (job.mentions_equity === null) unknownFields.push("equity");
  if (requirements.length === 0) unknownFields.push("requirements");

  return {
    featureVersion: FEATURE_VERSION,
    eligibility: job.eligibility,
    requirementsExtracted: requirements.length > 0,
    requirements: reqFeatures,
    seniority: job.seniority ?? "UNKNOWN",
    managesPeople: job.manages_people,
    salaryMin: job.salary_min,
    salaryMax: job.salary_max,
    salaryKnown: job.salary_min !== null || job.salary_max !== null,
    remotePolicy: job.remote_policy ?? "UNCLEAR",
    metro: job.metro,
    mentionsEquity: job.mentions_equity,
    hasQuotaOrCommission: job.has_quota_or_commission,
    travelRequirementPct: job.travel_requirement_pct,
    crossFunctionalLanguage: CROSS_FUNCTIONAL.test(descriptionText),
    ownershipLanguage: OWNERSHIP.test(descriptionText),
    deepDomainLanguage: DEEP_DOMAIN.test(descriptionText),
    distinctDomains: new Set(requirements.map((r) => r.kind)).size,
    unknownFields,
  };
}
