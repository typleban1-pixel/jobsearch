/**
 * Telling an ordinary verification code apart from a human-presence check.
 *
 * The email cannot answer this on its own. "Security code for your
 * application to Stripe" is the subject line whether the board wants to
 * confirm an address or confirm a person, so the classification is made
 * from what the FORM asked for, and the email is only evidence about the
 * code itself.
 *
 * Three outcomes, and only one of them permits extraction:
 *
 *   ORDINARY_OTP    the page is verifying an address or an account
 *   HUMAN_PRESENCE  the page says it is checking for a human, or shows a
 *                   CAPTCHA. Always a handoff.
 *   UNKNOWN         everything else, which is the default, so unfamiliar
 *                   wording degrades to a handoff rather than to a guess.
 *
 * Both HUMAN_PRESENCE and UNKNOWN stop. That asymmetry is deliberate: a
 * wrong ORDINARY_OTP defeats a control the employer put there on purpose,
 * and a wrong handoff costs twenty seconds.
 */

export type Classification = "ORDINARY_OTP" | "HUMAN_PRESENCE" | "UNKNOWN";

/** What the live form is showing when it asks for a code. */
export type PageContext = {
  /** Visible text of the page. */
  text: string;
  /** A CAPTCHA challenge is displayed, as opposed to an invisible widget. */
  captchaChallengeVisible?: boolean;
};

/**
 * A claim to be checking for a human. Checked first and it always wins:
 * a page that says both "verify your email" and "confirm you are a human"
 * is asserting the second, and the second is the one that matters.
 */
const HUMAN_PRESENCE = [
  /confirm (?:that )?you(?:'|’)?re a human/i,
  /confirm (?:that )?you are a human/i,
  /prove (?:that )?you(?:'|’)?re (?:a )?human/i,
  /prove (?:that )?you are (?:a )?human/i,
  /(?:you are |you're |i'm |i am )?not a robot/i,
  /human verification/i,
  /verify (?:that )?you(?:'|’)?re (?:a )?human/i,
  /verify (?:that )?you are (?:a )?human/i,
  /captcha/i,
];

/** The page is asking for a code at all. Necessary, nowhere near sufficient. */
const ASKS_FOR_CODE = [
  /verification code/i, /security code/i, /confirmation code/i,
  /one.?time (?:code|passcode|password)/i, /\botp\b/i, /sign.?in code/i,
];

/**
 * The page saying what it is verifying, and naming an address or an
 * account rather than a person. Without one of these the answer is
 * UNKNOWN, which is why Stripe's "enter the code to confirm you're a
 * human" is never reachable from here even if the wording changed to
 * drop the human claim: it would still have to say what it verifies.
 */
const ORDINARY_PURPOSE = [
  /verify your email(?: address)?/i,
  /confirm your email(?: address)?/i,
  /verify your account/i,
  /sign.?in code/i,
  /log ?in code/i,
  /authentication code/i,
  /to (?:sign|log) in/i,
];

export type Verdict = {
  classification: Classification;
  /** Safe to log. Explains the routing, quotes no code, quotes no body. */
  why: string;
  /** Only ORDINARY_OTP may proceed; the other two are handoffs. */
  mayExtract: boolean;
};

/**
 * Whether the page is asking for a code at all. The caller needs this
 * separately from classify(): "there is no challenge here" and "there is
 * a challenge I do not recognize" are different situations, and only the
 * second one is a handoff worth reporting.
 */
export function asksForCode(text: string): boolean {
  return ASKS_FOR_CODE.some((re) => re.test(text ?? ""));
}

export function classify(page: PageContext): Verdict {
  const text = page.text ?? "";

  if (page.captchaChallengeVisible) {
    return {
      classification: "HUMAN_PRESENCE", mayExtract: false,
      why: "a CAPTCHA challenge is displayed",
    };
  }
  const human = HUMAN_PRESENCE.find((re) => re.test(text));
  if (human) {
    return {
      classification: "HUMAN_PRESENCE", mayExtract: false,
      why: `the page states it is checking for a human (${human.source.slice(0, 40)})`,
    };
  }
  if (!ASKS_FOR_CODE.some((re) => re.test(text))) {
    return { classification: "UNKNOWN", mayExtract: false, why: "the page is not asking for a code" };
  }
  if (!ORDINARY_PURPOSE.some((re) => re.test(text))) {
    return {
      classification: "UNKNOWN", mayExtract: false,
      why: "the page asks for a code without saying it is verifying an address or an account",
    };
  }
  return {
    classification: "ORDINARY_OTP", mayExtract: true,
    why: "the page is verifying an address or an account and makes no claim about being human",
  };
}

/** How long a code the page asked for, when it says so. */
export function expectedCodeLength(text: string): number | null {
  const m = /(\d{1,2})[\s-]?(?:character|digit|letter)/i.exec(text ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 4 && n <= 12 ? n : null;
}

/** Describes a handoff without quoting anything that could be entered. */
export function describeHandoff(subject: string, from: string, why: string): string {
  return `"${subject}" from ${from} stops at HANDOFF: ${why}. `
    + "A person has to read the code and enter it.";
}
