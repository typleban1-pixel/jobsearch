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

/** Verbs that claim origination, as opposed to participation. */
const ORIGINATION_VERB =
  "\\b(?:created|built|founded|established|launched|developed|started|designed|set up|stood up|spun up)\\b";
const LCCC = "\\b(?:LCCC|Lorain)\\b";

export const CLAIM_GUARDS: ClaimGuard[] = [
  {
    subject: "generalist as an identity",
    pattern: /\bgeneralists?\b/i,
    reason: "Generalist is an internal scoring concept, not a professional identity. On a resume it labels breadth "
      + "instead of demonstrating it, and reads to a recruiter as a hedge about depth. State the cross-functional "
      + "identity the verified titles support, and let the entries show the range.",
  },
  {
    subject: "causing the growth of an email audience",
    // The Genius One audience was approximately 70,000 when he arrived
    // and approximately 180,000 later. Both numbers are the SIZE OF THE
    // AUDIENCE WORKED WITH, and the evidence does not establish who or
    // what caused the change. Any verb of causation across those figures
    // asserts an attribution nobody confirmed.
    // The verb has to attach to the AUDIENCE, not to something built for
    // it. "Built and managed segmented funnels for an email audience" is
    // the approved wording and describes building funnels, so anything
    // with an intervening object of its own is excluded.
    pattern: /\b(?:grew|grow|growing|grown|built|building|scaled|scaling|increased|increasing|expanded|expanding|doubled|tripled|drove|driving)\b(?:(?!funnels?|campaigns?|segments?|flows?)[^.]){0,25}\b(?:audience|list|database|subscribers?|contacts?)\b|\b(?:audience|list|database|subscribers?|contacts?)\b[^.]{0,60}\bfrom\s+(?:approximately\s+)?[\d,]+\s*k?\b[^.]{0,20}\bto\s+(?:approximately\s+)?[\d,]+/i,
    reason: "The email audience figures are the size of the list worked with at two points in time, not growth he "
      + "caused. List size moves on acquisition spend, retail and wholesale channels and other people's work. State "
      + "what he did, which is designing marketing emails and building and managing segmented funnels, and state the "
      + "audience size as scale. Never as growth, a percentage or a multiple.",
  },
  {
    subject: "product sales stated as revenue generated",
    // $68,000+ is what the products sold. He designed and developed
    // them; pricing, channel, marketing spend and demand are not his.
    pattern: /\b(?:generated|drove|driving|delivered|produced|responsible for|brought in)\b[^.]{0,40}\$\s?6[89],?\d{3}|\$\s?6[89],?\d{3}[^.]{0,40}\b(?:in revenue|revenue I|revenue he)\b/i,
    reason: "The $68,000+ figure is sales of the products he designed, not revenue he personally generated. State it "
      + "as product sales attached to the design work, never as revenue driven or delivered.",
  },
  {
    subject: "two unrelated Genius One money figures in one claim",
    // $70,000+ is Genius Academy's peak ARR; $68,000+ is physical
    // product sales. Different offerings, different measures. Putting
    // them in one sentence invites them to be read as one total.
    pattern: /\$\s?70,?000[^.]{0,120}\$\s?68,?000|\$\s?68,?000[^.]{0,120}\$\s?70,?000/i,
    reason: "Genius Academy's peak annual recurring revenue and the 3D-printed product sales are separate metrics for "
      + "separate offerings. Stating them together reads as one combined figure and misstates both. Keep them in "
      + "different sentences, and never add them.",
  },
  {
    subject: "a date governing a list of capabilities",
    // The narrow shape only: a year, then a span word, then a list. The
    // general case is handled structurally by temporalScope.ts, which
    // checks whether the anchor year actually holds for each item; this
    // catches the phrasing early, in composed text that has no original
    // to compare against.
    pattern: /\b(?:since|from)\s+(?:19|20)\d{2}\b[^.]{0,40}\b(?:spanning|across|encompassing|covering)\b[^.]*,/i,
    reason: "A year placed in front of a list is read as governing every item in it. The capabilities listed did not "
      + "all begin in that year, so the sentence asserts more than the evidence supports. State the span without a "
      + "date, or date only the item the record actually dates.",
  },
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
    // "that generated", "which generated", "generating" were all outside
    // the original pattern, which required a sentence start or a pronoun.
    // A tailored rewrite produced "an education-focused offering that
    // generated more than $70,000", which is the attribution this guard
    // exists to stop, one relative pronoun away from being caught.
    pattern: /(?:^|[.\n;]\s*|\b(?:I|he|we|that|which|who)\s+)(?:generat\w+|dr(?:ove|iving)|produc\w+|earn\w+|deliver\w+|bring\w*|brought)\s+(?:in\s+)?(?:\$|more than \$|over \$|upwards of \$)?\s*\d[\d,]*\s*(?:k\b|,000)?\s*(?:\+\s*)?(?:in\s+)?(?:ARR|revenue|sales|annual)/i,
    reason: "The $70,000 figure is the offering's total ARR, not revenue personally generated.",
  },
  {
    subject: "people management scope",
    pattern: /\b(?:managed|led|supervised)\s+(?:a\s+)?(?:team|department|staff)\s+of\s+\d+|\b(?:managed|led)\s+\d+\s+(?:employees|reports|people)\b/i,
    reason: "The only supervision evidence is three student employees at LCCC, day to day. Not professional-staff management.",
  },
  {
    subject: "LCCC internship program",
    pattern: /\b(?:created|built|founded|established|launched|developed|started|designed|set up|stood up|spun up)\b[^.]{0,40}\binternship program\b/i,
    reason: "RETRACTED 30 Aug 2026: he did not create the LCCC internship program. His resume says otherwise and the resume is wrong.",
  },
  {
    // The deleted evidence row read "Created the program from the ground
    // up", never using the word "internship". The guard above would have
    // let it through verbatim. The claim survives paraphrase, so the
    // guard has to as well.
    //
    // Scoped to LCCC on purpose. He is not barred from claiming program
    // creation anywhere else, and a guard that blocked the phrase
    // globally would assert an absence the profile does not support.
    subject: "LCCC program creation",
    pattern: new RegExp(
      [
        // verb ... LCCC ... program   ("Founded the LCCC Video Program")
        `${ORIGINATION_VERB}[^.]{0,60}${LCCC}[^.]{0,30}\\bprogram\\b`,
        // verb ... program ... LCCC   ("Created the program at LCCC")
        `${ORIGINATION_VERB}[^.]{0,60}\\bprogram\\b[^.]{0,60}${LCCC}`,
        // LCCC ... verb ... program   ("At LCCC, established the video program")
        `${LCCC}[^.]{0,80}${ORIGINATION_VERB}[^.]{0,40}\\bprogram\\b`,
        // The bare phrasing the deleted evidence row actually used, which
        // names neither LCCC nor "internship" and so matches none of the above.
        `${ORIGINATION_VERB}[^.]{0,20}\\bprogram\\b[^.]{0,30}\\bfrom the ground up\\b`,
      ].join("|"), "i"),
    reason: "RETRACTED 30 Aug 2026: he did not create the LCCC Video Program or its internship program. Teaching and coordinating within the program is supported; originating it is not. This constrains the LCCC claim only and says nothing about program-creation capability elsewhere.",
  },
  {
    subject: "Adobe certification",
    pattern: /\b(?:premiere\s*pro|after\s*effects|photoshop|illustrator|adobe)\b[^.]{0,20}\bcertifi\w*|\bcertifi\w*[^.]{0,20}\b(?:premiere\s*pro|after\s*effects|adobe)\b/i,
    reason: "He holds passed LinkedIn Skill Assessments, which are not Adobe or vendor certifications. Any employer-facing use must state the LinkedIn provenance explicitly.",
  },
  {
    subject: "Asana at Holley",
    pattern: /\b(?:introduc|implement|brought|select|chose|adopt|rolled out|deploy)\w*\s+(?:\w+\s+){0,3}Asana\b|\bAsana\b[^.]{0,30}\b(?:I|he)\s+(?:introduced|selected|chose|brought in)\b/i,
    reason: "Asana was already in use at Holley. The contribution was identifying and implementing unused automation capability in a system already there, not introducing or selecting the platform.",
  },
  {
    subject: "product origination at Genius One",
    pattern: /\b(?:invented|conceived|originated|came up with)\b[^.]{0,40}\b(?:Lit Box|Genius Grow Grinder|Genius Academy)\b/i,
    reason: "The owner originated these product and offering concepts. The evidence is working out how to design, make and operate them, not originating the idea.",
  },
  {
    subject: "LCCC equipment budget",
    // Scoped to the equipment modernization itself. A bare "budget" used to
    // fire too, which was right while no budget figure anywhere in the
    // profile was established; since 2026-09-07 the Anytime Picture client
    // project budgets ($10,000 to $100,000) are an approved metric, and the
    // grounding checks bind that figure to its own evidence.
    pattern: /\b(?:equipment|moderni[sz]ation)\b[^.]{0,40}\$\s?\d|\$\s?[\d,]+[^.]{0,40}\b(?:equipment|moderni[sz]ation)\b|\bLCCC\b[^.]{0,60}\bbudget\b[^.]{0,30}\$\s?\d/i,
    reason: "No dollar figure is established for the LCCC equipment budget and none may be stated.",
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
