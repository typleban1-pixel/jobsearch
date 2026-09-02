/**
 * Whether a job is worth applying to.
 *
 * Fit answers "how much of this posting does the evidence cover". That
 * is a number, and a number cannot tell a realistic stretch from a job
 * in the wrong occupation: Principal Engineer, Streaming Systems reached
 * 0.250 on genuine transferable concepts and is not an engineering
 * candidate. Candidacy reads the SHAPE of what is missing instead.
 *
 * Four things it is deliberately not:
 *
 *   not a Fit threshold      Fit is an input; no rule here compares it
 *                            to a cutoff.
 *   not a corpus ranking     being the best job in a weak corpus does
 *                            not make a job appropriate, so nothing here
 *                            reads rank or percentile.
 *   not a title blocklist    an operations role and a software role at
 *                            the same company are judged by their
 *                            requirements, not their names.
 *   not a duration model     years reasoning is informational and
 *                            deliberately absent; see docs/TECH_DEBT.md.
 */
import type { FitBreakdown, ScorableConcept } from "./fit.ts";

export const CANDIDACY_MODEL_VERSION = 4;

/**
 * What each model version decides, so a stored verdict can be read back.
 *
 *   3  the ladder below, with unresolved requirements excluded from the
 *      hard-requirement denominator entirely.
 *   4  identical to 3, plus one arm: an unresolved role-defining or
 *      occupational HARD requirement routes to MANUAL_REVIEW instead of
 *      letting the remaining known requirements stand in for it.
 *
 * Passing modelVersion: 3 reproduces model 3 exactly, which is how the
 * historical behavior stays executable rather than merely described.
 */
export const CANDIDACY_MODEL_VERSIONS = [3, 4] as const;

export type Verdict = "APPLICATION_CANDIDATE" | "STRETCH" | "REJECT" | "MANUAL_REVIEW";

export type ReasonCode =
  | "DISQUALIFYING_CREDENTIAL"
  | "UNKNOWN_GATING_CREDENTIAL"
  | "MULTIPLE_CORE_GAPS"
  | "CORE_GAP_WITHOUT_SUPPORT"
  | "NO_DIRECT_EVIDENCE"
  | "POSTING_NOT_ASSESSED"
  | "NO_DISCRIMINATING_REQUIREMENTS"
  | "OCCUPATIONAL_GAP"
  | "LOW_HARD_RATIO"
  | "MEETS_HARD_REQUIREMENTS"
  | "UNRESOLVED_ROLE_DEFINING_REQUIREMENT";

/**
 * What kind of demand a HARD requirement is.
 *
 * Measured, not assumed: counting HARD requirements as interchangeable
 * votes let a generic bachelor's degree stand in for four years of
 * logistics experience on Regional Implementation Manager, which reached
 * APPLICATION_CANDIDATE at 2/3. Of the jobs surviving that model, 56%
 * had their ratio lifted by a baseline requirement.
 */
export type Stratum = "GATING" | "BASELINE" | "OCCUPATIONAL" | "SUBSTANTIVE";

/** The extractor's own label, as job_requirements.kind stores it. */
export interface RequirementRow { id: string; kind: string | null; normalized_term: string | null; raw_text: string | null }

/**
 * Clauses naming the SETTING work happened in rather than the work.
 *
 * "2+ years in a fast-paced environment" states a workplace temperament,
 * not a body of experience, and treating it as occupational substance
 * cost the strongest job in the corpus its candidacy.
 */
const SETTING = /\b(?:in|at|within|for|inside)?\s*(?:a|an|the)?\s*(?:fast[- ]paced|high[- ]growth|hyper[- ]growth|fast[- ]changing|fast[- ]moving|rapidly changing|dynamic|ambiguous|matrixed|remote|hybrid|distributed|start[- ]?up|scale[- ]?up|agile|regulated|deadline[- ]driven|high[- ]volume|high[- ]pressure)\s*(?:work\s*)?(?:environment|setting|culture|company|organi[sz]ation|team|atmosphere|workplace|pace|context)s?\b/gi;

/** Grammar and the word "experience" itself, which name nothing. */
const FILLER = /\b(?:experience|years?|work(?:ing)?|professional|relevant|overall|environment|setting|culture|pace|in|at|a|an|the|and|or|of|with|combined)\b/gi;

/**
 * Undifferentiated experience: real, but naming no occupation.
 *
 * Kept separate from setting-only phrases because they are different
 * things. "5+ years of professional experience" is a duration demand
 * about a career; "2+ years in a fast-paced environment" is about
 * temperament. Neither is occupational substance, and conflating them
 * would hide the distinction if they ever diverge in treatment.
 */
const GENERAL_PROFESSIONAL = /^(?:general |overall |total |combined )?(?:work|professional|industry|relevant|full[- ]time)\s+experience$/i;

