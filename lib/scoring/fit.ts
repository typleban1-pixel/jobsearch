import { type ExtractedKind, classifyRequirement, type RequirementClass, type CredentialFamily } from "./requirementClass.ts";
import { resolveConcept, creditFor, type CapabilityIndex, type Resolution } from "./capability.ts";
import { resolveWithEvidence, type EvidenceContext } from "./evidenceResolution.ts";
import { collapseAlternatives } from "./requirementLogic.ts";
import { decompose } from "../matching/concepts.ts";
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
  /** Corpus-derived multiplier applied to weight. 1 under formula v1. */
  informationWeight?: number;
  /** Under formula 3: the multiplier actually applied, and why. */
  specificity?: number;
  /** True when this is a qualification FLOOR rather than a discriminator. */
  isBaseline?: boolean;
  educationLevel?: string | null;
  educationField?: string | null;
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
  /**
   * The acceptable answers, when the requirement offers a choice.
   *
   * Present only for OR requirements, and never scored per branch: the
   * concept is satisfied once or not at all.
   */
  alternatives?: string[];
  /**
   * Which branch actually satisfied it. This is the difference between
   * "he meets this degree requirement" and "he has a business degree",
   * and the second is a claim the evidence does not support.
   */
  satisfiedBranch?: string | null;
  /** What a reader should be shown. Never asserts an unsatisfied branch. */
  displayLabel?: string;
}

