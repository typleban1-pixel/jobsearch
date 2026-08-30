import { classifyRequirement, type RequirementClass, type CredentialFamily } from "./requirementClass.ts";
import { resolveConcept, creditFor, type CapabilityIndex, type Resolution } from "./capability.ts";
import { splitCompound } from "../matching/concepts.ts";
import { jobFunctionProfile, type BusinessFunction } from "./functions.ts";
import { assessEducation, type EducationRecord } from "./education.ts";

/**
 * Fit, rebuilt as a measure of DEGREE rather than a penalty counter.
 *
 * The old model summed penalties, so its maximum was zero and it
 * correlated -0.75 with requirement count: a thorough posting was punished
 * for being thorough, and the two top-ranked jobs had no requirements at
 * all because nothing could subtract from them.
 *
 * Three changes fix that.
 *
 * CONCEPTS, NOT PHRASES. Requirements are normalized to concepts and
 * deduplicated. A verbose posting saying "pricing strategy", "pricing
 * analysis" and "analytical pricing management" contributes one concept,
 * exactly like a concise posting that says "pricing". This is what makes
 * the verbose/concise invariant hold rather than hoping a divisor fixes it.
 *
 * A RATIO, NOT A SUM. Coverage is achieved over achievable, so adding
 * genuine extra demands lowers Fit (correct) while adding restatements of
 * the same demand does not (also correct).
 *
 * UNKNOWNS LEAVE THE RATIO. A concept resolving to UNKNOWN is removed from
 * both numerator and denominator. It cannot lower Fit, only raise
 * uncertainty. Without this a deliberately conservative profile
 * manufactures gaps that do not exist.
 */

export const FIT_VERSION = 2;

export interface ScorableConcept {
  concept: string;
  requirementClass: RequirementClass;
  hardness: "HARD" | "PREFERRED" | "UNCLEAR";
  resolution: Resolution;
  via: string | null;
  rationale: string;
  weight: number;
  credit: number | null;
  requirementIds: string[];
  credentialFamily: CredentialFamily | null;
}

export interface FitBreakdown {
  concepts: ScorableConcept[];
  coverage: number | null;
  achieved: number;
  achievable: number;
  excludedUnknown: number;
  /** Classes that never enter the ratio, counted for reporting. */
  excludedByClass: Record<string, number>;
  credentialGates: number;
  credentialGatesUnmet: number;
  /** Distinct credential FAMILIES unmet. This is the number that scores. */
  credentialFamiliesUnmet: string[];
  educationGates: number;
  educationGatesUnmet: number;
  functions: BusinessFunction[];
  primaryFunction: BusinessFunction | null;
  scorable: boolean;
  unscorableReason: string | null;
}

/** HARD demands dominate; UNCLEAR carries no weight because we do not know if it is required. */
const HARDNESS_WEIGHT: Record<string, number> = { HARD: 3, PREFERRED: 1, UNCLEAR: 0 };

/**
 * Below this many evaluable concepts a posting cannot be judged. Placeholder
 * specs, talent pools and "Future Interest" pipelines land here, and they
 * are reported as unscorable rather than being allowed to win by default.
 */
export const MIN_SCORABLE_CONCEPTS = 3;