export type ExperienceObject = "OCCUPATIONAL" | "SETTING_ONLY" | "GENERAL_PROFESSIONAL";

/**
 * What an EXPERIENCE_YEARS or DOMAIN requirement is actually about.
 *
 * Operates on the OBJECT of the demand, not on whether a disposition
 * word appears anywhere in it. "5 years of project management in a
 * fast-paced environment" keeps its object; "2 years in a fast-paced
 * environment" has none once the setting is removed.
 *
 * The taxonomy-4 disposition veto was measured here and is not reused:
 * it fired on six requirements, all six false positives (it removes
 * "customer onboarding, implementation" for containing "onboard"), and
 * caught none of the sixteen setting phrases.
 */
export function experienceObject(term: string): ExperienceObject {
  const t = String(term ?? "").toLowerCase().trim();
  if (!t) return "GENERAL_PROFESSIONAL";
  if (GENERAL_PROFESSIONAL.test(t)) return "GENERAL_PROFESSIONAL";
  SETTING.lastIndex = 0;
  const residue = t.replace(SETTING, " ").replace(FILLER, " ").replace(/[^a-z0-9+#]+/g, " ").trim();
  return residue ? "OCCUPATIONAL" : "SETTING_ONLY";
}

export function stratumOf(c: ScorableConcept, reqById: Map<string, RequirementRow>): Stratum {
  if (c.requirementClass === "GATING_CREDENTIAL") return "GATING";
  // A degree requirement is a FLOOR only when it names no field.
  // "Bachelor's degree" is a box to tick; "bachelor degree in actuarial
  // science" discriminates and is the substance of the job, which is the
  // same distinction Fit's own isBaseline draws. Treating every
  // EDUCATION concept as baseline silently removed field-specific degree
  // requirements from the role-defining set on two corpus jobs.
  const isEducation = c.requirementClass === "EDUCATION"
    || (c.requirementIds ?? []).some((id) => reqById.get(id)?.kind === "EDUCATION");
  if (isEducation) return c.educationField ? "SUBSTANTIVE" : "BASELINE";
  const reqs = (c.requirementIds ?? []).map((id) => reqById.get(id)).filter(Boolean) as RequirementRow[];
  const occ = reqs.filter((r) => r.kind === "EXPERIENCE_YEARS" || r.kind === "DOMAIN");
  // One requirement naming real work is enough: a concept backed by both
  // "5 years of supply chain" and "in a fast-paced environment" is
  // occupational.
  if (occ.some((r) => experienceObject(String(r.normalized_term ?? r.raw_text ?? "")) === "OCCUPATIONAL")) return "OCCUPATIONAL";
  return "SUBSTANTIVE";
}

const STOP = new Set(["and","or","the","a","an","of","in","to","for","with","senior","staff","principal","lead","director",
  "manager","specialist","associate","analyst","coordinator","ii","iii","iv","sr","jr","experience","years","strong",
  "ability","skills","knowledge","i","new","team"]);
const tokens = (s: string) => new Set(String(s ?? "").toLowerCase().match(/[a-z0-9+#.-]+/g)
  ?.map((w) => w.replace(/^[.-]+|[.-]+$/g, "")).filter((w) => w.length > 2 && !STOP.has(w)) ?? []);

/**
 * A requirement the posting says the job IS.
 *
 * Unchanged from the validated model. Two signals, both from the
 * posting's own structure: the concept is named in the title, or the
 * posting states it in three or more separate requirements. It catches
 * what the stratification cannot -- Principal Engineer states everything
 * as SKILL-kind and has no occupational requirement at all, and is
 * rejected only by title anchoring.
 */
export function isCoreGap(c: ScorableConcept, title: string): boolean {
  if ((c.credit ?? 0) > 0 || c.isBaseline) return false;
  const t = tokens(title);
  return [...tokens(c.concept)].some((w) => t.has(w)) || (c.requirementIds?.length ?? 0) >= 3;
}

export interface CandidacyInput {
  jobTitle: string;
  normalizedTitle?: string | null;
  fit: FitBreakdown;
  requirements: RequirementRow[];
  /** family -> HELD | NOT_HELD | UNDECLARED. Absent families are UNKNOWN. */
  credentialDeclarations: Record<string, string>;
  /** Defaults to the current model. 3 reproduces the frozen behavior. */
  modelVersion?: number;
}

export interface CandidacyResult {
  verdict: Verdict;
  reasonCodes: ReasonCode[];
  reason: string;
  hardMet: number;
  hardTotal: number;
  directMatches: number;
  transferableMatches: number;
  occupational: Array<{ concept: string; resolution: string; met: boolean }>;
  coreGaps: string[];
  gatingGaps: string[];
  unknownGates: string[];
  /**
   * Role-defining or occupational HARD requirements left unresolved.
   * Always computed; only acted on from model 4.
   */
  unresolvedCore: string[];
  baselineMet: number;
  modelVersion: number;
}

export function assessCandidacy(input: CandidacyInput): CandidacyResult {
  const model = input.modelVersion ?? CANDIDACY_MODEL_VERSION;
  const reqById = new Map(input.requirements.map((r) => [r.id, r]));
  const concepts = input.fit.concepts as ScorableConcept[];
  const scored = concepts.filter((c) => c.weight > 0 && c.credit !== null);
  const title = `${input.jobTitle} ${input.normalizedTitle ?? ""}`;

  const directMatches = scored.filter((c) => c.resolution === "DIRECT").length;
  const transferableMatches = scored.filter((c) => c.resolution === "TRANSFERABLE").length;
  const hardAll = scored.filter((c) => c.hardness === "HARD");
  const strata = new Map(hardAll.map((c) => [c, stratumOf(c, reqById)]));

  // A baseline requirement neither helps nor hurts: a degree he holds
  // says nothing about whether he can do the job.
  const ratioSet = hardAll.filter((c) => strata.get(c) !== "BASELINE" && !c.isBaseline);
  const hardMet = ratioSet.filter((c) => (c.credit ?? 0) > 0).length;
  const hardTotal = ratioSet.length;
  const baselineMet = hardAll.filter((c) => strata.get(c) === "BASELINE" && (c.credit ?? 0) > 0).length;

  const occConcepts = hardAll.filter((c) => strata.get(c) === "OCCUPATIONAL");
  const occupational = occConcepts.map((c) => ({ concept: c.concept, resolution: c.resolution, met: (c.credit ?? 0) > 0 }));
  const occAbsent = occConcepts.filter((c) => (c.credit ?? 0) === 0);
  const coreGaps = ratioSet.filter((c) => isCoreGap(c, title)).map((c) => c.concept);

  // A declared NOT_HELD credential. Nothing adjacent substitutes.
  const gatingGaps = scored.filter((c) => c.requirementClass === "GATING_CREDENTIAL" && (c.credit ?? 0) === 0
    && c.credentialFamily && input.credentialDeclarations[c.credentialFamily] === "NOT_HELD").map((c) => c.concept);
  // UNKNOWN stays UNKNOWN. An undeclared family is a question for a
  // person, and inferring absence from silence is the failure this
  // whole profile is built to avoid.
  const unknownGates = concepts.filter((c) => c.credit === null && c.requirementClass === "GATING_CREDENTIAL").map((c) => c.concept);

  // Unknown evidence must not improve candidacy by disappearing.
  //
  // `scored` drops every concept whose credit is null, which is right:
  // an unresolved requirement is not a failed one and must not be
  // counted against him. But it also leaves the DENOMINATOR, and that is
  // only harmless while unresolved requirements are incidental.
  //
  // They are not any more. The evidence layer can now resolve a central
  // requirement to UNKNOWN on purpose, and SpotHero showed what that
  // does: "3+ years of legal operations experience or 5+ years of
  // operations experience" resolved UNKNOWN, left the denominator, and
  // the hard ratio became 1/1. The model then reported that he meets the
  // hard requirements of a job whose defining requirement it had not
  // established at all.
  //
  // The answer is not to give it credit, and not to score it as zero.
  // Both would assert something the evidence does not say. Material
  // uncertainty about the substance of the role is a question for a
  // person, which is what MANUAL_REVIEW means, and it is the same
  // judgement already made for an unresolved gating credential.
  //
  // Scope is deliberately narrow: HARD, not baseline, not a credential
  // gate (arm 3 owns those), and either role-defining by the same test
  // coreGaps uses or occupational by stratum. An unresolved PREFERRED
  // requirement, or an unresolved incidental one, changes nothing.
  const unresolvedCore = concepts.filter((c) =>
    c.weight > 0
    && c.credit === null
    && c.hardness === "HARD"
    && !c.isBaseline
    && c.requirementClass !== "GATING_CREDENTIAL"
    && (isCoreGap(c, title) || stratumOf(c, reqById) === "OCCUPATIONAL")).map((c) => c.concept);

  const base = { hardMet, hardTotal, directMatches, transferableMatches, occupational, coreGaps,
    gatingGaps, unknownGates, unresolvedCore, baselineMet, modelVersion: model };

  // Model 4's single addition. Placed so that it can only ever replace a
  // STRETCH or an APPLICATION_CANDIDATE: every REJECT arm above still
  // fires first, and both MANUAL_REVIEW arms above are unchanged. The
  // new model is therefore conservative by construction, not by
  // observation.
  const unresolvedBlocks = model >= 4 && unresolvedCore.length > 0;
  const unresolvedOut = () => out("MANUAL_REVIEW", "UNRESOLVED_ROLE_DEFINING_REQUIREMENT",
    `the substance of the role is unresolved rather than met or missing: ${unresolvedCore.join(", ")}. `
    + "It is excluded from the hard-requirement ratio, so the remaining requirements would otherwise "
    + "stand in for it; a person has to answer it instead.");
  const out = (verdict: Verdict, code: ReasonCode, reason: string): CandidacyResult =>
    ({ ...base, verdict, reasonCodes: [code], reason });

  // Nothing to assess is not the same as assessed and found wanting.
  //
  // A posting whose requirements were never extracted arrives here with
  // an empty concept set: hardTotal 0, directMatches 0, no core gaps. It
  // then fell straight through to the directMatches === 0 arm and was
  // recorded as REJECT / NO_DIRECT_EVIDENCE, which reads as "we compared
  // this against the profile and it failed." We never compared it. On
  // the last full run that mislabeled 788 of 1,436 eligible jobs, every
  // one of them un-extracted.
  //
  // This does not lower any bar. It refuses to assert a judgment that
  // was never made, and routes the job to a person instead.
  if (concepts.length === 0) return out("MANUAL_REVIEW", "POSTING_NOT_ASSESSED",
    "the posting's requirements have not been extracted, so no comparison against the profile has happened");

  if (gatingGaps.length) return out("REJECT", "DISQUALIFYING_CREDENTIAL",
    `a required credential is declared NOT_HELD: ${gatingGaps.join(", ")}`);
  if (unknownGates.length) return out("MANUAL_REVIEW", "UNKNOWN_GATING_CREDENTIAL",
    `an unresolved gating credential a person must answer: ${unknownGates.join(", ")}`);
  if (coreGaps.length >= 2) return out("REJECT", "MULTIPLE_CORE_GAPS",
    `${coreGaps.length} role-defining requirements unmet: ${coreGaps.join(", ")}`);
  if (coreGaps.length === 1) {
    const supported = hardTotal > 0 && hardMet / hardTotal >= 0.5 && directMatches >= 2;
    if (!supported) return out("REJECT", "CORE_GAP_WITHOUT_SUPPORT",
      `role-defining gap (${coreGaps[0]}) with only ${hardMet}/${hardTotal} hard met and ${directMatches} direct match(es)`);
    // A gap AND an unresolved role-defining requirement is not a stretch
    // anyone can assess from here.
    if (unresolvedBlocks) return unresolvedOut();
    return out("STRETCH", "CORE_GAP_WITHOUT_SUPPORT",
      `one role-defining gap (${coreGaps[0]}) against ${hardMet}/${hardTotal} hard requirements met`);
  }
  // A stretch reaches from a foothold. No direct evidence is no foothold,
  // and having LESS evidence must never be a route to surviving.
  if (directMatches === 0) return out("REJECT", "NO_DIRECT_EVIDENCE",
    `no direct evidence for anything the posting asks (${transferableMatches} transferable only)`);
  if (unresolvedBlocks) return unresolvedOut();
  if (occAbsent.length) return out("STRETCH", "OCCUPATIONAL_GAP",
    `the occupational substance is not established: ${occAbsent.map((c) => c.concept).join(", ")}`);
  // No denominator is not a passing score.
  //
  // hardTotal counts the HARD requirements that discriminate: baseline
  // ones are excluded because holding a bachelor's degree says nothing
  // about whether he can do the job. A posting whose only HARD
  // requirement is that degree therefore arrives with hardTotal 0, and
  // "hardTotal === 0 ||" waved it through as MEETS_HARD_REQUIREMENTS
  // having tested nothing. That produced 17 of 23 candidates on the
  // 2026-09-01 run, nearly all UChicago research roles whose real
  // substance (transgenic mouse colonies, clinical trial documentation,
  // social science research methods) the posting lists as PREFERRED and
  // which he matched none of.
  //
  // This changes no threshold. The 50% bar below is untouched and still
  // decides every posting that states a requirement to test. It only
  // stops an empty set from counting as a cleared bar, and sends the
  // judgment to a person instead.
  if (hardTotal === 0) return out("MANUAL_REVIEW", "NO_DISCRIMINATING_REQUIREMENTS",
    "the posting states no hard requirement that discriminates, so there was nothing to test against");

  return hardMet / hardTotal >= 0.5
    ? out("APPLICATION_CANDIDATE", "MEETS_HARD_REQUIREMENTS", `no role-defining or occupational gap; ${hardMet}/${hardTotal} hard requirements met`)
    : out("STRETCH", "LOW_HARD_RATIO", `no role-defining or occupational gap, but only ${hardMet}/${hardTotal} hard requirements met`);
}

/** May a job in this state be prepared as an application? */
export const mayPrepare = (v: Verdict) => v === "APPLICATION_CANDIDATE" || v === "STRETCH";
