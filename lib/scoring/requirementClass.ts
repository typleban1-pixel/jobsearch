import { toConcept } from "../matching/concepts.ts";

/**
 * What KIND of thing a requirement is, decided from the text rather than
 * from the extractor's own label.
 *
 * The pilot's TRAIT fix handled personality words. This handles the wider
 * problem the first scoring pass exposed: 20 percent of unmatched hard
 * requirements were phrases like "technology proficiency", "professional
 * experience" and "written and verbal communication". Those are not
 * capabilities anyone can hold or lack, yet each cost the same 18 points
 * as a missing professional licence.
 *
 * Six classes, and they are scored very differently:
 *
 *   GATING_CREDENTIAL  a licence, board certification or qualifying exam.
 *                      Regulated, binary, and not something adjacent
 *                      experience can substitute for.
 *   EDUCATION          a degree requirement, generic or field-specific.
 *   SKILL              a nameable capability, tool or domain.
 *   TRAIT              a personal quality.
 *   CONSTRAINT         a condition of the job rather than the person.
 *   GENERIC            a phrase with no capability content at all.
 */

export const TAXONOMY_VERSION = 1;

/**
 * Credential families.
 *
 * A posting demanding "RN compact license", "nurse practitioner license",
 * "board certification", "USMLE" and "family medicine residency" is
 * stating ONE fact five times: this job needs a clinician. Counting each
 * separately made Fit scale with how thoroughly a posting enumerated its
 * licensing, which is posting length wearing a different hat. Families
 * collapse them back to the single fact.
 */
export type CredentialFamily = "CLINICAL" | "LEGAL" | "FINANCE" | "ENGINEERING" | "OTHER";

const CREDENTIAL_FAMILIES: Array<[CredentialFamily, RegExp]> = [
  ["CLINICAL", /\b(rn|nurse|aprn|lpn|fnp|np license|physician|medical|usmle|comlex|nclex|dea|acls|bls|pals|pharmacist|pharmd|clinical|lcsw|lpc|psychologist|residency|fellowship|board certif)\b/i],
  ["LEGAL", /\b(bar admission|admitted to the bar|licensed attorney)\b/i],
  ["FINANCE", /\b(cpa|certified public accountant|series 7|series 63|series 65|finra|insurance license|cfa|cfp)\b/i],
  ["ENGINEERING", /\b(pe license|professional engineer)\b/i],
];

export function credentialFamily(text: string): CredentialFamily {
  for (const [f, re] of CREDENTIAL_FAMILIES) if (re.test(text)) return f;
  return "OTHER";
}

export type RequirementClass =
  | "GATING_CREDENTIAL" | "EDUCATION" | "SKILL" | "TRAIT" | "CONSTRAINT" | "GENERIC";

/**
 * Regulated credentials. Deliberately a NAMED list, not a keyword like
 * "license", because "driver's license" and "licensed to operate a forklift"
 * are logistical, and "software licensing experience" is a skill.
 *
 * These are the ones where adjacent experience genuinely cannot
 * substitute: you either hold the credential or you do not.
 */
const GATING_CREDENTIAL = new RegExp("\\b(?:" + [
  // clinical
  "rn license", "rn compact", "compact license", "registered nurse",
  "nurse practitioner", "\\bnp license", "\\bfnp\\b", "\\baprn\\b", "\\blpn\\b",
  "physician assistant", "\\bpa-c\\b", "medical license", "medical doctor",
  "board certification", "board certified", "usmle", "comlex", "nclex",
  "dea registration", "acls", "\\bbls\\b", "pals certification",
  "pharmacist license", "pharmd", "licensed clinical", "\\blcsw\\b", "\\blpc\\b",
  "psychologist license", "residency in", "fellowship in", "medical residency",
  // other regulated professions
  "bar admission", "admitted to the bar", "licensed attorney",
  "\\bcpa\\b", "certified public accountant", "\\bpe license", "professional engineer license",
  "series 7", "series 63", "series 65", "finra", "insurance license",
  "real estate license", "\\bcfa\\b", "\\bcfp\\b",
].join("|") + ")\\b", "i");

const EDUCATION_REQ =
  /\b(bachelor|bachelors|ba\b|bs\b|b\.s\.|b\.a\.|master|masters|ms\b|m\.s\.|mba|doctoral|doctorate|phd|ph\.d\.|associate degree|associates degree|degree in|four-year degree)\b/i;

/**
 * Phrases with no capability content. Matched against the WHOLE concept,
 * so "communication" alone is generic while "technical communication with
 * enterprise IT teams" is not.
 */
