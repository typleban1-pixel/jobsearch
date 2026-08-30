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

export const EDUCATION_VERSION = 1;

const LEVEL_ORDER: Record<string, number> = { ASSOCIATE: 1, BACHELOR: 2, MASTER: 3, DOCTORATE: 4 };

/** The posting says a degree is one route among several. */
const ESCAPE_CLAUSE =
  /\b(or\s+(?:equivalent|relevant|related|comparable|commensurate)\s+(?:experience|work experience|practical experience)|or\s+equivalent\b|in lieu of a degree|equivalent practical experience|or\s+relevant\s+experience)\b/i;

export interface EducationRecord { level: string; field: string | null }

export type EducationVerdict = "SATISFIED" | "NOT_SATISFIED" | "UNKNOWN";

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
  // Field-specific with no escape clause. Field equivalence mappings are
  // deliberately NOT applied here yet: the user asked to see them before
  // they affect any score.
  return { verdict: "NOT_SATISFIED",
           detail: `requires a degree in ${requiredField}; verified education is in a different field` };
}
