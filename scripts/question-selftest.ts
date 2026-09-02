/**
 * Question mapping, tested from both directions.
 *
 * Proving a matcher blocks things is easy and worthless on its own: a
 * matcher that blocks everything passes. So half these cases assert that
 * an ordinary field IS answered, with the right confidence, and half
 * assert that a dangerous or unclear one is NOT.
 */
import { resolveField, shouldSkip, type FormField, type ResolveContext } from "../lib/applications/answer.ts";
import { matchIntent } from "../lib/applications/intents.ts";

const PROFILE_ROW = "00000000-0000-0000-0000-0000000000p1";
const ctx: ResolveContext = {
  profileRowId: PROFILE_ROW,
  profile: {
    legal_first_name: "Ty", legal_last_name: "Pleban", preferred_name: "Ty",
    email_job_search: "x@example.com", phone: "+1 555 0100",
    address_line: "1 Main St", city: "Elyria", state: "OH", postal_code: "44035", country: "US",
    linkedin_url: "https://linkedin.com/in/x", portfolio_url: null,
    work_authorization: "US citizen", requires_sponsorship: false,
    willing_to_relocate: true, relocation_assistance_required: null,
    notice_period_weeks: 2,
  },
  bank: new Map(),
  employment: [
    { rowId: "00000000-0000-0000-0000-0000000000e1", employer: "Genius One, Inc.",
      title: "Digital Marketing, Product & Operations Specialist (Contract)", isCurrent: true, start: "2024-01-01" },
    { rowId: "00000000-0000-0000-0000-0000000000e2", employer: "Holley Performance",
      title: "Videographer & Editor", isCurrent: false, start: "2022-01-01" },
  ],
};

const f = (label: string, over: Partial<FormField> = {}): FormField =>
  ({ key: label.toLowerCase().replace(/\W+/g, "_"), label, type: "text", required: true, ...over });

let pass = 0; const fails: string[] = [];
function check(name: string, cond: boolean, detail: string) {
  if (cond) pass++; else fails.push(`  ${name}\n      ${detail}`);
}

/** A field that must be answered, at a specific confidence. */
function answers(name: string, field: FormField, confidence: string, value?: string) {
  const r = resolveField(field, ctx);
  const ok = r.confidence === confidence && (value === undefined || r.answer === value) && r.evidenceIds.length > 0;
  check(name, ok, `got ${r.confidence} "${r.answer}" evidence=${r.evidenceIds.length} (${r.blockedReason ?? "-"})`);
}

/** A field that must NOT be answered. */
function blocks(name: string, field: FormField, kind?: string) {
  const r = resolveField(field, ctx);
  const ok = r.confidence === "BLOCKED" && r.answer === null && !!r.blockedReason && (!kind || r.blockKind === kind);
  check(name, ok, `got ${r.confidence} "${r.answer}" kind=${r.blockKind}`);
}

// -- answered, and the confidence distinction is real -----------------
answers("first name is VERIFIED from the profile row", f("First Name"), "VERIFIED", "Ty");
answers("last name is VERIFIED", f("Last Name *"), "VERIFIED", "Pleban");
answers("email is VERIFIED", f("Email"), "VERIFIED", "x@example.com");
answers("phone is VERIFIED", f("Phone"), "VERIFIED");
answers("city is VERIFIED", f("City"), "VERIFIED", "Elyria");
answers("ZIP is VERIFIED", f("Zip Code"), "VERIFIED", "44035");
answers("LinkedIn is VERIFIED", f("LinkedIn Profile"), "VERIFIED");
answers("work authorization is DERIVED, not VERIFIED", f("Are you legally authorized to work in the United States?", { type: "boolean", options: ["Yes", "No"] }), "DERIVED", "Yes");
answers("sponsorship is DERIVED and answers No", f("Will you now or in the future require sponsorship for employment visa status?", { type: "boolean", options: ["Yes", "No"] }), "DERIVED", "No");
answers("relocation willingness is DERIVED", f("Are you willing to relocate?", { type: "boolean", options: ["Yes", "No"] }), "DERIVED", "Yes");
answers("notice period is DERIVED as a duration", f("What is your notice period?"), "DERIVED", "2 weeks from offer");

