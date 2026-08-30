/**
 * Claim guards for employer-facing text.
 *
 * The truth profile records what may be claimed. This checks what was
 * actually written, because those are different things and only the
 * second one reaches an employer.
 *
 * The specific drift this exists to catch: "built a product" becoming
 * "built and grew a successful business". Every word in that sentence is
 * flattering, none of it is false on its own, and the whole is a claim of
 * commercial traction that does not exist. A generator will produce it
 * cheerfully because it reads well.
 *
 * Guards are data, not code, so they are inspectable and grow as the
 * profile does.
 */

export const CLAIM_GUARD_VERSION = 1;

export interface ClaimGuard {
  /** What the guard protects, for the error message. */
  subject: string;
  /** Fires when this matches the text. */
  pattern: RegExp;
  /** Why it is forbidden, in the user's terms. */
  reason: string;
}

export const CLAIM_GUARDS: ClaimGuard[] = [
  {
    subject: "RentPup traction",
    pattern: /\b(grew|scaled|scaling|acquired\s+(?:customers|users|clients)|generated\s+revenue|revenue\s+of|paying\s+customers|served\s+\d|customer\s+base|user\s+base|traction|monetiz\w*)\b/i,
    reason: "RentPup is pre-revenue with no verified customer traction. Building and operating the system is the claim; commercial outcomes are not.",
  },
  {
    subject: "RentPup employment",
    pattern: /\b(?:at|for|with)\s+RentPup\b(?![^.]*\b(?:independent|own time|side|personal)\b)|RentPup[^.]{0,30}\b(?:employer|employed|full[- ]time role|my job)\b/i,
    reason: "RentPup is an independent project built in his own time. It must never read as employment or as a substitute for full-time work.",
  },
  {
    subject: "software engineering",
    pattern: /\b(software engineer(?:ing)?|expert programmer|senior developer|full[- ]stack (?:engineer|developer))\b/i,
    reason: "AI-assisted product building is verified. Professional software-engineering expertise is not, and the user drew that line explicitly.",
  },
  {
    subject: "clinical credentials",
    pattern: /\b(licensed|certified|registered)\s+(?:nurse|clinician|practitioner|therapist|pharmacist)|\b(RN|NP|LPN|PA-C)\b/,
    reason: "Confirmed: holds no professional healthcare licence or clinical certification.",
  },
  {
    subject: "Genius Academy revenue attribution",
    // Resume bullets drop the subject: "Generated $70,000 in ARR" has no
    // pronoun and is exactly the sentence this must catch. Matching only
    // "I generated" let the most likely phrasing straight through.
    pattern: /(?:^|[.\n;]\s*|\b(?:I|he|we)\s+)(?:generated|drove|produced|earned|delivered)\s+(?:\$|more than \$|over \$|upwards of \$)?\s*\d[\d,]*\s*(?:k\b|,000)?\s*(?:in\s+)?(?:ARR|revenue|sales)/i,
    reason: "The $70,000 figure is the offering's total ARR, not revenue personally generated.",
  },
  {
    subject: "people management scope",
    pattern: /\b(?:managed|led|supervised)\s+(?:a\s+)?(?:team|department|staff)\s+of\s+\d+|\b(?:managed|led)\s+\d+\s+(?:employees|reports|people)\b/i,
    reason: "The only supervision evidence is three student employees at LCCC, day to day. Not professional-staff management.",
  },
  {
    subject: "LCCC internship program",
    pattern: /\b(?:created|built|founded|established|launched)\b[^.]{0,40}\binternship program\b/i,
    reason: "RETRACTED 30 Aug 2026: he did not create the LCCC internship program. His resume says otherwise and the resume is wrong.",
  },
  {
    subject: "regional television commercials",
    pattern: /\bregional\s+television\s+commercials?\b/i,
    reason: "RETRACTED 30 Aug 2026: the work was editing and motion graphics for the production company behind a nationally broadcast Sportsman Network show, not regional commercials. His resume describes it inaccurately.",
  },
  {
    subject: "marketing strategy ownership at Genius One",
    pattern: /\b(?:owned|led|set|directed)\s+(?:the\s+)?(?:overall\s+)?(?:company\s+)?marketing strategy\b/i,
    reason: "He did not own Genius One's overall company marketing strategy; the owner set priorities and delegated objectives. This does not limit marketing-strategy claims elsewhere.",
  },
];

export interface GuardViolation { subject: string; matched: string; reason: string }

export function checkClaims(text: string, guards: ClaimGuard[] = CLAIM_GUARDS): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const g of guards) {
    const m = text.match(g.pattern);
    if (m) out.push({ subject: g.subject, matched: m[0], reason: g.reason });
  }
  return out;
}

/** Blocks submission rather than warning. A warning nobody reads is not a guard. */
export function assertNoForbiddenClaims(text: string, guards: ClaimGuard[] = CLAIM_GUARDS): void {
  const v = checkClaims(text, guards);
  if (v.length > 0) {
    throw new Error(
      "employer-facing text makes claims the profile does not support:\n" +
      v.map((x) => `  [${x.subject}] "${x.matched}"\n    ${x.reason}`).join("\n"),
    );
  }
}
