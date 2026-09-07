/**
 * What an application field is ASKING, independent of how it is worded.
 *
 * "Are you legally authorized to work in the US?" and "Do you have the
 * right to work in the United States?" are one question. The intent is
 * the unit that carries an answer; the employer's wording is only
 * evidence about which intent was meant.
 *
 * Matching here is rule-based and deliberately literal. Fuzzy similarity
 * is the wrong tool: the failure mode is a near-match on a legal question
 * answered confidently and wrongly, and a scoring threshold makes that
 * failure quiet. Every pattern below has to actually match, or the field
 * is BLOCKED and the user is asked.
 */

export const INTENT_CATALOG_VERSION = 1;

export type IntentCategory =
  | "A_VERIFIED_FACT" | "B_CALCULATED" | "C_AI_DRAFTED_GROUNDED"
  | "D_SENSITIVE" | "E_UNKNOWN";

export interface Intent {
  key: string;
  description: string;
  category: IntentCategory;
  /** All must match for the intent to be a candidate. */
  patterns: RegExp[];
  /** Any match disqualifies, for questions that read alike but differ. */
  excludes?: RegExp[];
  /**
   * Outside what this system does at all. Not "blocked pending an
   * answer": there is no answer the user can give that makes the system
   * type it. The user supplies these themselves, in their own browser.
   */
  neverFill?: boolean;
}

/**
 * Fields that are refused rather than asked about.
 *
 * Listed first, and matched first, so a field that looks like an
 * ordinary text input but asks for a government identifier is caught
 * before any profile lookup can offer a value for it.
 */
