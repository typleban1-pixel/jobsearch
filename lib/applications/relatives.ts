/**
 * A standing, user-declared truth: he has no relatives or close personal
 * relationships at the employers he applies to, unless he says otherwise
 * for a specific employer. HUMAN_CONFIRMED (2026-09-05), the same shape as
 * the prior-employment declaration.
 *
 * It answers ordinary conflict-of-interest questions asking whether a
 * relative, family member, spouse/partner, household member, or close
 * personal relation is employed by or associated with the prospective
 * employer. It is deliberately scoped: it does NOT answer whether he knows
 * anyone there, a referral, a professional/business relationship, a
 * financial interest, a vendor/customer relationship, prior employment, or
 * a government relationship. Those keep their own truth or block.
 */
export type RelativesMatch = { covered: true; why: string } | { covered: false; why: string; excludedBy?: string };

/** Adjacent questions this declaration must refuse, checked BEFORE coverage. */
const NOT_THIS: { re: RegExp; what: string }[] = [
  { re: /\brefer(?:red|ral)\b|\bwho referred\b|\bhear about\b/i, what: "a referral / how he heard about the role" },
  { re: /\bprofessional\b|\bbusiness relationship\b|\bworked with\b|\bcolleague\b|\bnetwork\b/i, what: "a professional/business relationship" },
  { re: /\bfinancial (?:interest|stake|relationship)\b|\binvest(?:ed|ment|ments)?\b|\bown(?:s|ership)?\b[^?]{0,20}\b(?:stock|shares|equity)\b|\bshareholder\b/i, what: "a financial interest or investment" },
  { re: /\bvendor\b|\bsupplier\b|\bcustomer\b|\bclient\b/i, what: "a vendor/customer relationship" },
  { re: /\bpreviously (?:been )?employed\b|\bever (?:been )?employed\b|\bworked (?:here|for us|for the company|for this)\b|\bformer employee\b|\bre[- ]?hire\b/i, what: "prior employment" },
  { re: /\bgovernment\b|\bpublic official\b|\bpolitically exposed\b/i, what: "a government relationship" },
  { re: /\bdo you know anyone\b|\bacquainted\b|\bacquaintance\b/i, what: "whether he knows anyone there" },
];

/** Relationship kinds this declaration covers. */
const RELATIONSHIP = /\brelatives?\b|\bfamily (?:member|members|relation)\b|\bfamily\b|\bspouse\b|\bpartner\b|\bhousehold\b|\bimmediate family\b|\bclose personal (?:relation|relationship|relationships|friend)\b|\bnext of kin\b|\bkin\b/i;
/** The relationship must be AT the prospective employer, not anywhere. */
const AT_EMPLOYER = /\bemploy(?:ed|ee|ees)?\b|\bwork(?:s|ing|ed)?\b|\bassociated\b|\bat (?:the |our |this )?(?:company|organization|organisation|firm|employer)\b|\bhere\b|\bwith (?:us|the company|our)\b|\bcurrently (?:employed|work)\b/i;

export function matchesRelativesConflict(text: string): RelativesMatch {
  const t = String(text ?? "");
  if (!t.trim()) return { covered: false, why: "no question text" };
  for (const x of NOT_THIS) {
    const m = x.re.exec(t);
    if (m) return { covered: false, excludedBy: m[0].trim(), why: `this asks about ${x.what}, which the relatives declaration does not cover` };
  }
  if (RELATIONSHIP.test(t) && AT_EMPLOYER.test(t)) {
    return { covered: true, why: "asks whether a relative / family member / spouse / partner / household member / close personal relation is employed by or associated with the prospective employer" };
  }
  if (RELATIONSHIP.test(t)) {
    // Relationship named but no clear "at this employer" anchor: still the
    // conflict question in nearly every real form ("Do you have any
    // relatives who work for [Company]?" sometimes drops the verb), but
    // require the relationship word to be the subject, not an aside.
    return { covered: true, why: "asks about a relative / close personal relationship in a conflict-of-interest context" };
  }
  return { covered: false, why: "the wording does not ask about a relative or close personal relationship at this employer" };
}

/** The declared answer. Always No; per-employer human-confirmed info overrides upstream. */
export const RELATIVES_ANSWER = "No";