const PURE_GENERIC = new Set([
  "professional experience", "relevant experience", "prior experience", "work experience",
  "industry experience", "technology proficiency", "technical proficiency",
  "written and verbal communication", "verbal and written communication",
  "written communication", "verbal communication", "oral communication",
  "communication", "communications", "communication skills",
  "interpersonal", "interpersonal communication",
  "problem solving", "problem-solving", "critical thinking", "analytical thinking",
  "attention to detail", "detail orientation", "time management", "organization",
  "organizational", "multitasking", "prioritization", "adaptability", "flexibility",
  "collaboration", "teamwork", "team player", "self-starter", "self starter",
  "work ethic", "professionalism", "reliability", "accountability", "ownership",
  "curiosity", "growth mindset", "positive attitude", "passion", "motivation",
  "leadership", "leadership skills", "presentation skills", "presentation",
  "business acumen", "technical acumen", "customer focus", "customer service",
  "results driven", "results-oriented", "data driven", "data-driven",
]);

/**
 * Generic by SHAPE rather than by exact string.
 *
 * "Communication" is a trait whatever adjective precedes it: technical
 * communication, executive communication, stakeholder communication and
 * written communication are all the same non-capability. Enumerating
 * every adjective would be endless, so the head noun decides.
 */
const GENERIC_BY_SHAPE: RegExp[] = [
  /^(?:\w+\s+){0,2}communications?$/i,
  /^(?:\w+\s+){0,2}(?:collaboration|teamwork|professionalism|adaptability|flexibility)$/i,
  /^(?:emotional intelligence|executive presence|business sense|common sense|soft skills)$/i,
  /^technolog(?:y|ies)$/i,
  /^(?:general|broad|strong|solid)$/i,
];

/** Personal qualities that are not in the pure-generic list but still traits. */
const TRAIT_MARKER =
  /\b(mindset|attitude|passionate|passion for|self-motivat|entrepreneurial|resilien|empathy|humility|integrity|judgment|judgement|thrives?|comfortable with ambiguity|bias for action|sense of urgency)\b/i;

const CONSTRAINT_MARKER =
  /\b(travel|shift|schedule|weekend|overtime|on-?call|time zone|lift|stand for|walk|physically|pounds|lbs|authorized to work|work authorization|sponsor|visa|clearance|must reside|must live|based in|relocate|driver'?s license|valid driver)\b/i;

export interface ClassifiedRequirement {
  concept: string;
  credentialFamily: CredentialFamily | null;
  requirementClass: RequirementClass;
  /** For EDUCATION: the field named, if any. */
  educationField: string | null;
  /** For EDUCATION: the level named. */
  educationLevel: "ASSOCIATE" | "BACHELOR" | "MASTER" | "DOCTORATE" | null;
  reason: string;
}

export function classifyRequirement(rawText: string, normalizedTerm: string): ClassifiedRequirement {
  const concept = toConcept(normalizedTerm || rawText).concept;
  const haystack = `${normalizedTerm} ${rawText}`;

  if (GATING_CREDENTIAL.test(haystack)) {
    return { concept, credentialFamily: credentialFamily(haystack),
             requirementClass: "GATING_CREDENTIAL", educationField: null, educationLevel: null,
             reason: "names a regulated licence, board certification or qualifying exam" };
  }
  if (EDUCATION_REQ.test(haystack)) {
    const level = /\b(phd|ph\.d\.|doctoral|doctorate)\b/i.test(haystack) ? "DOCTORATE"
                : /\b(master|masters|ms\b|m\.s\.|mba)\b/i.test(haystack) ? "MASTER"
                : /\b(associate degree|associates degree)\b/i.test(haystack) ? "ASSOCIATE"
                : "BACHELOR";
    const m = haystack.match(/\bdegree\s+in\s+(?:a\s+)?([a-z][\w\s,\/&-]{2,50})/i);
    let field = m?.[1]?.trim().replace(/\b(field|discipline|or related|related)\b.*$/i, "").trim() || null;
    if (field && field.length < 3) field = null;
    return { concept, credentialFamily: null, requirementClass: "EDUCATION", educationField: field, educationLevel: level as any,
             reason: field ? `degree requirement in ${field}` : "generic degree requirement" };
  }
  if (CONSTRAINT_MARKER.test(haystack)) {
    return { concept, credentialFamily: null, requirementClass: "CONSTRAINT", educationField: null, educationLevel: null,
             reason: "a condition of the job rather than a capability" };
  }
  if (PURE_GENERIC.has(concept) || GENERIC_BY_SHAPE.some((re) => re.test(concept))) {
    return { concept, credentialFamily: null, requirementClass: "GENERIC", educationField: null, educationLevel: null,
             reason: "phrase carries no capability content" };
  }
  if (TRAIT_MARKER.test(haystack)) {
    return { concept, credentialFamily: null, requirementClass: "TRAIT", educationField: null, educationLevel: null,
             reason: "a personal quality" };
  }
  return { concept, credentialFamily: null, requirementClass: "SKILL", educationField: null, educationLevel: null,
           reason: "a nameable capability, tool or domain" };
}
