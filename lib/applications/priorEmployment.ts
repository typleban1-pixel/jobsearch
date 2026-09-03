/**
 * A standing, user-declared truth: he has never previously worked for any
 * employer he is applying to, in any capacity.
 *
 * This is a fact about the person, not an inference from the employment
 * records, which is why it resolves VERIFIED rather than DERIVED. The
 * records could only ever support "no employer by that name appears in
 * them", which is a weaker claim and the reason this question used to
 * block whenever the wording reached past the employer's own name —
 * "or any of its affiliates" asked something the records could not
 * settle. The declaration settles it.
 *
 * What it does NOT settle is any question that merely sounds adjacent.
 * The whole value of a standing "no" is that it is scoped: prior
 * employment WITH THE PROSPECTIVE EMPLOYER. Having applied before,
 * interviewed before, worked for one of their clients, contracted for
 * some separately named company, or having a relative on staff are all
 * different questions with their own answers, and answering them from
 * this rule would be inventing facts. Those fall through to whatever
 * else can resolve them, or block.
 */

export type PriorEmploymentMatch =
  | { covered: true; why: string }
  | { covered: false; why: string; excludedBy?: string };

/**
 * Questions this rule deliberately refuses, checked BEFORE coverage.
 *
 * Order matters: several of these contain the very words that signal
 * coverage ("worked", "employed"), so a coverage-first check would
 * swallow them. "Have you ever worked for a client of ours" contains
 * "worked for"; it is not a question about working for them.
 */
const NOT_THIS_QUESTION: { re: RegExp; what: string }[] = [
  { re: /\b(?:previously |ever )?applied\b|\bprior application\b|\bsubmitted an application\b/i,
    what: "whether he has applied before" },
  { re: /\binterview(?:ed|ing)?\b/i, what: "whether he has interviewed there" },
  { re: /\brelative|\bfamily member\b|\bspouse\b|\bimmediate family\b|\bfriend(?:s)? (?:who )?work/i,
    what: "whether a relative works there" },
  { re: /\breferred (?:by|you)\b|\breferral\b/i, what: "a referral" },
  // A client, customer, or vendor of the employer is a different company.
  { re: /\b(?:client|customer|vendor|supplier)s?\b(?!\s+of\s+(?:your|the)\s+own)/i,
    what: "work for a client, customer or vendor rather than for the employer" },
  { re: /\bcurrently\s+employed\s+(?:by|at)\s+(?!us\b|this\b|our\b)/i,
    what: "current employment somewhere else" },
];

/**
 * The employer group the question is allowed to reach across.
 *
 * "This company or any of its affiliates" is still a question about the
 * prospective employer, so it is covered. It reads as an exclusion only
 * if you read "affiliate" without its possessive.
 */
const EMPLOYER_GROUP = /\b(?:or any of its\b|or its\b|affiliates?\b|subsidiar\w*|parent (?:company|organi[sz]ation)|predecessor|related (?:compan|entit)\w*)/i;

/** Wordings that are asking about prior employment with the prospective employer. */
const COVERED: { re: RegExp; what: string }[] = [
  { re: /\b(?:ever|previously|before|in the past)\b[^?.]{0,60}\b(?:work(?:ed)?|employ(?:ed|ment))\b/i,
    what: "ever worked / previously employed" },
  { re: /\b(?:work(?:ed)?|employ(?:ed|ment))\b[^?.]{0,40}\b(?:before|previously|in the past|with us|for us|here)\b/i,
    what: "worked here before" },
  { re: /\bformer\s+(?:employee|worker|staff)\b/i, what: "former employee" },
  { re: /\bprevious\s+(?:worker|employee|employment)\b/i, what: "previous worker" },
  { re: /\bprior\s+employment\b/i, what: "prior employment" },
  { re: /\bre[- ]?hire\b|\brehire eligibility\b|\bboomerang\b/i, what: "rehire" },
  // Workday names the control this even when the visible label is terse.
  { re: /\bcandidateIsPreviousWorker\b/i, what: "the Workday previous-worker control" },
];

/**
 * Decide whether the standing "no" answers this question.
 *
 * `text` should carry everything known about the control — the visible
 * label and the automation id or field key — because employers put the
 * meaning in whichever of the two they feel like.
 */
export function matchesPriorEmployment(text: string): PriorEmploymentMatch {
  const t = String(text ?? "");
  if (!t.trim()) return { covered: false, why: "no question text" };

  for (const x of NOT_THIS_QUESTION) {
    const m = x.re.exec(t);
    if (m) {
      return { covered: false, excludedBy: m[0].trim(),
        why: `this asks about ${x.what}, which the standing prior-employment answer does not cover` };
    }
  }
  for (const c of COVERED) {
    if (c.re.test(t)) {
      return { covered: true,
        why: `asks about prior employment with the prospective employer (${c.what})`
          + (EMPLOYER_GROUP.test(t) ? ", including its affiliates, which the declaration still covers" : "") };
    }
  }
  return { covered: false, why: "the wording does not ask about prior employment with this employer" };
}

/** The declared answer. Always No; there is no other value this rule produces. */
export const PRIOR_EMPLOYMENT_ANSWER = "No";
