/**
 * Telling an ordinary verification code apart from a human-presence check.
 *
 * The email cannot answer this on its own. "Security code for your
 * application to Stripe" is the subject line whether the board wants to
 * confirm an address or confirm a person, so the classification is made
 * from what the FORM asked for, and the email is only evidence about the
 * code itself.
 *
 * Four outcomes, and two of them permit extraction:
 *
 *   ORDINARY_OTP    the page is verifying an address or an account
 *   EMAILED_CODE    the page says it just mailed a code to the applicant's
 *                   own inbox and shows a field to type it back. Retrieving
 *                   it from that mailbox is exactly the round-trip the
 *                   board asked for, so this extracts under all of otp.ts's
 *                   constraints -- even when the page frames the round-trip
 *                   as "enter the code to confirm you're a human," which is
 *                   how Greenhouse words it.
 *   HUMAN_PRESENCE  the page shows a CAPTCHA, or claims to check for a
 *                   human WITHOUT having mailed a code. Always a handoff.
 *   UNKNOWN         everything else, which is the default, so unfamiliar
 *                   wording degrades to a handoff rather than to a guess.
 *
 * HUMAN_PRESENCE and UNKNOWN stop. The asymmetry is deliberate: a wrong
 * ORDINARY_OTP/EMAILED_CODE defeats a control the employer put there on
 * purpose, and a wrong handoff costs twenty seconds. A genuinely visible
 * CAPTCHA is checked first and always wins -- a puzzle is not a mailed
 * code, so the emailed-code path can never reach one.
 */

export type Classification = "ORDINARY_OTP" | "EMAILED_CODE" | "HUMAN_PRESENCE" | "UNKNOWN";

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

/**
 * The page telling you it just put a code in the applicant's own inbox.
 *
 * This is the signature of an email round-trip: the board mails a code to
 * the very mailbox this system reads, and typing it back is the proof of
 * presence the board wanted. Because that is what the flow IS, the
 * human-confirmation wording that Greenhouse wraps around it ("enter the
 * code to confirm you're a human") is not, on its own, a reason to hand
 * off -- the code was demonstrably mailed to our address, and otp.ts will
 * only accept a message that actually came from this board, named this
 * employer, and arrived after the form asked. A visible CAPTCHA is still
 * checked before this and still always wins.
 *
 * Narrow on purpose: it must say a code was SENT/EMAILED to an address or
 * to "your email/inbox", or tell you to CHECK your email/inbox for one.
 * A page that only says "confirm you're a human" matches none of these.
 */
const EMAILED_TO_INBOX = [
  // "a verification code was sent to name@example.com" / "code sent to your email"
  /\bcode\b[^.!?]{0,60}\b(?:sent|emailed|delivered)\s+to\s+(?:\S+@\S+|your\s+(?:e-?mail|inbox))/i,
  // "we emailed you a code" / "we've sent you a verification code"
  /\b(?:sent|emailed)\s+(?:you\s+)?(?:a|an|the)\b[^.!?]{0,40}\bcode\b/i,
  // "check your email/inbox for the code"
  /check\s+your\s+(?:e-?mail|inbox)\b[^.!?]{0,60}\bcode\b/i,
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

  // A genuinely visible puzzle is unsolvable and is never a mailed code.
  // Checked first so nothing below can reach past it.
  if (page.captchaChallengeVisible) {
    return {
      classification: "HUMAN_PRESENCE", mayExtract: false,
      why: "a CAPTCHA challenge is displayed",
    };
  }
  // An emailed code sent to our own inbox is extractable even when the
  // page frames it as a human check, because the email round-trip IS the
  // human check. This sits above the human-presence text test on purpose:
  // "confirm you're a human" is Greenhouse's label for exactly this flow.
  if (ASKS_FOR_CODE.some((re) => re.test(text)) && EMAILED_TO_INBOX.some((re) => re.test(text))) {
    return {
      classification: "EMAILED_CODE", mayExtract: true,
      why: "the page says a code was mailed to this inbox and offers a field to enter it",
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