// -- the near-miss pairs, where a wrong answer is a legal problem -----
blocks("a start DATE is not derivable from a notice period", f("Earliest start date", { type: "date" }), "AMBIGUOUS");
blocks("relocation assistance is a different question from willingness", f("Do you require relocation assistance?", { type: "boolean", options: ["Yes", "No"] }), "UNKNOWN");
check("sponsorship wording does not match the authorization intent",
  matchIntent("Do you require visa sponsorship to work in the US?").intent?.key === "requires_sponsorship",
  `matched ${matchIntent("Do you require visa sponsorship to work in the US?").intent?.key}`);
check("authorization wording does not match the sponsorship intent",
  matchIntent("Are you legally authorized to work in the US?").intent?.key === "work_authorization_us",
  `matched ${matchIntent("Are you legally authorized to work in the US?").intent?.key}`);

// -- refusals: never filled, whatever the profile holds ---------------
for (const [label, what] of [
  ["Social Security Number", "SSN"], ["Date of Birth", "DOB"],
  ["Passport Number", "passport"], ["Bank Account Number", "bank details"],
  ["Create a password", "password"],
] as const) {
  const r = resolveField(f(label), ctx);
  check(`${what} is refused outright`, r.refused && r.confidence === "BLOCKED" && r.answer === null,
    `refused=${r.refused} ${r.confidence} "${r.answer}"`);
}

// -- sensitive: a stored preference or nothing ------------------------
blocks("gender is never inferred", f("Gender", { type: "select", options: ["Male", "Female", "Decline"] }), "UNKNOWN");
blocks("veteran status is never inferred", f("Protected Veteran Status", { type: "select", options: ["Yes", "No"] }));
blocks("disability status is never inferred", f("Disability Status", { type: "select", options: ["Yes", "No"] }));
blocks("race is never inferred", f("Race / Ethnicity", { type: "select", options: ["A", "B"] }));
blocks("salary expectation is never inferred", f("Desired salary"));
blocks("criminal history is never inferred", f("Have you ever been convicted of a felony?", { type: "boolean", options: ["Yes", "No"] }));

// -- unmapped and ambiguous ------------------------------------------
blocks("an unrecognised question blocks rather than guesses", f("Which of our values resonates most with you?"), "UNKNOWN");
blocks("an open-ended company question blocks without a draft", f("Why do you want to work at Acme?", { type: "textarea" }));
blocks("a Category C field is not answered from the profile", f("Cover Letter", { type: "textarea" }));

// -- option fitting ---------------------------------------------------
blocks("a derived Yes that is not an offered option blocks",
  f("Are you legally authorized to work in the United States?", { type: "select", options: ["Authorized", "Not authorized"] }), "AMBIGUOUS");
answers("the same question with matching options is answered",
  f("Are you legally authorized to work in the United States?", { type: "select", options: ["Yes", "No"] }), "DERIVED", "Yes");

// -- the standing cover-letter preference -----------------------------
check("an optional cover letter is skipped", shouldSkip(f("Cover Letter", { type: "textarea", required: false })), "not skipped");
check("a required cover letter is not skipped", !shouldSkip(f("Cover Letter", { type: "textarea", required: true })), "skipped anyway");

// -- an approved bank answer resolves at its provenance, option-checked
//
// The confidence here used to be VERIFIED for anything in the bank.
// A stored gender is a thing the user said, not a thing evidence shows,
// so it resolves HUMAN_CONFIRMED. See confidenceForBankedAnswer.
const withBank: ResolveContext = { ...ctx, bank: new Map([["gender",
  { answer: "Decline to answer", evidenceIds: [], provenance: "USER_RESPONSE" as const }]]) };
{
  const r = resolveField(f("Gender", { type: "select", options: ["Male", "Female", "Decline to answer"] }), withBank);
  check("a stored preference answers a sensitive question", r.confidence === "HUMAN_CONFIRMED" && r.answer === "Decline to answer", `${r.confidence} "${r.answer}"`);
  const r2 = resolveField(f("Gender", { type: "select", options: ["Male", "Female"] }), withBank);
  check("a stored preference that is not offered blocks", r2.confidence === "BLOCKED", `${r2.confidence} "${r2.answer}"`);
}

