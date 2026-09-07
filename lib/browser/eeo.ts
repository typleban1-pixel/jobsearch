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
  // "Veterans Status" is Workday's label; the plural has to count.
  return /\bgender\b|gender identity|\brace\b|ethnicit|\bveterans?\b|\bdisabilit/i.test(t)
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

/** Whether an offered option is the form's own "prefer not to answer". */
export function isDeclineOption(text: string): boolean { return DECLINE.test(String(text ?? "")); }

/**
 * A voluntary self-identification question: the EEO categories plus the
 * broader self-ID surveys employers add (age bracket, communities,
 * orientation, neurodivergence). Only ever used to decide whether an
 * OPTIONAL, unanswered question may take the form's decline option.
 */
export function isVoluntarySelfIdField(label: string): boolean {
  const t = String(label ?? "");
  return isDemographicField(t)
    || /\b(?:your (?:current )?age|age (?:range|bracket|group)|communit(?:y|ies) (?:do you|you) (?:belong|identify)|identify (?:with|as)|gender identity|sexual orientation|neurodiverg|lgbtq|first[- ]generation|socio-?economic)\b/i.test(t);
}

/**
 * Disability self-identification is a standard Yes / No / decline
 * question, and the stored answer states the fact: "No, I do not have a
 * disability and have not had one in the past." Employers word the
 * options differently -- some spell out that whole federal sentence,
 * others offer a bare "No" -- so an exact match often misses even though
 * the truthful answer is plainly on offer. Declining then would refuse a
 * question the person has actually answered.
 *
 * These map the stored answer to the option of the SAME polarity and
 * nothing else: a "No" answer to the form's "No", a "Yes" to its "Yes".
 * The mapping is deliberately narrow. It reads only the leading yes/no
 * and the standard "(do not) have a disability" phrasing, never infers,
 * requires EXACTLY ONE same-polarity option to exist, and otherwise
 * falls through to the decline path. A stored answer that is itself a
 * decline has no polarity and is left to decline.
 */
export function isDisabilityField(label: string): boolean {
  return /\bdisabilit|impairment/i.test(String(label ?? ""));
}

const DISABILITY_YES = /^\s*yes\b|\bi have (?:a |an )?(?:disab|impairment|condition)|have had (?:a\b|one\b)|had one in the past/i;
const DISABILITY_NO = /^\s*no\b|(?:do not|don'?t|does not|doesn'?t) have (?:a |an )?(?:disab|impairment|condition)|have (?:never had|not had)|\bno disab/i;

type DisabilityPolarity = "YES" | "NO" | null;
function disabilityPolarity(text: string): DisabilityPolarity {
  const t = String(text ?? "");
  // Decline wording is neither pole, even when it contains the word "no".
  if (DECLINE.test(t)) return null;
  if (DISABILITY_NO.test(t)) return "NO";
  if (DISABILITY_YES.test(t)) return "YES";
  return null;
}

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
export function resolveEeoOption(answer: string, options: string[], fieldLabel?: string): EeoChoice {
  const opts = options.filter((o) => String(o ?? "").trim());
  if (!opts.length) return { kind: "NONE", why: "the control offered no options" };
  const want = norm(answer);

  const exact = opts.find((o) => norm(o) === want);
  if (exact) return { kind: "EXACT", option: exact };
  // The federal race categories carry a qualifier the answer does not:
  // "White (Not Hispanic or Latino)" is the category "White". The
  // qualifier is dropped for comparison only; the option is returned as
  // the employer wrote it.
  // The choosable label: a glued-on federal definition ("...A person having
  // origins in...") and the "(Not Hispanic or Latino)" qualifier are not
  // part of the category the person chose.
  const bare = (o: string) => norm(o)
    .replace(/(?<=[)a-z])\s*(?:a person|all persons|individuals|a veteran|persons)\b.*$/, "")
    .replace(/\s*\((?:not )?hispanic or latino\)$/, "").trim();
  const bareExact = opts.filter((o) => bare(o) === want);
  if (bareExact.length === 1) return { kind: "EXACT", option: bareExact[0]! };
  // A compound category whose FIRST name is the answer: "White or European
  // descent", "Black or African American", "Hispanic/Latino". The answer
  // names the category; the employer added a second name for it.
  const compound = opts.filter((o) => bare(o).split(/\s+or\s+|\s*\/\s*/)[0]!.trim() === want && /\s+or\s+|\//.test(bare(o)));
  if (compound.length === 1) return { kind: "SYNONYM", option: compound[0]! };

  // A synonym of the answer that the control actually offers, taken in
  // preference order so the plainest equivalent wins.
  for (const syn of SYNONYMS[want] ?? []) {
    const o = opts.find((x) => norm(x) === syn);
    if (o) return { kind: "SYNONYM", option: o };
  }
  // Or the answer is a synonym the option lists under a standard term.
  for (const o of opts) if ((SYNONYMS[norm(o)] ?? []).includes(want)) return { kind: "SYNONYM", option: o };

  // Disability: the stored answer states the fact, so map it to the
  // option of the same polarity before ever declining. Requires exactly
  // one same-polarity option so an unexpected option set falls through
  // safely rather than picking one of several.
  if (fieldLabel && isDisabilityField(fieldLabel)) {
    const pole = disabilityPolarity(answer);
    if (pole) {
      const same = opts.filter((o) => disabilityPolarity(o) === pole);
      if (same.length === 1) return { kind: "SYNONYM", option: same[0]! };
    }
  }

  const decline = opts.find((o) => DECLINE.test(o));
  if (decline) return { kind: "DECLINE", option: decline };

  return { kind: "NONE", why: `no exact, synonym, or decline option among: ${opts.slice(0, 8).join(", ")}` };
}
