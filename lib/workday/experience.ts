/**
 * Workday's My Experience page, answered from frozen truth.
 *
 * Its labels are bare -- "Company", "Job Title", "School or University"
 * -- and the intent matcher cannot read them: "Company" on its own could
 * as easily mean the company being applied to. What disambiguates them
 * is the section they sit in, which Workday states in a heading above
 * each block, so the section is carried into the match instead of being
 * guessed from the label.
 *
 * Nothing here is Northern Trust specific; every Workday tenant renders
 * My Experience from the same template.
 */

export type ExperienceRow = { employer: string; title: string; location?: string | null; isCurrent?: boolean };
export type EducationRow = { institution: string; credential?: string | null; fieldOfStudy?: string | null };

export type SectionField = { key: string; label: string; section: string; required: boolean };

export type Answer = { key: string; label: string; value: string; why: string };

const norm = (s: string) => String(s ?? "").replace(/\s+/g, " ").replace(/\*+$/, "").trim().toLowerCase();

/**
 * The record a "current or most recent" question means.
 *
 * The frozen history holds overlapping rows -- the same employer appears
 * twice with different spans -- so "most recent" is decided by the
 * current flag first and never by position alone.
 */
export function currentRole(rows: ExperienceRow[]): ExperienceRow | null {
  if (!rows.length) return null;
  const current = rows.filter((r) => r.isCurrent);
  if (current.length === 1) return current[0]!;
  if (current.length > 1) return null;          // ambiguous; a person decides
  return rows[0] ?? null;                        // the loader orders newest first
}

/** The single education record, or nothing when there is a choice to make. */
export function soleEducation(rows: EducationRow[]): EducationRow | null {
  return rows.length === 1 ? rows[0]! : null;
}

/**
 * What each field in a Work Experience or Education section should hold.
 *
 * Returns answers only for fields it can ground in a record. Anything
 * else is left for the ordinary resolver or for a person: a blank here
 * means "not answered", never "answered with nothing".
 */
export function experienceAnswers(
  fields: SectionField[], employment: ExperienceRow[], education: EducationRow[],
): { answers: Answer[]; unresolved: SectionField[] } {
  const role = currentRole(employment);
  const school = soleEducation(education);
  const answers: Answer[] = [];
  const unresolved: SectionField[] = [];

  for (const f of fields) {
    const sec = norm(f.section), label = norm(f.label);
    let value: string | null = null, why = "";

    if (/work experience/.test(sec)) {
      if (!role) { if (f.required) unresolved.push(f); continue; }
      if (label === "company") { value = role.employer; why = "the current employment record"; }
      else if (label === "job title") { value = role.title; why = "the current employment record"; }
      else if (label === "location" && role.location) { value = role.location; why = "the current employment record"; }
    } else if (/education/.test(sec)) {
      if (!school) { if (f.required) unresolved.push(f); continue; }
      if (/school or university|^university$|^college$|^institution$/.test(label)) {
        value = school.institution; why = "the education record";
      } else if (label === "field of study" && school.fieldOfStudy) {
        value = school.fieldOfStudy; why = "the education record";
      } else if (label === "degree" && school.credential) {
        value = school.credential; why = "the education record";
      }
    }

    if (value) answers.push({ key: f.key, label: f.label, value, why });
    else if (f.required) unresolved.push(f);
  }
  return { answers, unresolved };
}