// -- wordings taken verbatim from live postings -----------------------
//
// Every one of these came out of a real ATS form during Stage 3
// validation, and every one exposed a matching defect.
answers("an authorization question that merely mentions a visa still resolves",
  f("Are you currently legally authorized to work in the country in which this job is based (e.g. you are a citizen, you have a visa, etc.)?",
    { type: "select", options: ["Yes", "No"] }), "DERIVED", "Yes");
answers("a sponsorship question phrased around the employer resolves",
  f("Will you now or in the future require Samsara to commence (\u201Csponsor\u201D) an immigration case in order to employ you?",
    { type: "select", options: ["Yes", "No"] }), "DERIVED", "No");
answers("a state abbreviation matches a full state name option",
  f("Which U.S. State or Canadian Province do you reside in?",
    { type: "select", options: ["Illinois", "Ohio", "Texas", "Ontario"] }), "VERIFIED", "Ohio");
check("an identifier-style label maps to its intent",
  matchIntent("VeteranStatus").intent?.key === "veteran_status", `${matchIntent("VeteranStatus").intent?.key}`);
check("a consent paragraph is not a phone field",
  matchIntent("By providing my mobile telephone number and submitting this form, I give my express written consent and agreement to receive text messages").intent?.key === "consent_acknowledgement",
  `${matchIntent("By providing my mobile telephone number and submitting this form, I give my express written consent and agreement to receive text messages").intent?.key}`);
blocks("and a consent control is never ticked for you",
  f("By submitting this form I agree to receive text messages", { type: "boolean", options: ["I acknowledge"] }), "UNKNOWN");
check("a referral question with an inserted adverb still matches",
  matchIntent("How did you first learn about Affirm as an employer?").intent?.key === "referral_source",
  `${matchIntent("How did you first learn about Affirm as an employer?").intent?.key}`);

// -- intents added after the first live validation pass ---------------
answers("a preferred-name field is no longer ambiguous with first name",
  f("Preferred First Name"), "VERIFIED", "Ty");
answers("an ordinary first-name field still resolves", f("First Name"), "VERIFIED", "Ty");
answers("the current employer comes from the record marked current",
  f("Most Recent Employer"), "DERIVED", "Genius One, Inc.");
answers("so does the current title",
  f("What is your current or previous job title?"), "DERIVED",
  "Digital Marketing, Product & Operations Specialist (Contract)");
answers("a free-text location field is one answer, not three",
  f("Where are you currently located? (City, State, Country)"), "DERIVED", "Elyria, OH, US");
answers("residency in the US is derived from the recorded country",
  f("Do you reside the United States?", { type: "select", options: ["Yes", "No"] }), "DERIVED", "Yes");

// Recognized, and still never answered.
for (const [label, key] of [
  ["Pronouns", "pronouns"],
  ["Are you 18 years of age or older?", "age_over_18"],
  ["Do you have any relatives working at Pair Team?", "relatives_at_company"],
  ["How many years of experience do you have acting in a Product Management Capacity?", "job_specific_experience"],
  ["This is a hybrid role. Can you commit to being in person Tuesday - Thursday each week?", "onsite_commitment"],
  ["What are your Salary Expectations (not including bonus)?", "salary_expectation"],
  ["Where have you learned about Samsara? Select all that apply.", "referral_source"],
  ["Have you previously been employed at Affirm for any length of time?", "previously_employed_here"],
  ["Processing of Personal Data", "consent_acknowledgement"],
] as const) {
  check(`"${label.slice(0, 44)}" is recognized as ${key}`,
    matchIntent(label).intent?.key === key, `matched ${matchIntent(label).intent?.key}`);
  blocks(`  and ${key} is still never answered`, f(label, { type: "textarea" }));
}

