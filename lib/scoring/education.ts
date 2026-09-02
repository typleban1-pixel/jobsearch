/**
 * Education requirement matching.
 *
 * Three rules, and the third is the one that stops a degree field
 * becoming a silent disqualifier.
 *
 *   A generic degree requirement is satisfied by a verified degree at or
 *   above the level asked for, whatever its title. "Bachelor's degree" is
 *   a checkbox, not a subject.
 *
 *   A field-specific requirement is NOT satisfied by an unrelated degree.
 *   A Health Science BS does not answer "degree in computer science", and
 *   pretending otherwise is exactly the adjacency inflation this system
 *   exists to prevent.
 *
 *   A field-specific requirement carrying an escape clause ("or
 *   equivalent experience", "or relevant experience") is UNKNOWN rather
 *   than failed, because the posting itself says experience can stand in
 *   and that experience is evaluated elsewhere in the score.
 */

export const EDUCATION_VERSION = 2;

// HIGH_SCHOOL is 0 rather than absent: a posting asking for a diploma
// states a real requirement, and any verified degree clears it.
const LEVEL_ORDER: Record<string, number> = { HIGH_SCHOOL: 0, ASSOCIATE: 1, BACHELOR: 2, MASTER: 3, DOCTORATE: 4 };

/** The posting says a degree is one route among several. */
const ESCAPE_CLAUSE =
  /\b(or\s+(?:equivalent|relevant|related|comparable|commensurate)\s+(?:experience|work experience|practical experience)|or\s+equivalent\b|in lieu of a degree|equivalent practical experience|or\s+relevant\s+experience)\b/i;

export interface EducationRecord { level: string; field: string | null }

export type EducationVerdict = "SATISFIED" | "NOT_SATISFIED" | "UNKNOWN";

/**
 * Broad categories that genuinely encompass a Health Science degree.
 *
 * Matched as whole alternatives inside the posting's field list, so
 * "science, engineering, technology, or mathematics" qualifies on
 * "science" while "computer science" does not qualify on the substring.
 */
const ENCOMPASSING_FIELDS: Array<[string, RegExp]> = [
  ["science", /(?:^|[,\/]|\bor\b|\band\b)\s*science\s*(?:$|[,\/]|\bor\b|\band\b)/i],
  ["health science", /\bhealth\s+sciences?\b/i],
  ["health", /(?:^|[,\/]|\bor\b)\s*health\s*(?:$|[,\/]|\bor\b)/i],
  ["life sciences", /\blife\s+sciences?\b/i],
  ["public health", /\bpublic\s+health\b/i],
];

/** Fields the degree does NOT satisfy, checked first so a list containing both fails safe. */
function fieldSatisfiedBy(requiredField: string, profileEducation: EducationRecord[]): string | null {
  const isHealthScience = profileEducation.some((e) => /health\s*science/i.test(e.field ?? ""));
  if (!isHealthScience) return null;
  for (const [label, re] of ENCOMPASSING_FIELDS) {
    if (re.test(requiredField)) return label;
  }
  return null;
}

export function assessEducation(input: {
  requiredLevel: string | null;
  requiredField: string | null;
  rawText: string;
  profileEducation: EducationRecord[];
}): { verdict: EducationVerdict; detail: string } {
  const { requiredLevel, requiredField, rawText, profileEducation } = input;

  if (profileEducation.length === 0) {
    return { verdict: "UNKNOWN", detail: "no verified education on the profile" };
  }
  const need = LEVEL_ORDER[requiredLevel ?? "BACHELOR"] ?? 2;
  const best = Math.max(...profileEducation.map((e) => LEVEL_ORDER[e.level] ?? 0));

  if (best < need) {
    return { verdict: "NOT_SATISFIED", detail: `requires ${requiredLevel ?? "BACHELOR"}; highest verified is below it` };
  }
  if (!requiredField) {
    return { verdict: "SATISFIED", detail: `generic ${requiredLevel ?? "degree"} requirement met by a verified degree at or above that level` };
  }
  if (ESCAPE_CLAUSE.test(rawText)) {
    return { verdict: "UNKNOWN",
             detail: `field-specific but the posting accepts equivalent experience, so experience is judged instead of the degree title` };
  }
  // Field equivalence, approved 30 Aug 2026 and deliberately narrow.
  //
  // A BS in Health Science satisfies a field requirement only where the
  // posting itself names a broad category the degree genuinely sits
  // inside, or lists such a category among its alternatives. Everything
  // else fails, including engineering, computer science, quantitative,
  // finance and supply chain.
  //
  // Two things it explicitly does NOT do. A bare "STEM" requirement is
  // not satisfied: whether Health Science counts as STEM depends on the
  // employer, and guessing would be the adjacency inflation this system
  // exists to prevent. And "or related field" does not broaden anything,
  // because "related" is a word the posting used, not a relationship we
  // can defend.
  const satisfying = fieldSatisfiedBy(requiredField, profileEducation);
  if (satisfying) {
    return { verdict: "SATISFIED",
             detail: `posting accepts "${satisfying}", which encompasses the verified degree` };
  }
  return { verdict: "NOT_SATISFIED",
           detail: `requires a degree in ${requiredField}; verified education is in a different field` };
}
