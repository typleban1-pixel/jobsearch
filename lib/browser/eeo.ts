/**
 * Demographic self-identification fields, matched to an employer's own
 * option vocabulary.
 *
 * These EEO questions -- gender, race, veteran status, disability -- are
 * asked with wording that varies by employer: a stored "Male" meets a
 * control that offers "Man", and "White" meets one that spells it
 * differently. The person asked that, where the exact answer is not
 * offered, an obvious synonym be used, and where none fits, the form's
 * own decline-to-answer option be selected so a required field is
 * satisfied without asserting anything unmapped.
 *
 * Two hard limits. Synonyms are a short curated list of universally
 * standard equivalences, never an inference about identity. And this
 * runs ONLY for a field this recognises as demographic; every other
 * field still matches exactly and fails closed.
 */

export function isDemographicField(label: string): boolean {
  const t = String(label ?? "");
  return /\bgender\b|gender identity|\brace\b|ethnicit|\bveteran\b|\bdisabilit/i.test(t)
    // "How do you identify?" is Greenhouse's phrasing for gender/race.
    || /how do you identify/i.test(t);
}

/**
 * Universally standard equivalences, both directions. Not an identity
 * mapping: only the cases where two spellings unambiguously denote the
 * same standard category. A stored answer that is not one of these is
 * matched exactly or declined, never guessed.
 */
const SYNONYMS: Record<string, string[]> = {
  // In preference order: the plainest equivalent first. "Man" is
  // preferred over "Cis-man" because the latter asserts cisgender, which
  // the stored answer does not state.
  male: ["man", "cis man", "cis-man", "cisgender man"],
  female: ["woman", "cis woman", "cis-woman", "cisgender woman"],
  man: ["male"],
  woman: ["female"],
};

const DECLINE = /\b(decline|do not wish|don'?t wish|prefer not|not to (?:answer|say|disclose|identify)|i (?:do not|don'?t) wish|wish not to|choose not)\b/i;

const norm = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export type EeoChoice =
  | { kind: "EXACT"; option: string }
  | { kind: "SYNONYM"; option: string }
  | { kind: "DECLINE"; option: string }
  | { kind: "NONE"; why: string };

/**
 * The option to select for a demographic answer, in priority order:
 * the exact option, then a standard synonym, then the decline option.
 */
export function resolveEeoOption(answer: string, options: string[]): EeoChoice {
  const opts = options.filter((o) => String(o ?? "").trim());
  if (!opts.length) return { kind: "NONE", why: "the control offered no options" };
  const want = norm(answer);

  const exact = opts.find((o) => norm(o) === want);
  if (exact) return { kind: "EXACT", option: exact };

  // A synonym of the answer that the control actually offers, taken in
  // preference order so the plainest equivalent wins.
  for (const syn of SYNONYMS[want] ?? []) {
    const o = opts.find((x) => norm(x) === syn);
    if (o) return { kind: "SYNONYM", option: o };
  }
  // Or the answer is a synonym the option lists under a standard term.
  for (const o of opts) if ((SYNONYMS[norm(o)] ?? []).includes(want)) return { kind: "SYNONYM", option: o };

  const decline = opts.find((o) => DECLINE.test(o));
  if (decline) return { kind: "DECLINE", option: decline };

  return { kind: "NONE", why: `no exact, synonym, or decline option among: ${opts.slice(0, 8).join(", ")}` };
}
