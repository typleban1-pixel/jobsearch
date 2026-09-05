/**
 * Requirement kinds fall into three classes that must be scored
 * differently. The pilot showed why: treating them alike penalised a
 * posting for every personal quality it happened to list.
 */

export type KindClass = "SKILL_MATCHABLE" | "CONSTRAINT" | "TRAIT";

const CLASS_BY_KIND: Record<string, KindClass> = {
  SKILL: "SKILL_MATCHABLE",
  TOOL: "SKILL_MATCHABLE",
  CREDENTIAL: "SKILL_MATCHABLE",
  EDUCATION: "SKILL_MATCHABLE",
  DOMAIN: "SKILL_MATCHABLE",
  EXPERIENCE_YEARS: "SKILL_MATCHABLE",
  // Conditions of the job, not qualities of the person. Checkable, but
  // against profile attributes (work authorization, location, travel
  // tolerance) rather than against a skills table. Matching them against
  // skills guarantees a miss, which is the same false penalty traits had.
  LEGAL: "CONSTRAINT",
  LOGISTICAL: "CONSTRAINT",
  // OTHER sits here because that is what the pilot actually put in it:
  // "ambiguity tolerance", "self-motivation and ownership mindset".
  TRAIT: "TRAIT",
  OTHER: "TRAIT",
  // A duty the role performs (extractor kind RESPONSIBILITY, RB-v2 Step 1).
  // Scored as a TRAIT: out of skill-Fit, so a job's duties never create a
  // false absent-capability penalty against the skills table.
  RESPONSIBILITY: "TRAIT",
};

export function classOfKind(kind: string): KindClass {
  return CLASS_BY_KIND[kind] ?? "TRAIT";
}