export function buildFitBreakdown(
  requirements: Array<{ id: string; raw_text: string; normalized_term: string | null; is_hard_requirement: string }>,
  title: string,
  index: CapabilityIndex,
  /**
   * Per-family credential declarations. A family absent from this map, or
   * present as UNDECLARED, keeps resolving UNKNOWN. Only NOT_HELD makes a
   * credential requirement a genuine failure.
   */
  credentialDeclarations: Record<string, string> = {},
  profileEducation: EducationRecord[] = [],
): FitBreakdown {
  const byConcept = new Map<string, ScorableConcept>();
  const excludedByClass: Record<string, number> = {};
  const allConcepts: string[] = [];

  for (const r of requirements) {
    const c = classifyRequirement(r.raw_text, r.normalized_term ?? "");
    allConcepts.push(c.concept);

    // Traits, generic phrases and job conditions never enter Fit. A
    // phrase like "technology proficiency" is not something a person can
    // hold or lack, and it cost the same as a missing licence before.
    if (c.requirementClass === "TRAIT" || c.requirementClass === "GENERIC" || c.requirementClass === "CONSTRAINT") {
      excludedByClass[c.requirementClass] = (excludedByClass[c.requirementClass] ?? 0) + 1;
      continue;
    }

    // A compound requirement is several requirements written as one.
    for (const part of splitCompound(c.concept)) {
      if (!part || part.length < 2) continue;
      const hardness = (r.is_hard_requirement as ScorableConcept["hardness"]) ?? "UNCLEAR";
      const existing = byConcept.get(part);
      if (existing) {
        // Same concept restated. Keep the strongest hardness, do not add
        // a second copy: this is the whole verbosity defence.
        if (HARDNESS_WEIGHT[hardness]! > HARDNESS_WEIGHT[existing.hardness]!) {
          existing.hardness = hardness;
          existing.weight = HARDNESS_WEIGHT[hardness]!;
        }
        existing.requirementIds.push(r.id);
        continue;
      }
      let res;
      if (c.requirementClass === "GATING_CREDENTIAL") {
        const fam = c.credentialFamily ?? "OTHER";
        const declared = credentialDeclarations[fam];
        res = declared === "NOT_HELD"
          ? { resolution: "ABSENT" as const, via: null,
              rationale: `confirmed: holds no ${fam.toLowerCase()} credential` }
          : { resolution: "UNKNOWN" as const, via: null,
              rationale: `${fam.toLowerCase()} credentials have not been declared either way` };
      } else if (c.requirementClass === "EDUCATION") {
        const e = assessEducation({
          requiredLevel: c.educationLevel, requiredField: c.educationField,
          rawText: r.raw_text, profileEducation,
        });
        res = e.verdict === "SATISFIED" ? { resolution: "DIRECT" as const, via: "verified education", rationale: e.detail }
            : e.verdict === "UNKNOWN" ? { resolution: "UNKNOWN" as const, via: null, rationale: e.detail }
            : { resolution: "ABSENT" as const, via: null, rationale: e.detail };
      } else {
        res = resolveConcept(part, index);
      }
      byConcept.set(part, {
        concept: part, requirementClass: c.requirementClass, hardness,
        resolution: res.resolution, via: res.via, rationale: res.rationale,
        weight: HARDNESS_WEIGHT[hardness]!, credit: creditFor(res.resolution),
        requirementIds: [r.id], credentialFamily: c.credentialFamily,
      });
    }
  }

  const concepts = [...byConcept.values()];
  let achieved = 0, achievable = 0, excludedUnknown = 0;
  for (const c of concepts) {
    if (c.weight === 0) continue;
    if (c.credit === null) { excludedUnknown++; continue; }
    achievable += c.weight;
    achieved += c.weight * c.credit;
  }

  const credentialConcepts = concepts.filter((c) => c.requirementClass === "GATING_CREDENTIAL" && c.weight > 0);
  const educationConcepts = concepts.filter((c) => c.requirementClass === "EDUCATION" && c.weight > 0);
  const credentialFamiliesUnmet = [...new Set(
    credentialConcepts.filter((c) => c.resolution === "ABSENT" || c.resolution === "UNKNOWN")
      .map((c) => c.credentialFamily ?? "OTHER"),
  )];

  const evaluable = concepts.filter((c) => c.weight > 0 && c.credit !== null).length;
  const scorable = evaluable >= MIN_SCORABLE_CONCEPTS;

  const fnProfile = jobFunctionProfile(allConcepts, title);

  return {
    concepts,
    coverage: achievable > 0 ? achieved / achievable : null,
    achieved, achievable, excludedUnknown, excludedByClass,
    credentialGates: credentialConcepts.length,
    credentialGatesUnmet: credentialConcepts.filter((c) => c.resolution === "ABSENT").length,
    credentialFamiliesUnmet,
    educationGates: educationConcepts.length,
    educationGatesUnmet: educationConcepts.filter((c) => c.resolution === "ABSENT").length,
    functions: fnProfile.spanned,
    primaryFunction: fnProfile.primary,
    scorable,
    unscorableReason: scorable ? null
      : `only ${evaluable} evaluable concepts extracted (need ${MIN_SCORABLE_CONCEPTS}); the posting carries too little information to judge`,
  };
}