export interface FitBreakdown {
  concepts: ScorableConcept[];
  coverage: number | null;
  /**
   * Absolute matched weight. Never divided: this answers "how much has he
   * done", which is a different question from coverage's "what fraction
   * of this posting's demands are met".
   */
  evidence: number;
  creditedCount: number;
  achieved: number;
  achievable: number;
  excludedUnknown: number;
  /** Classes that never enter the ratio, counted for reporting. */
  excludedByClass: Record<string, number>;
  credentialGates: number;
  credentialGatesUnmet: number;
  /** Distinct credential families CONFIRMED absent. This is the number that scores. */
  credentialFamiliesUnmet: string[];
  /** Required but undeclared. Visible, never penalized as an absence. */
  credentialFamiliesUndeclared: string[];
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

/**
 * The shape of the Fit computation, versioned separately from the
 * weights. A coefficient change bumps weights_version; a change to what
 * the formula computes bumps this.
 *
 * 2: information-weighted, smoothed coverage.
 */
export const FIT_FORMULA_VERSION = 3;

/**
 * Version 3 replaces corpus rarity with a question about the PROFILE.
 *
 * Version 2 weighted a requirement by how rare it is (inverse document
 * frequency). That scores the wrong thing. In a corpus of white-collar
 * postings "high school diploma or GED" is rare, so IDF weighted it 0.69
 * against "bachelor degree" at 0.47, and six Gopuff barista postings
 * reached Fit 21-23 on that single requirement. Rarity is not value.
 *
 * The question that matters is whether meeting a requirement says
 * anything about the candidate. An education requirement asking for LESS
 * than the profile already holds is a floor: everyone still in the
 * running clears it, so it separates nobody. That is a fact about the
 * profile and the requirement, not about the corpus.
 *
 * One consequence worth naming: formula 3 does not depend on the corpus
 * at all. A score no longer changes because other postings were ingested,
 * which removes the reproducibility hazard version 2 introduced.
 */
const BASELINE_WEIGHT = 0.15;
const EDUCATION_LEVEL_ORDER: Record<string, number> = {
  HIGH_SCHOOL: 0, ASSOCIATE: 1, BACHELOR: 2, MASTER: 3, DOCTORATE: 4,
};

/**
 * Corpus statistics that make a concept's weight depend on how many
 * postings demand it.
 *
 * Passing null keeps the version-1 behaviour, where every HARD concept
 * weighed the same whatever it was. That is what made "high school
 * diploma" worth as much as "8+ years leading enterprise
 * implementations".
 */
export interface CorpusStatistics {
  /** Concept to number of jobs demanding it, over the scored corpus. */
  documentFrequency: Map<string, number>;
  jobCount: number;
  /** Lowest multiplier any concept can receive. A common requirement is
   *  less discriminating, not worthless. */
  floor: number;
}

/**
 * Information content of a concept, from corpus rarity.
 *
 * A concept 74 of 488 postings demand separates candidates far less than
 * one only two postings demand, and weighting by it needs no judgement
 * about which requirements matter: the corpus decides.
 *
 * This measures RARITY, not triviality. A requirement that is rare in
 * this corpus and trivially satisfied by anyone is weighted up, which is
 * a known and documented limitation rather than an oversight.
 */
export function informationWeight(concept: string, stats: CorpusStatistics | null): number {
  if (!stats || stats.jobCount <= 1) return 1;
  const df = Math.max(1, stats.documentFrequency.get(concept) ?? 1);
  const idf = Math.log(stats.jobCount / df);
  const idfMax = Math.log(stats.jobCount);
  return stats.floor + (1 - stats.floor) * (idf / idfMax);
}

/**
 * Ordering used only to pick the best branch of an OR requirement.
 *
 * Not a score. Nothing is summed here: the requirement takes the
 * resolution of its strongest alternative and is credited exactly once,
 * the same as any other single requirement.
 */
const RESOLUTION_RANK: Record<Resolution, number> = { DIRECT: 3, TRANSFERABLE: 2, UNKNOWN: 1, ABSENT: 0 };

/** Qualification alternatives arrive carrying the head of the phrase. */
function bareField(alternative: string): string {
  const stripped = alternative
    .replace(/^(?:a |an )?(?:bachelor's?|bachelors|master's?|masters|associate's?|doctoral|doctorate|b\.?s\.?|b\.?a\.?|m\.?s\.?|degree)\b\s*/i, "")
    .replace(/^(?:degree\s+)?in\s+/i, "")
    .replace(/\s+degree$/i, "")
    .trim();
  return stripped || alternative;
}

function bestOfAlternatives(
  parts: string[], index: CapabilityIndex,
): { resolution: Resolution; via: string | null; rationale: string } {
  let best: { resolution: Resolution; via: string | null; rationale: string } | null = null;
  let branch: string | null = null;
  for (const p of parts) {
    const r = resolveConcept(p, index);
    if (!best || RESOLUTION_RANK[r.resolution] > RESOLUTION_RANK[best.resolution]) { best = r; branch = p; }
  }
  if (!best) return { resolution: "UNKNOWN", via: null, rationale: "the requirement listed no alternatives to evaluate" };
  // Only a real match names a branch. An UNKNOWN branch outranks an
  // ABSENT one for resolution and still satisfies nothing.
  if (best.resolution === "DIRECT" || best.resolution === "TRANSFERABLE") {
    return { ...best, via: branch, rationale: `met through the "${branch}" alternative: ${best.rationale}` };
  }
  if (best.resolution === "UNKNOWN") return { ...best, via: null };
  return { resolution: "ABSENT", via: null,
           rationale: `none of the accepted alternatives are evidenced: ${parts.join(", ")}` };
}

/** Which alternative the evidence actually answered, if any. */
function branchFrom(
  res: { resolution: Resolution; via: string | null; rationale: string }, parts: string[],
): string | null {
  if (res.resolution !== "DIRECT" && res.resolution !== "TRANSFERABLE") return null;
  if (res.via && parts.includes(res.via)) return bareField(res.via);
  // assessEducation names the branch it accepted, in quotes.
  const quoted = res.rationale.match(/accepts "([^"]+)"/);
  return quoted ? quoted[1]! : null;
}

/**
 * The label a reader is shown.
 *
 * An OR requirement is never displayed as one of its unsatisfied
 * branches. Showing "degree in business" for a candidate who meets the
 * requirement through its science branch is not a wording problem: it
 * states a credential he does not hold.
 */
function labelFor(
  concept: string, cls: RequirementClass, alternatives: string[] | undefined,
  branch: string | null, resolution: Resolution,
): string {
  if (!alternatives || alternatives.length < 2) return concept;
  const fields = [...new Set(alternatives.map(bareField))];
  const head = cls === "EDUCATION" ? "degree in one of" : cls === "GATING_CREDENTIAL" ? "one credential of" : "one of";
  const body = `${head}: ${fields.join(", ")}`;
  return branch && (resolution === "DIRECT" || resolution === "TRANSFERABLE")
    ? `${body} (met via "${branch}")`
    : body;
}

export function buildFitBreakdown(
  requirements: Array<{
    id: string; raw_text: string; normalized_term: string | null; is_hard_requirement: string;
    /** The extractor's own label. Optional: absent reproduces taxonomy 2. */
    kind?: ExtractedKind;
    minimum_years?: number | null;
    /** Employer-authored alternation, from migration 0079. */
    alternative_group?: string | null;
    conjunct_key?: string | null;
  }>,
  title: string,
  index: CapabilityIndex,
  /**
   * Per-family credential declarations. A family absent from this map, or
   * present as UNDECLARED, keeps resolving UNKNOWN. Only NOT_HELD makes a
   * credential requirement a genuine failure.
   */
  credentialDeclarations: Record<string, string> = {},
  profileEducation: EducationRecord[] = [],
  /** Null reproduces formula version 1: uniform weights, no smoothing. */
  corpus: CorpusStatistics | null = null,
  /**
   * Additive smoothing constant. coverage = achieved / (achievable + k).
   * A posting has to accumulate evidence before its ratio speaks for it,
   * which is what stops four evaluable concepts outranking nineteen.
   */
  smoothingK = 0,
  /**
   * Evidence the term matcher cannot see, appended last so every
   * existing positional caller is unaffected.
   *
   * Omitted, every resolution is exactly what it was before this
   * parameter existed. That is what makes it safe to add here rather
   * than build a parallel scoring path.
   */
  evidenceContext: EvidenceContext | null = null,
): FitBreakdown {
  const byConcept = new Map<string, ScorableConcept>();
  const excludedByClass: Record<string, number> = {};
  const allConcepts: string[] = [];

  // The extractor gives every requirement pulled from one sentence the
  // same raw_text. Grouping by that text tells the classifier when its
  // context is shared, and therefore when it cannot be trusted to
  // describe this requirement rather than a sibling.
  const siblingsByRaw = new Map<string, string[]>();
  for (const r of requirements) {
    const key = r.raw_text ?? "";
    const a = siblingsByRaw.get(key) ?? [];
    a.push(r.normalized_term ?? "");
    siblingsByRaw.set(key, a);
  }

  // Classified once, up front, because whether a requirement is a
  // DUPLICATE of another cannot be decided while looking at it alone.
  const classified = requirements.map((r) => ({
    r,
    c: classifyRequirement(
      r.raw_text, r.normalized_term ?? "",
      (siblingsByRaw.get(r.raw_text ?? "") ?? []).filter((t) => t !== (r.normalized_term ?? "")),
      // The extractor's own label, used only where the text decides
      // nothing and only to take a requirement out of Fit.
      r.kind ?? null,
    ),
  }));

  /**
   * One sentence, several extracted rows, one qualification demand.
   *
   * The extractor emits a row per branch of a list, so "Degree in
   * Finance, Accounting, Economics, or Business Administration
   * preferred" arrives as four education rows sharing one raw_text.
   * Scored separately that is four unmet qualifications for one demand.
   *
   * Merging is allowed ONLY when the rows agree on everything that could
   * make them different demands: same class, same level, same hardness.
   * "Bachelor's degree in Accounting + CPA license or Master's degree in
   * Accounting" also produces two rows from one sentence, but at
   * different levels, and collapsing those two routes would require
   * deciding which level the requirement really is. Those stay separate.
   */
  const mergedByRaw = new Map<string, { fields: string[]; memberIds: string[]; leadTerm: string }>();
  const absorbed = new Set<string>();
  {
    const groups = new Map<string, typeof classified>();
    for (const x of classified) {
      if (x.c.requirementClass !== "EDUCATION" && x.c.requirementClass !== "GATING_CREDENTIAL") continue;
      const key = x.r.raw_text ?? "";
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), x]);
    }
    for (const [raw, group] of groups) {
      if (group.length < 2) continue;
      const same = (pick: (x: (typeof group)[number]) => unknown) =>
        new Set(group.map(pick)).size === 1;
      if (!same((x) => x.c.requirementClass)) continue;
      if (!same((x) => x.c.educationLevel)) continue;
      if (!same((x) => x.r.is_hard_requirement)) continue;
      const fields = group.map((x) => x.c.educationField).filter((f): f is string => Boolean(f));
      // Distinct fields are what makes this a list. Identical rows are a
      // restatement and merge just as safely.
      mergedByRaw.set(raw, {
        fields: [...new Set(fields)],
        memberIds: group.map((x) => x.r.id),
        leadTerm: group[0]!.c.concept,
      });
      for (const x of group.slice(1)) absorbed.add(x.r.id);
    }
  }

  for (const { r, c } of classified) {
    allConcepts.push(c.concept);
    // Every branch of a merged demand is already represented by the row
    // that leads it.
    if (absorbed.has(r.id)) continue;

    // Traits, generic phrases and job conditions never enter Fit. A
    // phrase like "technology proficiency" is not something a person can
    // hold or lack, and it cost the same as a missing licence before.
    if (c.requirementClass === "TRAIT" || c.requirementClass === "GENERIC" || c.requirementClass === "CONSTRAINT") {
      excludedByClass[c.requirementClass] = (excludedByClass[c.requirementClass] ?? 0) + 1;
      continue;
    }

    // How the requirement decomposes, and whether the pieces are all
    // wanted or one of several accepted.
    //
    // A qualification requirement is never split. You hold one degree
    // and one licence, so a list of acceptable degree fields is one
    // requirement with alternatives, not a set of requirements. Splitting
    // it credited a single verified degree six times over and labelled
    // one of those credits with a field the degree is not in.
    const merged = mergedByRaw.get(r.raw_text ?? "") ?? null;
    const isQualification = c.requirementClass === "EDUCATION" || c.requirementClass === "GATING_CREDENTIAL";
    const decomposition = isQualification
      ? { kind: "OR" as const, parts: decompose(c.concept, r.raw_text).parts }
      : decompose(c.concept, r.raw_text);
    const asAlternatives = decomposition.kind === "OR";
    const units = asAlternatives ? [c.concept] : decomposition.parts;

    for (const part of units) {
      if (!part || part.length < 2) continue;
      const hardness = (r.is_hard_requirement as ScorableConcept["hardness"]) ?? "UNCLEAR";
      // Keyed by class as well as text. "management" as an acceptable
      // degree field and "management" as work experience are different
      // requirements, and merging them let a degree list silently absorb
      // an unrelated experience requirement.
      const key = `${c.requirementClass} :: ${part}`;
      const existing = byConcept.get(key);
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
          requiredLevel: c.educationLevel,
          // A merged demand is assessed against every field it accepts,
          // exactly as it would be if the posting's list had survived
          // extraction as one row.
          requiredField: merged && merged.fields.length ? merged.fields.join(", ") : c.educationField,
          rawText: r.raw_text, profileEducation,
        });
        res = e.verdict === "SATISFIED" ? { resolution: "DIRECT" as const, via: "verified education", rationale: e.detail }
            : e.verdict === "UNKNOWN" ? { resolution: "UNKNOWN" as const, via: null, rationale: e.detail }
            : { resolution: "ABSENT" as const, via: null, rationale: e.detail };
      } else if (asAlternatives) {
        // One requirement, several acceptable answers. It resolves to
        // its best branch and is credited once, because meeting it twice
        // is not meeting two requirements.
        res = bestOfAlternatives(decomposition.parts, index);
      } else {
        res = resolveConcept(part, index);
      }

      // Telling "nothing matched that name" apart from "the evidence
      // shows he cannot do this". Only ever moves ABSENT to UNKNOWN, and
      // only on an exact verified skill category or an explicitly
      // recorded capability duration. See evidenceResolution.ts.
      if (evidenceContext) {
        const refined = resolveWithEvidence(part, res, evidenceContext, { minimumYears: r.minimum_years ?? null });
        if (refined.changed) res = { resolution: refined.resolution, via: res.via, rationale: refined.rationale };
      }

      // A one-item list is not a choice. Recording alternatives for it
      // would make an ordinary "Bachelor's degree" requirement look like
      // a disjunction in every report that reads the field.
      const alternatives = merged && merged.fields.length >= 2
        ? merged.fields
        : asAlternatives && decomposition.parts.length >= 2
          ? decomposition.parts : undefined;
      const satisfiedBranch = alternatives ? branchFrom(res, alternatives) : null;
      byConcept.set(key, {
        educationLevel: c.educationLevel, educationField: c.educationField,
        concept: part, requirementClass: c.requirementClass, hardness,
        resolution: res.resolution, via: res.via, rationale: res.rationale,
        weight: HARDNESS_WEIGHT[hardness]!, credit: creditFor(res.resolution),
        requirementIds: merged ? merged.memberIds : [r.id],
        credentialFamily: c.credentialFamily,
        alternatives, satisfiedBranch,
        displayLabel: labelFor(part, c.requirementClass, alternatives, satisfiedBranch, res.resolution),
      });
    }
  }

  // Employer-authored alternatives collapse into ONE concept before
  // anything counts them.
  //
  // "3+ years of legal operations experience or 5+ years of operations
  // experience" is one requirement with two ways to satisfy it. Split
  // across two concepts, failing both counted as two core gaps and
  // rejected a job the employer would have considered. The grouping
  // comes from job_requirements.alternative_group; a concept with no
  // group passes through untouched, which is every concept on a posting
  // that states no alternatives.
  const groupOf = new Map<string, { group: string | null; conjunct: string | null }>();
  for (const r of requirements) {
    groupOf.set(r.id, { group: r.alternative_group ?? null, conjunct: r.conjunct_key ?? null });
  }
  const forCollapse = [...byConcept.values()].map((c: any) => {
      // A merged concept can stand for several requirement rows. It
      // joins a group only when every row behind it belongs to that same
      // group, so a partial overlap never silently makes an ordinary
      // requirement optional.
      const gs = (c.requirementIds ?? []).map((id: string) => groupOf.get(id)?.group ?? null);
      const group = gs.length && gs.every((g: string | null) => g && g === gs[0]) ? gs[0] : null;
      const cj = (c.requirementIds ?? []).map((id: string) => groupOf.get(id)?.conjunct ?? null);
      return { ...c, id: (c.requirementIds ?? [c.concept])[0], alternativeGroup: group,
               conjunctKey: group ? (cj[0] ?? null) : null };
  });

  // Every requirement row a group stands for, so the stratum is decided
  // by the whole alternation. collapseAlternatives inherits ONE member's
  // fields, and requirementIds is what candidacy reads to tell a
  // role-defining requirement from a box to tick; inheriting half of
  // them lets one arbitrary alternative classify the group.
  const idsByGroup = new Map<string, string[]>();
  for (const c of forCollapse as any[]) {
    if (!c.alternativeGroup) continue;
    idsByGroup.set(c.alternativeGroup, [...(idsByGroup.get(c.alternativeGroup) ?? []), ...(c.requirementIds ?? [])]);
  }

  const concepts = collapseAlternatives(forCollapse as any).map((c: any) => {
    // A collapsed group inherits one member's fields, including its
    // resolution. Where the group's credit disagrees with that inherited
    // label, the credit is the truth and the label is corrected, so a
    // group that is unresolved is never reported as ABSENT.
    if (!c.covers || c.covers.length < 2) return c;
    const alts = c.concept;
    c = { ...c, requirementIds: [...new Set(idsByGroup.get(c.alternativeGroup) ?? c.requirementIds ?? [])] };
    if (c.credit === null) return { ...c, resolution: "UNKNOWN",
      rationale: `the employer asked for ${alts}; neither alternative is established, `
        + "and an unestablished alternative is not a failed one" };
    if (c.credit === 0) return { ...c, resolution: "ABSENT",
      rationale: `the employer asked for ${alts}; no alternative is satisfied` };
    return { ...c, rationale: `the employer asked for ${alts}, satisfied by ${c.satisfiedBy}` };
  }) as any[];
  // Highest verified level the profile actually holds. A requirement
  // below it cannot discriminate.
  const profileLevel = profileEducation.length > 0
    ? Math.max(...profileEducation.map((e) => EDUCATION_LEVEL_ORDER[e.level] ?? 0))
    : -1;

  let achieved = 0, achievable = 0, excludedUnknown = 0, evidence = 0;
  for (const c of concepts) {
    if (c.weight === 0) continue;
    if (c.credit === null) { excludedUnknown++; continue; }

    // A generic education requirement below the profile's own attainment
    // is a floor. A FIELD-SPECIFIC one never is: "degree in nursing"
    // discriminates regardless of level.
    c.isBaseline = c.requirementClass === "EDUCATION"
      && !c.educationField
      && profileLevel >= 0
      && (EDUCATION_LEVEL_ORDER[c.educationLevel ?? "BACHELOR"] ?? 2) < profileLevel;

    c.informationWeight = informationWeight(c.concept, corpus);
    c.specificity = c.isBaseline ? BASELINE_WEIGHT : 1;
    const w = c.weight * c.specificity;
    achievable += w;
    achieved += w * c.credit;
    // Evidence is an absolute quantity and is never divided by anything.
    // Six matched concepts is more than one matched concept, whatever
    // else the posting asked for.
    if (c.credit > 0) evidence += w * c.credit;
  }

  const credentialConcepts = concepts.filter((c) => c.requirementClass === "GATING_CREDENTIAL" && c.weight > 0);
  const educationConcepts = concepts.filter((c) => c.requirementClass === "EDUCATION" && c.weight > 0);
  // ABSENT only. ABSENT means the family was declared NOT_HELD, which is
  // a confirmed qualification failure. UNKNOWN means nobody has said
  // either way, and charging the same penalty for it would manufacture
  // knowledge: it is what made an UNDECLARED family behave exactly like a
  // confirmed absence, which is the catch-all the profile explicitly
  // refuses. Not knowing is uncertainty, and uncertainty is scored as
  // uncertainty.
  const credentialFamiliesUnmet = [...new Set(
    credentialConcepts.filter((c) => c.resolution === "ABSENT")
      .map((c) => c.credentialFamily ?? "OTHER"),
  )];
  /** Required, undeclared, and deliberately not penalized. Reported so it stays visible. */
  const credentialFamiliesUndeclared = [...new Set(
    credentialConcepts.filter((c) => c.resolution === "UNKNOWN")
      .map((c) => c.credentialFamily ?? "OTHER"),
  )];

  const evaluable = concepts.filter((c) => c.weight > 0 && c.credit !== null).length;
  const creditedCount = concepts.filter((c) => c.weight > 0 && (c.credit ?? 0) > 0).length;
  const scorable = evaluable >= MIN_SCORABLE_CONCEPTS;

  const fnProfile = jobFunctionProfile(allConcepts, title);

  return {
    concepts,
    // Smoothed. The denominator is the evidence the posting actually
    // offers plus a constant standing for the evidence it does not, so a
    // ratio over four concepts cannot speak as loudly as one over
    // nineteen.
    coverage: achievable > 0 ? achieved / (achievable + smoothingK) : null,
    achieved, achievable, excludedUnknown, excludedByClass,
    evidence, creditedCount,
    credentialGates: credentialConcepts.length,
    credentialGatesUnmet: credentialConcepts.filter((c) => c.resolution === "ABSENT").length,
    credentialFamiliesUnmet,
    credentialFamiliesUndeclared,
    educationGates: educationConcepts.length,
    educationGatesUnmet: educationConcepts.filter((c) => c.resolution === "ABSENT").length,
    functions: fnProfile.spanned,
    primaryFunction: fnProfile.primary,
    scorable,
    unscorableReason: scorable ? null
      : `only ${evaluable} evaluable concepts extracted (need ${MIN_SCORABLE_CONCEPTS}); the posting carries too little information to judge`,
  };
}