export const NEVER_FILL: Intent[] = [
  { key: "ssn", description: "Social Security or national insurance number", category: "D_SENSITIVE", neverFill: true,
    patterns: [/\b(social security|ssn|sin\b|national insurance|nino\b|tax file number|tfn\b)\b/i] },
  { key: "government_id", description: "Passport, driver's licence or other government identifier", category: "D_SENSITIVE", neverFill: true,
    patterns: [/\b(passport|driver'?s? licen[cs]e number|licen[cs]e number|national id|identity (?:card|document) number)\b/i] },
  { key: "date_of_birth", description: "Date of birth", category: "D_SENSITIVE", neverFill: true,
    patterns: [/\b(date of birth|dob\b|birth ?date|birthday|year of birth)\b/i] },
  { key: "payment_details", description: "Bank or card details", category: "D_SENSITIVE", neverFill: true,
    patterns: [/\b(bank account|routing number|sort code|iban\b|credit card|card number|cvv|payment (?:details|method))\b/i] },
  { key: "password", description: "Account password or credential", category: "D_SENSITIVE", neverFill: true,
    patterns: [/\b(password|passcode|api key|security question|secret answer)\b/i] },
  // A signature is an attestation, and the control is often labelled
  // with something innocuous. Lever's disability form calls its
  // signature field "Name", so a rule that answers "Name" from the
  // profile would have typed his name into a legal attestation. Matched
  // on the control's NAME as well as its label, because the label is
  // exactly the part that lies here.
  { key: "signature_attestation", description: "A signature or attestation only you may make", category: "D_SENSITIVE", neverFill: true,
    patterns: [
      /\b(signature|e-?sign|electronically sign|initials?|attestation|i certify that)\b/i,
      /\bsignature(?:date)?\b/i,
    ] },
];

/**
 * Consent and acknowledgement controls.
 *
 * These are checkboxes wearing a paragraph. One of them read "By
 * providing my mobile telephone number ... I give my express written
 * consent to receive text messages", which matched the phone intent and
 * would have put a phone number into a consent control had the field
 * been a text input. Only the option check stopped it, and a guard that
 * happens to catch something is not the same as recognizing it.
 *
 * Consent is a decision, so it is always the user's to make.
 */
const CONSENT = /\b(?:i (?:agree|consent|acknowledge|authorize|certify|understand)|i would like to receive|by (?:providing|submitting|checking)|express written consent|terms (?:and|&) conditions|privacy (?:policy|notice)|processing of personal data|i have read)\b/i;

export const INTENTS: Intent[] = [
  { key: "consent_acknowledgement", description: "A consent, acknowledgement or agreement control", category: "D_SENSITIVE",
    patterns: [CONSENT] },
  // -- A: read straight off an approved profile row -----------------
  { key: "legal_first_name", description: "Legal first name", category: "A_VERIFIED_FACT",
    // "Preferred First Name" is a first-name field and a preferred-name
    // field at once. It matched both intents and blocked as ambiguous on
    // six of the twenty forms tested.
    patterns: [/\b(first name|given name|forename)\b/i],
    excludes: [/\b(last|family|sur)\s*name\b/i, /\bpreferred\b|\bnickname\b/i] },
  { key: "legal_last_name", description: "Legal last name", category: "A_VERIFIED_FACT",
    patterns: [/\b(last name|family name|surname)\b/i] },
  { key: "full_name", description: "Full legal name", category: "A_VERIFIED_FACT",
    patterns: [/\b(full name|your name|legal name|name)\b/i],
    excludes: [/\b(first|last|given|family|sur|middle|preferred|user|company|employer|school|reference|file)\s*name\b/i, /\bname of\b/i] },
  { key: "preferred_name", description: "Preferred name", category: "A_VERIFIED_FACT",
    patterns: [/\b(preferred name|nickname|what should we call you|preferred first name)\b/i] },
  { key: "email", description: "Email address", category: "A_VERIFIED_FACT",
    patterns: [/\b(e-?mail)\b/i], excludes: [/\bconfirm\b/i, CONSENT] },
  // Workday's "Phone Device Type" (Mobile / Landline / Fax) matched the
  // phone intent and was answered with the number itself. It is its own
  // question, and the profile does not record it, so it is asked once
  // and then banked.
  { key: "phone_device_type", description: "Whether the phone number is a mobile, landline or fax", category: "B_CALCULATED",
    patterns: [/\b(?:phone|telephone|mobile)\s*(?:device\s*)?type\b|\bdevice type\b|\btype of (?:phone|number)\b/i] },
  { key: "phone", description: "Phone number", category: "A_VERIFIED_FACT",
    // A "phone country code" control wants a dial code, not the number,
    // and a "phone device type" control wants Mobile, not the number.
    patterns: [/\b(phone|mobile|cell|telephone)\b|\bbest (?:number|way) to reach you\b|\bnumber (?:to|we can) (?:reach|contact|call) you\b|\bcontact number\b/i],
    excludes: [CONSENT, /\b(country code|calling code|dial(?:ing)? code|phone country|country phone|phone code)\b/i,
               /\b(?:phone|telephone|mobile|device)\s*(?:device\s*)?type\b/i] },
  { key: "address_line", description: "Street address", category: "A_VERIFIED_FACT",
    patterns: [/\b(street address|address line|mailing address|home address|^address$)/i],
    excludes: [/\b(e-?mail|website|url|ip)\b/i, /\bcity\b/i, /\b(state|province)\b/i, /\b(zip|postal)\b/i] },
  { key: "city", description: "City of residence", category: "A_VERIFIED_FACT",
    patterns: [/\b(city|town)\b/i], excludes: [/\b(birth|company|employer|school)\b/i, /\bwhere are you\b|\bcurrently (?:located|based)\b|\bwhat city and state\b|\bcity and state do you\b/i] },
  { key: "state", description: "State or province of residence", category: "A_VERIFIED_FACT",
    patterns: [/\b(state|province|region)\b/i], excludes: [/\b(united states|birth|employment)\b/i, /\bwhere are you\b|\bcurrently (?:located|based)\b|\bwhat city and state\b|\bcity and state do you\b/i] },
  { key: "postal_code", description: "Postal or ZIP code", category: "A_VERIFIED_FACT",
    patterns: [/\b(zip|postal code|postcode)\b/i] },
  { key: "country", description: "Country of residence", category: "A_VERIFIED_FACT",
    // "Are you authorized to work in the country this job is based in"
    // is not asking where he lives.
    // "Country code" is a dial code, not a residence. Without excluding
    // it both intents matched and the field blocked as ambiguous.
    patterns: [/\bcountry\b/i],
    excludes: [/\b(citizenship|birth|origin)\b/i, /\bauthori[sz]ed\b|\beligible to work\b|\bsponsor\w*\b|\bright to work\b/i, /\bwhere are you\b|\bcurrently (?:located|based)\b|\bwhat city and state\b|\bcity and state do you\b/i, /\b(country code|calling code|dial(?:ing)? code|phone country|country phone|phone code)\b/i] },
  { key: "linkedin_url", description: "LinkedIn profile URL", category: "A_VERIFIED_FACT",
    patterns: [/\blinkedin\b/i] },
  { key: "portfolio_url", description: "Portfolio or personal website URL", category: "A_VERIFIED_FACT",
    // One regex: hits() requires EVERY pattern in the list to match.
    patterns: [/\b(portfolio|personal website|personal site|your website)\b|\blinks? to (?:any )?(?:other )?(?:assets|work|samples|projects|materials)\b|\bwork samples?\b|\bsamples? of your work\b/i] },
  { key: "github_url", description: "GitHub profile URL", category: "A_VERIFIED_FACT",
    patterns: [/\bgit ?hub\b/i] },
  { key: "resume_upload", description: "Resume or CV file", category: "A_VERIFIED_FACT",
    patterns: [/\b(resume|cv|curriculum vitae)\b/i], excludes: [/\bcover letter\b/i] },

  // -- B: a pure function of a verified row -------------------------
  { key: "work_authorization_us", description: "Authorized to work in the United States", category: "B_CALCULATED",
    patterns: [/\b(authori[sz]ed|eligible|legal(?:ly)? (?:able|entitled)|right) to work\b|\bwork authori[sz]ation\b|\blegally authori[sz]ed\b/i],
    // Sponsorship reads almost identically and has the opposite answer.
    // "sponsorship" does not end at \b after "sponsor", so the original
    // exclusion never fired and every "do you require sponsorship to
    // work in the US" question matched BOTH intents and blocked.
    //
    // Only a question ASKING about sponsorship is excluded. A bare
    // mention of a visa is not: "are you authorized to work in the
    // country (e.g. you are a citizen, you have a visa)" is an
    // authorization question that happens to name one, and excluding it
    // left the question matching nothing but "country", which then tried
    // to answer "US" into a Yes/No control.
    excludes: [/\bsponsor\w*\b|\bvisa (?:support|sponsorship)\b|\bh-?1b\b/i] },
  { key: "requires_sponsorship", description: "Will now or in the future require visa sponsorship", category: "B_CALCULATED",
    patterns: [/\bsponsor(?:ship)?\b/i] },
  { key: "willing_to_relocate", description: "Willing to relocate", category: "B_CALCULATED",
    patterns: [/\brelocat/i],
    // Each of these is its own question with its own answer. Willingness
    // does not state a destination, a destination does not state a date,
    // and none of them says anything about needing assistance.
    excludes: [/\b(assistance|package|reimburse|expenses|cost)\b/i,
      /\bwhen\b|\bdate\b|\btimeline\b|\bhow soon\b/i,
      /\bwhere\b|\bwhich (?:city|market|location)\b/i] },
  { key: "relocation_destination", description: "Where you are relocating to", category: "B_CALCULATED",
    patterns: [/\brelocat\w*\b[^?]{0,30}\b(where|to which|destination)\b|\bwhere are you relocating\b|\bwhere are you moving\b/i] },
  { key: "relocation_date", description: "When you are relocating", category: "B_CALCULATED",
    patterns: [/\brelocat\w*\b[^?]{0,30}\b(when|date|timeline|how soon)\b|\bwhen (?:are|will) you (?:relocat|mov)\w*\b|\bmove date\b/i] },
  { key: "desired_work_location", description: "Where you want to work", category: "B_CALCULATED",
    patterns: [/\b(desired|preferred|target) (?:work )?(?:location|city|market)\b|\bwhere (?:would|do) you (?:like|want) to work\b/i] },
  { key: "relocation_assistance", description: "Requires relocation assistance", category: "B_CALCULATED",
    patterns: [/\brelocation (?:assistance|package|support|reimbursement)\b/i] },
  { key: "notice_period", description: "Notice period or earliest start date", category: "B_CALCULATED",
    patterns: [/\b(notice period|earliest start|start date|when (?:can|could) you start|availability to start|available to start)\b/i] },

  { key: "phone_country", description: "The calling country of your phone number", category: "B_CALCULATED",
    // A control asking for a dial code is recognised by its OPTIONS
    // rather than its label, in answer.ts. These patterns catch the
    // forms that say what they mean; Greenhouse's says only "Country".
    // Workday words it "Country Phone Code".
    patterns: [/\b(country code|calling code|dial(?:ing)? code|phone country|country phone|phone code|country for your phone)\b/i] },
  { key: "current_employer", description: "Current or most recent employer", category: "B_CALCULATED",
    patterns: [/\b(current|present|most recent|previous) (?:company|employer)\b|\b(?:current|recent) or (?:previous|former) employer\b|\bwho is your (?:current|present)\b/i],
    excludes: [/\bever been\b|\bpreviously been employed\b|\brelative/i] },
  { key: "current_job_title", description: "Current or most recent job title", category: "B_CALCULATED",
    patterns: [/\b(?:current|present|most recent|previous) (?:job )?title\b|\bcurrent role\b/i] },
  { key: "current_location_text", description: "Where you are currently located", category: "B_CALCULATED",
    patterns: [/\bwhere are you (?:currently )?(?:located|based)\b|\bwhat city and state do you (?:reside|live)\b|\bcity, ?state(?:, ?country)?\b|\bcurrent (?:location|residence|city)\b|^location$|\bcandidate.?location\b|\byour location\b|\bwhere (?:will|would|do) you (?:be )?work(?:ing)? from\b|\bwhere (?:do|would) you (?:currently )?(?:reside|live)\b/i],
    // A bare "Location" on an application is the candidate's location. A
    // desired/work/office location has its own intent and its own words.
    // A question that names a SINGLE sub-field as its head noun -- "the
    // city of your current residence", "list the city", "state of
    // residence" -- is asking for that one field, so it is left to the
    // specific city/state intent rather than swallowed here and blocked as
    // ambiguous against it (Chartis' required Location field did exactly
    // that: matched both and blocked, though the profile answers it plainly).
    excludes: [/\b(?:desired|preferred|target|work|office|job|role|position)\s+location\b/i,
               /\b(?:city|state|province|town|zip|postal code)\s+of\s+(?:your\s+)?(?:current\s+)?residence\b/i,
               /\blist (?:the |your )?(?:city|state|town)\b/i] },
  { key: "education_school", description: "School / university / institution attended", category: "A_VERIFIED_FACT",
    patterns: [/\b(?:school|university|college|institution|alma mater)\b/i],
    excludes: [/\b(?:high school|name of (?:the )?school of)\b/i, /\bwhy\b/i] },
  { key: "education_discipline", description: "Discipline / field of study / major", category: "A_VERIFIED_FACT",
    patterns: [/\b(?:discipline|field of study|major|area of study|concentration|course of study|subject studied)\b/i],
    excludes: [/\bwhy\b/i, /\bmajor (?:accomplishment|achievement|project|responsibilit)/i] },
  { key: "education_degree", description: "Degree / level of education", category: "A_VERIFIED_FACT",
    patterns: [/\bdegree\b|\blevel of education\b|\bhighest (?:degree|level of education|education)\b|\beducation level\b|\bqualification level\b/i] },
  { key: "resides_in_us", description: "Whether you reside in the United States", category: "B_CALCULATED",
    patterns: [/\b(?:do you reside|are you (?:currently )?(?:based|located)|do you live)\b[^?]{0,30}\b(?:the )?(?:us|u\.s\.|united states)\b/i],
    excludes: [/\bauthori[sz]ed\b|\bsponsor\w*\b|\beligible to work\b/i] },

  // -- recognized so the queue can explain them, never answered -----
  //
  // These are legible questions with no deterministic answer. Naming
  // them turns "nothing in the catalog matches this" into a reason a
  // reader can act on, which is the difference between a gap and a
  // mystery.
  { key: "job_specific_experience", description: "A screening question about experience with a specific tool, domain or duration", category: "E_UNKNOWN",
    patterns: [/\bhow many years\b|\b\d+\s*\+?\s*years?\b|\byears?\s+of\s+experience\b|\bhow many years of experience\b|\b(?:do|have) you (?:have |had )?(?:any )?experience\b|\bwhat .{0,30}tools are you using\b/i] },
  { key: "onsite_commitment", description: "Commitment to a hybrid or in-office schedule", category: "E_UNKNOWN",
    patterns: [/\b(?:hybrid|in[- ]person|in[- ]office|onsite|on[- ]site)\b[^?]{0,80}\b(?:commit|able to|can you|willing)\b|\bcome into (?:the|our) office\b|\bgo into their local office\b/i] },
  { key: "pronouns", description: "Pronouns", category: "D_SENSITIVE",
    patterns: [/\bpronouns?\b/i] },
  { key: "age_over_18", description: "Whether you are 18 or older", category: "D_SENSITIVE",
    patterns: [/\b18 years of age\b|\bat least 18\b|\bover (?:the age of )?18\b/i] },
  { key: "relatives_at_company", description: "Relatives employed by this company", category: "D_SENSITIVE",
    patterns: [/\brelatives?\b[^?]{0,40}\b(?:working|employed)\b|\bfamily members? (?:who )?(?:work|employed)\b/i] },
  { key: "social_profile", description: "A social media profile link", category: "A_VERIFIED_FACT",
    patterns: [/\b(twitter|x\.com|instagram|facebook|tiktok|other links|personal links)\b/i] },

  // -- C: written from evidence, then checked, then approved --------
  { key: "why_this_company", description: "Why you want to work at this company", category: "C_AI_DRAFTED_GROUNDED",
    patterns: [/\bwhy (?:do you )?(?:want to )?(?:work|join|are you interested)\b|\bwhy (?:this|our) (?:company|role|team|position)\b|\bwhat (?:draws|interests) you\b/i] },
  { key: "cover_letter", description: "Cover letter", category: "C_AI_DRAFTED_GROUNDED",
    patterns: [/\bcover letter\b/i] },
  { key: "additional_information", description: "Anything else you would like us to know", category: "C_AI_DRAFTED_GROUNDED",
    patterns: [/\b(additional information|anything else|other information|is there anything)\b/i] },

  // -- D: an explicit stored preference, or nothing -----------------
  { key: "salary_expectation", description: "Salary expectation", category: "D_SENSITIVE",
    patterns: [/\b(salary|compensation|pay) (?:expectations?|requirements?|range|desired)\b|\bdesired (?:salary|compensation|pay)\b|\bexpected (?:salary|compensation)\b|\bcompensation for this (?:position|role)\b|\bpay range\b/i] },
  { key: "gender", description: "Gender", category: "D_SENSITIVE", patterns: [/\bgender\b/i] },
  { key: "race_ethnicity", description: "Race", category: "D_SENSITIVE",
    // Hispanic/Latino ethnicity is a SEPARATE question on US EEO forms,
    // asked alongside race rather than as one of its values. Folding it
    // in here let a stored race answer reconcile to the ethnicity
    // control, which is a different question with different options.
    patterns: [/\b(race|ethnicity)\b/i],
    excludes: [/\bhispanic\b|\blatino\b|\blatina\b|\blatinx\b/i] },
  { key: "hispanic_ethnicity", description: "Hispanic or Latino ethnicity", category: "D_SENSITIVE",
    patterns: [/\bhispanic\b|\blatino\b|\blatina\b|\blatinx\b/i] },
  { key: "veteran_status", description: "Protected veteran status", category: "D_SENSITIVE",
    patterns: [/\bveteran\b|\bmilitary service\b/i] },
  { key: "disability_status", description: "Disability status", category: "D_SENSITIVE",
    patterns: [/\bdisabilit/i] },
  { key: "criminal_history", description: "Criminal history", category: "D_SENSITIVE",
    patterns: [/\b(convict|criminal|felony|misdemeanor|background check consent)\b/i] },
  { key: "previously_employed_here", description: "Previously employed by this company", category: "D_SENSITIVE",
    // Every pattern in the list must match (see hits), so the alternatives
    // live in one expression. The last two are Workday's own name for the
    // control ("Candidate Is Previous Worker") and its legend.
    patterns: [/\b(?:previously|ever) (?:been )?(?:employed|worked)\b|\bformer employee\b|\b(?:are you|were you) (?:a )?(?:current(?:ly)?|an?) [\w' ]{0,24}employee\b|\bever been an employee\b|\bprevious(?:ly)? worker\b|\bworked for this (?:organi[sz]ation|company|employer)\b/i] },
  { key: "referral_source", description: "How you heard about the role", category: "D_SENSITIVE",
    patterns: [/\bhow did you (?:\w+\s+){0,2}(?:hear|learn|find)\b|\bhow (?:did|do) you (?:\w+\s+){0,2}(?:find|learn|hear)\b|\bwhere (?:have|did) you (?:\w+\s+){0,2}learn(?:ed)? about\b|\bhow you heard about\b|\breferr?(?:al|ed by)\b|\bsource\b/i] },
];

export interface IntentMatch {
  intent: Intent | null;
  /** More than one intent matched. The wording is genuinely ambiguous. */
  ambiguous: Intent[];
  matchedBy: string;
}

function normalize(label: string): string {
  const cleaned = label
    .replace(/\*/g, " ")
    .replace(/[_]+/g, " ")
    .trim();
  // Only a label with no spaces at all is an identifier rather than
  // prose. Splitting camel case unconditionally turned "LinkedIn
  // Profile" into "Linked In Profile" and stopped it matching anything.
  return cleaned.replace(/\s+/g, " ").trim();
}

function hits(intent: Intent, text: string): boolean {
  if (intent.excludes?.some((r) => r.test(text))) return false;
  return intent.patterns.every((r) => r.test(text));
}

/**
 * Which intent a field label expresses.
 *
 * Refusals are checked first and win outright: a field asking for an SSN
 * must never fall through to a lookup that has a value for it.
 *
 * Two matches is a real result, not a tie to break. "Do you require
 * sponsorship to work in the US?" reads as both authorization and
 * sponsorship, and picking either one silently is how the wrong answer
 * to a legal question gets sent.
 */
export function matchIntent(label: string, fieldKey?: string): IntentMatch {
  const text = normalize(label);

  // The control's NAME is checked against the never-fill list before the
  // label is trusted, because a form can label a dangerous control with
  // something harmless. Lever's disability attestation is named
  // eeo[disabilitySignature] and labelled "Name"; matching the label
  // alone would have found the full-name rule and typed a signature.
  if (fieldKey) {
    const keyText = normalize(fieldKey.replace(/[[\]_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
    const refusedByKey = NEVER_FILL.filter((i) => hits(i, keyText));
    if (refusedByKey.length) {
      return { intent: refusedByKey[0]!, ambiguous: [], matchedBy: `control name "${fieldKey}"` };
    }
  }

  if (!text) return { intent: null, ambiguous: [], matchedBy: "empty label" };

  // Some ATS forms label a field with its identifier rather than a
  // question: "VeteranStatus", "workAuthorization". The split form is
  // tried only as a FALLBACK, because splitting first turns "LinkedIn"
  // into "Linked In" and stops a perfectly good label matching.
  const forms = [text];
  const split = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  if (split !== text) forms.push(split);

  for (const form of forms) {
    const refused = NEVER_FILL.filter((i) => hits(i, form));
    if (refused.length) return { intent: refused[0]!, ambiguous: [], matchedBy: `refusal:${refused[0]!.key}` };

    const matched = INTENTS.filter((i) => hits(i, form));
    if (matched.length === 1) return { intent: matched[0]!, ambiguous: [], matchedBy: `pattern:${matched[0]!.key}` };
    if (matched.length > 1) {
      return { intent: null, ambiguous: matched, matchedBy: `ambiguous:${matched.map((m) => m.key).join(",")}` };
    }
  }
  return { intent: null, ambiguous: [], matchedBy: "no intent matched" };
}

/** Ashby's canonical resume field key. Only this exact key is a resume by key. */
export const ASHBY_RESUME_KEY = "_systemfield_resume";

/**
 * Whether a form field is THE resume/CV upload, recognized two ways:
 *   - the visible label matches the resume_upload intent, or
 *   - the field key is Ashby's canonical `_systemfield_resume`.
 *
 * The key check is defense-in-depth: a resume upload still binds to this
 * application's exact tailored artifact even if the employer customized the
 * visible label away from "Resume/CV". It is deliberately the EXACT key only.
 * Other `_systemfield_*` fields are not resumes, and an arbitrary file field is
 * never assumed to be a resume merely because it accepts a file -- those remain
 * unknown and are handed off to the employer's own form.
 */
export function isResumeUploadField(field: { key?: string | null; label: string }): boolean {
  if (field.key === ASHBY_RESUME_KEY) return true;
  return matchIntent(field.label).intent?.key === "resume_upload";
}
