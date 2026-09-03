/**
 * Workday's skill picker is a search box, not a dropdown.
 *
 * Nothing appears until a term is typed AND Enter is pressed; only then
 * does Workday populate a Search Results list of up to thirty
 * checkboxes. Opening the control and reading it, the way an ordinary
 * listbox is read, reports "No Items." for every skill a person
 * possesses -- which is exactly what it did here for Project, Excel and
 * Google Analytics.
 *
 * Typed text is a query, never a selection. The committed list is the
 * only evidence a skill was added.
 */

export type SkillResult = { label: string; checked: boolean };

export type SkillChoice =
  | { ok: true; label: string; why: string }
  | { ok: false; why: string; offered: string[] };

const norm = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The one result that IS the skill.
 *
 * Exact first. Then a punctuation-insensitive comparison, so "Microsoft
 * Excel" matches "Microsoft Excel." and "Cross-department collaboration"
 * matches "Cross Department Collaboration" -- same words, same skill.
 * Never a prefix or a containment: "Project" would otherwise select
 * "Project Finance", and a skill nobody has is a false claim.
 */
export function chooseSkill(results: SkillResult[], wanted: string): SkillChoice {
  const offered = results.map((r) => r.label);
  if (!results.length) return { ok: false, why: "the search returned no results", offered };

  const want = norm(wanted);
  const exact = results.filter((r) => norm(r.label) === want);
  if (exact.length === 1) return { ok: true, label: exact[0]!.label, why: "an exact match" };
  if (exact.length > 1) return { ok: false, why: `${exact.length} results share that exact name`, offered };

  const loose = (s: string) => norm(s).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const same = results.filter((r) => loose(r.label) === loose(wanted));
  if (same.length === 1) return { ok: true, label: same[0]!.label, why: "the same words, differently punctuated" };
  if (same.length > 1) return { ok: false, why: `${same.length} results reduce to the same words`, offered };

  return { ok: false, why: `no result is ${JSON.stringify(wanted)}`, offered };
}

/** A committed skill list contains the skill; a query box does not. */
export function isCommitted(committed: string[], label: string): boolean {
  return committed.some((c) => norm(c) === norm(label));
}

/**
 * The state of one search box across a sequence of searches.
 *
 * A query that will not clear is not a cosmetic problem. Successive
 * terms concatenated into "PMMG", which then matched nothing, and the
 * skill looked unavailable when the search had simply never been run.
 * Worse, a concatenation can match something -- and a skill nobody
 * claimed would go onto a real application.
 *
 * So every search asserts an empty box first and asserts the box holds
 * exactly the intended term before Enter. Anything else refuses to
 * search rather than searching for a string nobody chose.
 */
export type QueryStep =
  | { ok: true; query: string }
  | { ok: false; why: string };

export function beginSearch(valueAfterClear: string, intended: string): QueryStep {
  if (valueAfterClear !== "") {
    return { ok: false, why: `the box still held ${JSON.stringify(valueAfterClear)} after clearing; refusing to type into it` };
  }
  const term = String(intended ?? "").trim();
  if (!term) return { ok: false, why: "no search term was given" };
  if (/^[A-Z]{2,}$/.test(term)) {
    // Two or more capitals and nothing else is what concatenated
    // fragments look like, never what a skill is called.
    return { ok: false, why: `${JSON.stringify(term)} is an abbreviation, not a skill name` };
  }
  return { ok: true, query: term };
}

export function confirmTyped(valueAfterType: string, intended: string): QueryStep {
  if (valueAfterType !== intended) {
    return { ok: false, why: `the box holds ${JSON.stringify(valueAfterType)} but the search is for ${JSON.stringify(intended)}` };
  }
  return { ok: true, query: intended };
}