// A current employer must not be invented from a role that ended.
{
  const noCurrent: ResolveContext = { ...ctx, employment: [
    { rowId: "r", employer: "Holley Performance", title: "Videographer", isCurrent: false, start: "2022-01-01" }] };
  const r = resolveField(f("Current Company"), noCurrent);
  check("with no current role, the current employer blocks",
    r.confidence === "BLOCKED", `${r.confidence} "${r.answer}"`);
}

// -- the phone's calling country is not where you live ----------------
//
// A Greenhouse control labelled only "Country" whose options read
// "United States +1" is the phone's dial-code selector, established by
// probing a live form: selecting an option changes the phone widget.
// Answering it from the residence country is a guess that happens to be
// right for this profile and would be silently wrong for anyone who has
// moved or kept a foreign number.
const DIAL = { type: "select" as const, options: ["Poland +48", "United States +1", "Canada +1"] };

{
  // Without a confirmed calling country, it blocks. It must NOT fall
  // back to profile.country, which is "US" and would look correct.
  const r = resolveField(f("Country", DIAL), ctx);
  check("a dial-code control blocks when the calling country is unconfirmed",
    r.confidence === "BLOCKED" && r.intentKey === "phone_country",
    `${r.confidence} ${r.intentKey} "${r.answer}"`);
  check("and it says why, naming residence as considered and rejected",
    /residence/i.test(JSON.stringify(r.considered)) && /never taken from the residence/i.test(r.blockedReason ?? ""),
    `${r.blockedReason} ${JSON.stringify(r.considered)}`);
}
{
  const confirmed: ResolveContext = { ...ctx, profile: { ...ctx.profile, phone_country: "US" } };
  const r = resolveField(f("Country", DIAL), confirmed);
  check("with a confirmed calling country it resolves to the right option",
    r.confidence === "DERIVED" && r.answer === "United States +1", `${r.confidence} "${r.answer}"`);
  check("and cites the profile row", r.evidenceIds.length === 1, JSON.stringify(r.evidenceIds));
}
{
  // A plain residence-country control is unaffected by any of this.
  const confirmed: ResolveContext = { ...ctx, profile: { ...ctx.profile, phone_country: "US" } };
  const r = resolveField(f("Country", { type: "select", options: ["United States", "Canada", "Poland"] }), confirmed);
  check("a residence country control still answers from residence",
    r.intentKey === "country" && r.confidence === "VERIFIED", `${r.intentKey} ${r.confidence} "${r.answer}"`);
}
{
  // The confirmed country is not on offer: a choice, not a default.
  const confirmed: ResolveContext = { ...ctx, profile: { ...ctx.profile, phone_country: "US" } };
  const r = resolveField(f("Country", { type: "select", options: ["Poland +48", "Germany +49"] }), confirmed);
  check("a calling country that is not offered blocks rather than picking one",
    r.confidence === "BLOCKED" && r.blockKind === "AMBIGUOUS", `${r.confidence} ${r.blockKind} "${r.answer}"`);
}
{
  // Labels that say what they mean route to the same resolver.
  const confirmed: ResolveContext = { ...ctx, profile: { ...ctx.profile, phone_country: "US" } };
  check("an explicit country-code label maps to phone_country",
    matchIntent("Phone country code").intent?.key === "phone_country",
    `${matchIntent("Phone country code").intent?.key}`);
  const r = resolveField(f("Phone country code"), confirmed);
  check("and resolves with no options offered", r.confidence === "DERIVED" && r.answer === "United States",
    `${r.confidence} "${r.answer}"`);
}
{
  // The rule that must not exist: residence never implies calling country.
  const residenceOnly: ResolveContext = { ...ctx, profile: { ...ctx.profile, country: "US", phone_country: null } };
  const r = resolveField(f("Country", DIAL), residenceOnly);
  check("residence country never satisfies a calling-country control",
    r.confidence === "BLOCKED", `${r.confidence} "${r.answer}"`);
}

console.log(`${pass + fails.length} cases, ${pass} passed`);
for (const x of fails) console.log(x);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
