/**
 * Deciding what goes in a field, and how sure we are.
 *
 * The order is fixed and stops at the first hit. Nothing further down
 * can rescue a field the step above declined: the alternative to an
 * answer is always BLOCKED, never a weaker answer.
 *
 * Submission confidence is categorically stricter than fit confidence.
 * A Fit of 27 says nothing about whether he has a security clearance,
 * and no score, coverage ratio or match confidence appears anywhere in
 * this file.
 */
import { matchIntent, INTENTS, type Intent } from "./intents.ts";
import { resolveYearsQuestion, type EmploymentRecord } from "../scoring/experienceDuration.ts";
import { normalizeQuestion } from "../feedback/classify.ts";
import { recallAnswer, recallIntent, type RecallStore } from "../feedback/recall.ts";
import type { AnswerConditions } from "../feedback/types.ts";
import { relocationDestination, relocationDate, requiresRelocationAssistance } from "../render/location.ts";

export const ANSWER_RESOLVER_VERSION = 2;

import { matchesPriorEmployment, PRIOR_EMPLOYMENT_ANSWER } from "./priorEmployment.ts";
import { matchesRelativesConflict, RELATIVES_ANSWER } from "./relatives.ts";
import { matchesAnticipatedWorkCountry, ANTICIPATED_WORK_COUNTRY } from "./workCountry.ts";
import { classifyLowStakesSurvey, pickSurveyOption, GENERIC_SURVEY_FREETEXT } from "./lowStakesSurvey.ts";

export type Confidence = "VERIFIED" | "DERIVED" | "HUMAN_CONFIRMED" | "LOW_STAKES_SURVEY" | "AI_DRAFTED_GROUNDED" | "BLOCKED";
export type BlockKind = "UNKNOWN" | "AMBIGUOUS";

/**
 * How a banked answer came to be, mirroring provenance_kind in 0001.
 *
 * A closed union rather than a widened string, so a provenance added
 * upstream cannot arrive here and be resolved as something it is not:
 * an unrecognised value falls through to the refusal below.
 */
export type BankProvenance =
  | "PROFILE" | "EMPLOYMENT_RECORD" | "PROJECT" | "SKILL_RECORD"
  | "VERIFIED_ANSWER" | "USER_RESPONSE" | "CALCULATED"
  | "AI_DRAFT_FROM_VERIFIED_EVIDENCE";

/** One approved, reusable answer as the resolver needs it. */
export interface BankedAnswer {
  answer: string;
  evidenceIds: string[];
  provenance: BankProvenance | null;
}

/**
 * What a stored answer's own provenance entitles it to claim.
 *
 * The bank is storage, and storage is not evidence. What decides the
 * confidence of a reused answer is where the answer came from in the
 * first place, which is why this reads provenance and never the intent
 * key: a rule written against gender and veteran_status would be right
 * about those four rows and silent about the next one.
 *
 * The distinction that matters is authority. VERIFIED and DERIVED both
 * assert that something outside the user says so, which is a claim that
 * has to be able to point at what. HUMAN_CONFIRMED asserts only that
 * the user said so, and for a self-declaration - his gender, his
 * veteran status, whether he has a disability - that is the whole of
 * the available truth. There is no evidence row behind "I am not a
 * protected veteran" and there should not be one.
 *
 * A row whose provenance promises evidence and carries none is not
 * quietly downgraded. Calling it HUMAN_CONFIRMED would assert the user
 * confirmed something he may never have been asked, so it blocks and
 * says why.
 */
export function confidenceForBankedAnswer(
  provenance: BankProvenance | null, evidenceCount: number,
): { confidence: Exclude<Confidence, "BLOCKED"> } | { block: string } {
  switch (provenance) {
    // The user is the source. Keeping what he said for reuse does not
    // promote it into evidence, so it needs no evidence ids and never
    // becomes VERIFIED however many times it is reused.
    case "USER_RESPONSE":
      return { confidence: "HUMAN_CONFIRMED" };

    case "PROFILE": case "EMPLOYMENT_RECORD": case "PROJECT":
    case "SKILL_RECORD": case "VERIFIED_ANSWER":
      return evidenceCount > 0 ? { confidence: "VERIFIED" } : { block:
        "it is stored as verified against evidence but cites none, so what verified it cannot be shown" };

    case "CALCULATED":
      return evidenceCount > 0 ? { confidence: "DERIVED" } : { block:
        "it is stored as calculated but cites no source, so what it was calculated from cannot be shown" };

    // Category C is job-specific by nature, and a draft is a proposal
    // until a person approves it. That is true of a stored draft too.
    case "AI_DRAFT_FROM_VERIFIED_EVIDENCE":
      return { block:
        "it was drafted from evidence rather than given, and a draft is a proposal until you approve it" };

    default:
      return { block:
        "it is stored without a provenance, so on whose authority it would be given is not recorded" };
  }
}

/** One field as the employer's form presents it. */
export interface FormField {
  key: string;
  label: string;
  type: "text" | "textarea" | "select" | "boolean" | "date" | "file" | "number";
  required: boolean;
  options?: string[];
}

export interface ConsideredEvidence { rowId: string | null; what: string; whyRejected: string }

export interface ResolvedField {
  field: FormField;
  intentKey: string | null;
  matchedBy: string;
  answer: string | null;
  confidence: Confidence;
  blockKind: BlockKind | null;
  blockedReason: string | null;
  evidenceIds: string[];
  considered: ConsideredEvidence[];
  /** True for fields this system does not fill under any circumstance. */
  refused: boolean;
}

/** One frozen employment record, as the resolver needs it. */
export interface EmploymentRow {
  rowId: string;
  employer: string;
  title: string | null;
  isCurrent: boolean;
  start: string | null;
  /** end_month; null when current. Needed to measure durations. */
  end?: string | null;
  /** VERIFIED etc.; only VERIFIED spans count toward experience duration. */
  status?: string | null;
  /** actual_title, used for capability-in-title duration matching. */
  actualTitle?: string | null;
}

/** One frozen education record. Highest/most-recent first in the context. */
export interface EducationRow {
  rowId: string;
  institution: string;
  credential: string | null;
  fieldOfStudy: string | null;
  end: string | null;
  completed: boolean;
}

export interface ResolveContext {
  profileRowId: string;
  profile: Record<string, any>;
  /** Frozen employment records, newest first. */
  employment?: EmploymentRow[];
  /** Current month index, for measuring experience durations against "now". */
  nowMonthIndex?: number;
  /** Frozen education records, highest/most-recent first. */
  education?: EducationRow[];
  /** Approved, reusable answers from the question bank, by intent key. */
  bank: Map<string, BankedAnswer>;
  /** Set when a Category C draft has been produced and checked. */
  drafts?: Map<string, { text: string; evidenceIds: string[] }>;

  /**
   * What earlier human corrections established, if anything.
   *
   * Absent means the resolver behaves exactly as it did before any
   * feedback existed. Present, it can recognise a wording a human has
   * already identified, and supply an answer a human already gave for
   * conditions that hold here. It never relaxes a threshold: an answer
   * from this route is HUMAN_CONFIRMED because a human confirmed it.
   */
  learned?: RecallStore;
  /** This posting's employer, ATS and location, for scoping recall. */
  application?: {
    provider: string | null; employer: string | null; jobId: string | null;
    conditions: AnswerConditions;
  };
}

function blocked(
  field: FormField, intentKey: string | null, matchedBy: string,
  kind: BlockKind, reason: string, considered: ConsideredEvidence[] = [],
): ResolvedField {
  return { field, intentKey, matchedBy, answer: null, confidence: "BLOCKED",
    blockKind: kind, blockedReason: reason, evidenceIds: [], considered, refused: false };
}

/**
 * A derived value has to survive the field it is going into.
 *
 * "Yes" is a correct answer and still wrong if the control offers
 * "Authorized" and "Not authorized". Rather than guess which option
 * means yes, an unmatched option list blocks.
 */
/**
 * US states and Canadian provinces, by their postal abbreviation.
 *
 * The profile stores "OH"; forms overwhelmingly offer "Ohio". That is a
 * naming difference, not an uncertainty, and blocking on it sends a
 * verified fact to the queue for no reason. The mapping is closed,
 * official and one-directional, so it stays a lookup rather than any
 * kind of fuzzy match.
 */
const REGION_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", PR: "Puerto Rico", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", NS: "Nova Scotia", ON: "Ontario",
  PE: "Prince Edward Island", QC: "Quebec", SK: "Saskatchewan",
};

/** Every spelling of one verified value that a form might offer. */
export function equivalents(value: string): string[] {
  const v = value.trim();
  const out = [v];
  const upper = v.toUpperCase();
  if (REGION_NAMES[upper]) out.push(REGION_NAMES[upper]!);
  for (const [abbr, name] of Object.entries(REGION_NAMES)) {
    if (name.toLowerCase() === v.toLowerCase()) out.push(abbr);
  }
  if (upper === "US" || upper === "USA") out.push("United States", "United States of America");
  if (v.toLowerCase() === "united states") out.push("US", "USA", "United States of America");

  // One statement, two ways a form words it.
  //
  // "Are you Hispanic/Latino?" offers Yes, No and Decline To Self
  // Identify. The same fact stored as "Not Hispanic or Latino" fits none
  // of them, so the answer was refused on a question it plainly answers.
  // Other forms put "Not Hispanic or Latino" in the option list itself,
  // which is why both spellings have to be acceptable rather than one
  // replacing the other.
  //
  // Deliberately a written table and not a similarity test: these two
  // pairs are the whole of it, and a self-identification answer is the
  // last place to start inferring what someone probably meant.
  // One direction only. An ethnicity statement may be offered as Yes or
  // No; a bare "No" must NOT acquire an ethnicity meaning it never had.
  const lower = v.toLowerCase();
  if (lower === "not hispanic or latino") out.push("No");
  if (lower === "hispanic or latino") out.push("Yes");
  return [...new Set(out)];
}

/**
 * The spellings of one verified institution a school picker might offer.
 *
 * The profile records "Western Governors University, Leavitt School of
 * Health": the university and the school within it. Greenhouse's school
 * list knows the university and nothing below it, so the exact string
 * matched nothing and a verified fact stopped the submission. The
 * institution itself is a true answer to "School", so it is offered as a
 * second spelling -- after the full record, never instead of it.
 *
 * Deliberately narrow: the head must itself name an institution and the
 * part after the separator must name a school, college or division
 * within it. "Cleveland, OH" and "Lorain County Community College" have
 * exactly one spelling.
 */
export function institutionSpellings(value: string): string[] {
  const v = value.trim();
  const out = [v];
  const m = /^(.+?\b(?:university|college|institute|school|academy|polytechnic)\b.*?)\s*(?:,|-|\u2013|\u2014|:)\s+(.+)$/i.exec(v);
  if (m && /\b(school|college|institute|division|department|faculty|campus|cent(?:er|re))\b/i.test(m[2]!)) {
    out.push(m[1]!.trim());
  }
  return [...new Set(out)];
}

/**
 * The spellings of one verified field of study a discipline picker might
 * offer, in the order they may be chosen.
 *
 * Greenhouse's education section asks for a Discipline from its own closed
 * list. The list is not the world's: "Health Science" is not on Beyond
 * Finance's, though "Other" is. So: the record itself; its singular or
 * plural; then "Other", which is the true answer when the field studied
 * is not among the ones offered. Never a different discipline -- "Health
 * Services" is not what was studied, and a near miss is a false claim.
 * The fill records which spelling was entered.
 */
export function disciplineSpellings(value: string): string[] {
  const v = value.trim();
  const out = [v];
  if (/s$/i.test(v)) out.push(v.replace(/s$/i, ""));
  else out.push(`${v}s`);
  out.push("Other");
  return [...new Set(out)];
}

/**
 * The part of an option a person actually chooses.
 *
 * EEO forms glue the federal definition onto the label with no
 * separator: "White (Not Hispanic or Latino)A person having origins in
 * any of the original peoples of Europe, the Middle East, or North
 * Africa." Exact matching against that whole blob can never succeed, so
 * a stored answer of "White" looked like an answer the employer did not
 * offer.
 *
 * Only a definition is stripped, and only when it is recognisable as
 * one. Anything else is left exactly as the employer wrote it, because
 * trimming an option changes which answer is being given.
 */
export function optionLabel(option: string): string {
  const defn = /\)\s*(?=(?:A person|All persons|Individuals|A veteran|Persons)\b)/.exec(option);
  if (defn) return option.slice(0, defn.index + 1).trim();
  return option.trim();
}

function fitOption(field: FormField, value: string): { ok: true; value: string } | { ok: false; why: string } {
  if (field.type !== "select" && field.type !== "boolean") return { ok: true, value };
  const options = field.options ?? [];
  if (!options.length) return { ok: true, value };
  for (const candidate of equivalents(value)) {
    const want = candidate.trim().toLowerCase();
    // Compared against the choosable label, but the option is returned
    // verbatim: what gets selected is the employer's own string.
    const exact = options.find((o) =>
      o.trim().toLowerCase() === want || optionLabel(o).toLowerCase() === want);
    if (exact) return { ok: true, value: exact };
  }
  return { ok: false, why: `the derived answer "${value}" is not one of the offered options (${options.slice(0, 8).join(", ")}${options.length > 8 ? ", ..." : ""})` };
}

/**
 * Pure functions of one frozen profile row.
 *
 * Each returns a value and the sentence explaining it. If the reasoning
 * does not fit in a sentence it is not a derivation, and it belongs in
 * the queue instead.
 */
function derive(intent: Intent, p: Record<string, any>, field: FormField):
  { value: string; because: string } | { block: string; kind: BlockKind } {
  switch (intent.key) {
    case "work_authorization_us":
      if (p.work_authorization === "US citizen")
        return { value: "Yes", because: "work_authorization is \"US citizen\"" };
      return { block: `work_authorization is "${p.work_authorization ?? "unset"}", which does not by itself settle US work authorization`, kind: "AMBIGUOUS" };
    case "requires_sponsorship":
      if (p.requires_sponsorship === false) return { value: "No", because: "requires_sponsorship is false" };
      if (p.requires_sponsorship === true) return { value: "Yes", because: "requires_sponsorship is true" };
      return { block: "requires_sponsorship is not set", kind: "UNKNOWN" };
    case "willing_to_relocate":
      if (p.willing_to_relocate === true) return { value: "Yes", because: "willing_to_relocate is true" };
      if (p.willing_to_relocate === false) return { value: "No", because: "willing_to_relocate is false" };
      return { block: "willing_to_relocate is not set", kind: "UNKNOWN" };
    case "relocation_assistance": {
      // "Not required" answers the question asked. It is not a claim
      // that assistance would be refused if offered.
      const r = requiresRelocationAssistance(p.relocation_assistance_required);
      return r.known ? { value: r.answer, because: r.because } : { block: r.why, kind: "UNKNOWN" };
    }
    case "relocation_destination": {
      const r = relocationDestination({
        city: p.city, state: p.state,
        destinationCity: p.relocation_destination_city, destinationState: p.relocation_destination_state,
      });
      return r.known ? { value: r.answer, because: r.because } : { block: r.why, kind: "UNKNOWN" };
    }
    case "relocation_date": {
      // Never inferred. Not from the destination, not from the move
      // being definite, not from anything.
      const r = relocationDate({ city: p.city, state: p.state, relocationDate: p.relocation_date });
      return r.known ? { value: r.answer, because: r.because } : { block: r.why, kind: "UNKNOWN" };
    }
    case "desired_work_location": {
      // Where he wants to work is the destination he is moving to, not
      // where he currently lives.
      const r = relocationDestination({
        city: p.city, state: p.state,
        destinationCity: p.relocation_destination_city, destinationState: p.relocation_destination_state,
      });
      return r.known
        ? { value: r.answer, because: "the confirmed relocation destination is the market he is moving to" }
        : { block: "no target work location has been confirmed", kind: "UNKNOWN" };
    }
    case "notice_period": {
      const weeks = p.notice_period_weeks;
      if (typeof weeks !== "number") return { block: "notice_period_weeks is not set", kind: "UNKNOWN" };
      // A notice period is a duration. A start date is a calendar day,
      // and turning one into the other needs an offer date nobody has.
      if (field.type === "date")
        return { block: `the profile records a ${weeks}-week notice period, which is a duration; this field wants a specific date, and the offer date it would be counted from is not known`, kind: "AMBIGUOUS" };
      return { value: `${weeks} weeks from offer`, because: `notice_period_weeks is ${weeks}` };
    }
    case "resides_in_us":
      if (p.country === "US") return { value: "Yes", because: "the profile records country US" };
      if (p.country) return { value: "No", because: `the profile records country ${p.country}` };
      return { block: "the profile records no country", kind: "UNKNOWN" };
    case "salary_expectation": {
      // Salary expectation is a strategic, employer-facing disclosure, not an
      // ordinary verified fact like a name or work-authorization status.
      // Stating a number to an employer is a negotiating move, so it is NOT
      // auto-answered on the strength of the stored target alone: it is
      // released only when the person has explicitly authorized employer-facing
      // salary disclosure. Absent that authorization it BLOCKS to review, where
      // the person decides what to say. Default is not to disclose.
      if (p.disclose_salary_to_employers !== true) {
        return { block: "a salary expectation is a strategic employer-facing disclosure; autonomous answering of it is not authorized, so a person supplies it in review", kind: "UNKNOWN" };
      }
      // A stored preference, not an inference.
      //
      // The blocked reason said "none exists yet" while
      // salary_target_ideal held 115000. The rule to read it was simply
      // never written, so a deliberate preference read as an absent one.
      //
      // What is still refused: deriving a number from the employer's
      // posted range, or from a title, or from what the market pays.
      // That would anchor on their number and put words in his mouth.
      // Only the figure he set is used.
      const ideal = p.salary_target_ideal;
      const min = p.salary_target_min;
      if (typeof ideal !== "number" && typeof min !== "number") {
        return { block: "no salary target is stored; it is never inferred from the posting or the market", kind: "UNKNOWN" };
      }
      const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
      if (typeof ideal === "number" && typeof min === "number" && min !== ideal) {
        return { value: `${usd(min)} to ${usd(ideal)}`,
                 because: "the salary range recorded on the profile" };
      }
      const one = (typeof ideal === "number" ? ideal : min) as number;
      return { value: usd(one), because: "the salary target recorded on the profile" };
    }
    case "full_name": {
      // Greenhouse asks for first and last separately, so this never came
      // up until a Lever form asked for one combined field and a verified
      // fact came back BLOCKED as "nothing has been confirmed".
      //
      // DERIVED rather than VERIFIED, because the joined string is not
      // itself an approved row: it is a deterministic transformation of
      // two of them. The middle name is deliberately left out. Forms that
      // want it ask for it, and adding it unasked changes the name the
      // employer is given.
      if (!p.legal_first_name || !p.legal_last_name) {
        return { block: "the profile has no legal first and last name", kind: "UNKNOWN" };
      }
      return {
        value: `${p.legal_first_name} ${p.legal_last_name}`,
        because: "the profile's approved legal first and last name, joined",
      };
    }
    case "current_location_text": {
      if (!p.city || !p.state) return { block: "the profile has no city and state", kind: "UNKNOWN" };
      return { value: `${p.city}, ${p.state}${p.country ? `, ${p.country}` : ""}`,
               because: "the profile's recorded city, state and country" };
    }
    default:
      return { block: `no deterministic derivation is defined for ${intent.key}`, kind: "UNKNOWN" };
  }
}

/**
 * Sensitive intents whose stored preference lives on the profile.
 *
 * An allowlist, and it stays short. Membership means "there is a column
 * that IS the answer", never "the profile probably implies something".
 */
const SENSITIVE_FROM_PROFILE = new Set(["salary_expectation"]);

/** Profile columns that answer an intent directly. */
const DIRECT: Record<string, string> = {
  legal_first_name: "legal_first_name", legal_last_name: "legal_last_name",
  preferred_name: "preferred_name", email: "email_job_search", phone: "phone",
  address_line: "address_line", city: "city", state: "state",
  postal_code: "postal_code", country: "country",
  linkedin_url: "linkedin_url", portfolio_url: "portfolio_url",
};

/**
 * Options that are calling codes: "Poland +48", "United States +1".
 *
 * The same signal the browser layer uses to know a phone input depends
 * on such a control. Kept here too because a control's OPTIONS say what
 * it is when its label does not: Greenhouse labels its dial-code
 * selector simply "Country", which would otherwise match the residence
 * intent and answer a calling country with where he lives.
 */
export function optionsLookLikeDialCodes(options: string[] | undefined): boolean {
  if (!options || options.length < 2) return false;
  const withCode = options.filter((o) => /\+\d{1,4}\b/.test(o)).length;
  return withCode >= Math.max(2, options.length * 0.5);
}

/** ISO 3166-1 alpha-2 to the name a form is likely to print. */
const COUNTRY_NAMES: Record<string, string> = {
  US: "United States", CA: "Canada", GB: "United Kingdom", IE: "Ireland",
  AU: "Australia", NZ: "New Zealand", DE: "Germany", FR: "France",
  ES: "Spain", IT: "Italy", NL: "Netherlands", PL: "Poland",
  PT: "Portugal", SE: "Sweden", NO: "Norway", DK: "Denmark",
  FI: "Finland", CH: "Switzerland", AT: "Austria", BE: "Belgium",
  IN: "India", SG: "Singapore", JP: "Japan", BR: "Brazil", MX: "Mexico",
};

/**
 * "How many years of X?" / "N+ years of X?" answered from the conservative
 * experience-duration resolver, which counts only VERIFIED employment whose
 * ROLE TITLE establishes the capability, merges overlapping spans, and never
 * rounds up. Returns a DERIVED answer only when the evidence DEFINITELY
 * supports it (a threshold reached, or an open number); otherwise null, so an
 * unresolved duration falls through to the ordinary block rather than being
 * guessed. Only wired for a Yes/No threshold or a free-text number; a select
 * of year-ranges is left to a person.
 */
function resolveExperienceYears(
  field: FormField, ctx: ResolveContext, matchedBy: string,
): ResolvedField | null {
  const records: EmploymentRecord[] = (ctx.employment ?? []).map((e) => {
    const title = `${e.actualTitle ?? ""} ${e.title ?? ""}`.trim().toLowerCase();
    return { employer: e.employer, title: e.actualTitle ?? e.title ?? "",
      startMonth: e.start ?? "", endMonth: e.end ?? null, isCurrent: e.isCurrent,
      status: e.status ?? "", titleText: title, evidenceText: title };
  });
  if (!records.length || typeof ctx.nowMonthIndex !== "number") return null;
  const ans = resolveYearsQuestion(field.label, records, ctx.nowMonthIndex);
  if (ans.kind === "UNRESOLVED") return null;

  const matchedRowIds = (ctx.employment ?? [])
    .filter((e) => ans.result.intervals.some((iv) => iv.employer === e.employer))
    .map((e) => e.rowId);
  const calc = `${ans.result.years}y of ${JSON.stringify(ans.result.capability)} from `
    + ans.result.intervals.map((iv) => `${iv.title}@${iv.employer}`).join(" + ")
    + " (overlaps merged, floored, VERIFIED only)";

  // A threshold question wants Yes/No; an open number wants the figure.
  const desired = ans.kind === "THRESHOLD_YES" ? "Yes" : String(ans.result.years);
  const fit = fitOption(field, desired);
  if (!fit.ok) return null;                 // e.g. a select of ranges -> leave for a person
  return { field, intentKey: "job_specific_experience", matchedBy, answer: fit.value,
    confidence: "DERIVED", blockKind: null, blockedReason: null,
    evidenceIds: matchedRowIds,
    considered: [{ rowId: null, what: calc, whyRejected: "" }], refused: false };
}

export function resolveField(field: FormField, ctx: ResolveContext): ResolvedField {
  const result = resolveFieldFromTruth(field, ctx);
  if (result.confidence !== "BLOCKED" || result.refused || !ctx.learned) return result;
  return answerFromHumanFeedback(field, ctx, result);
}

/**
 * A question the truth path could not answer, and a human already has.
 *
 * Only reached after everything else declined, and only for a field that
 * was going to be left blank anyway, so this can add answers and never
 * change one. The stored answer still has to fit the control and still
 * has to have been given for conditions that hold here; where it was
 * not, the field stays blocked with the original reason, which is the
 * behaviour that keeps a Chicago commute answer away from a New York
 * posting.
 */
function answerFromHumanFeedback(field: FormField, ctx: ResolveContext, blockedResult: ResolvedField): ResolvedField {
  const app = ctx.application;
  const normalized = normalizeQuestion(field.label);
  const intentKey = blockedResult.intentKey
    ?? recallIntent(normalized, app?.provider ?? null, ctx.learned!)?.intentKey
    ?? null;

  // A question the catalog does not recognise, which the person has
  // answered before and asked to reuse. It is looked up by its exact
  // wording, because that is the only thing established about it: no
  // intent was confirmed, so there is nothing to generalise from.
  if (!intentKey) {
    const byQuestion = recallAnswer({
      intentKey: null, questionNormalized: normalized,
      provider: app?.provider ?? null, employer: app?.employer ?? null,
      jobId: app?.jobId ?? null, conditions: app?.conditions ?? {},
    }, ctx.learned!);
    if ("blocked" in byQuestion) return blockedResult;
    const fitted = fitOption(field, byQuestion.answer);
    if (!fitted.ok) {
      return { ...blockedResult,
        blockedReason: `${blockedResult.blockedReason} You answered this exact question before, but ${fitted.why}.` };
    }
    return { field, intentKey: null, matchedBy: `human confirmed: ${byQuestion.because}`, answer: fitted.value,
      confidence: "HUMAN_CONFIRMED", blockKind: null, blockedReason: null,
      evidenceIds: byQuestion.fromEventIds, considered: blockedResult.considered, refused: false };
  }

  // Sensitive questions are answered from a deliberately stored
  // preference or not at all. Feedback does not open a second door.
  const intent = INTENTS.find((i) => i.key === intentKey);
  if (!intent || intent.neverFill || intent.category === "D_SENSITIVE") return blockedResult;

  const recalled = recallAnswer({
    intentKey,
    questionNormalized: normalized,
    provider: app?.provider ?? null,
    employer: app?.employer ?? null,
    jobId: app?.jobId ?? null,
    conditions: app?.conditions ?? {},
  }, ctx.learned!);

  if ("blocked" in recalled) {
    return { ...blockedResult,
      blockedReason: `${blockedResult.blockedReason} ${recalled.blocked}.`,
      considered: [...blockedResult.considered,
        { rowId: null, what: "previously confirmed answers", whyRejected: recalled.blocked }] };
  }

  const fit = fitOption(field, recalled.answer);
  if (!fit.ok) {
    return { ...blockedResult,
      blockedReason: `${blockedResult.blockedReason} A previously confirmed answer exists, but ${fit.why}.` };
  }

  return { field, intentKey, matchedBy: `human confirmed: ${recalled.because}`, answer: fit.value,
    confidence: "HUMAN_CONFIRMED", blockKind: null, blockedReason: null,
    evidenceIds: recalled.fromEventIds, considered: blockedResult.considered, refused: false };
}

/**
 * A generic answer to a low-stakes recruiting/attribution survey question.
 *
 * Only ever called after classifyLowStakesSurvey has cleared the wording:
 * it touches nothing about qualifications, eligibility, legal status,
 * compensation, identity, background, work authorization, conflicts,
 * demographics or employment history. The answer is not evidence about the
 * applicant (no evidence ids) and does not modify the truth profile; the
 * distinct LOW_STAKES_SURVEY confidence records exactly that.
 */
function resolveLowStakesSurvey(field: FormField, matchedBy: string, why: string): ResolvedField {
  const opts = (field.options ?? []) as any[];
  let value: string;
  let pickReason: string;
  if (opts.length) {
    const pick = pickSurveyOption(opts);
    if (!pick) {
      return blocked(field, "low_stakes_survey", matchedBy, "AMBIGUOUS",
        "this is a low-stakes survey question, but none of its options could be read as a generic sourcing answer.");
    }
    value = pick.value;
    pickReason = pick.reason;
  } else {
    value = GENERIC_SURVEY_FREETEXT;
    pickReason = `neutral free-text answer "${GENERIC_SURVEY_FREETEXT}"`;
  }
  return {
    field, intentKey: "low_stakes_survey", matchedBy: `low-stakes survey: ${why}`,
    answer: value, confidence: "LOW_STAKES_SURVEY", blockKind: null, blockedReason: null,
    evidenceIds: [],
    considered: [{ rowId: null, what: `low-stakes survey fallback: ${pickReason}`,
      whyRejected: "a generic answer was chosen for a non-substantive mandatory survey field; it is not evidence about the applicant and did not modify the truth profile" }],
    refused: false,
  };
}

function resolveFieldFromTruth(field: FormField, ctx: ResolveContext): ResolvedField {
  // Decided before the label is consulted. A dial-code control is a
  // phone-country control whatever it calls itself, and reading it as a
  // residence field is exactly the conflation this exists to prevent.
  if (optionsLookLikeDialCodes(field.options)) {
    return resolvePhoneCountry(field, ctx, "options are calling codes");
  }

  const m = matchIntent(field.label, field.key);

  if (m.ambiguous.length > 1) {
    return blocked(field, null, m.matchedBy, "AMBIGUOUS",
      `this wording matches more than one question: ${m.ambiguous.map((i) => i.description).join("; ")}. Answering it means choosing which was meant.`,
      m.ambiguous.map((i) => ({ rowId: null, what: i.description, whyRejected: "one of several readings of the same wording" })));
  }

  let intent = m.intent;
  let matchedBy = m.matchedBy;
  if (!intent && ctx.learned) {
    // A wording a human has already identified. This establishes what is
    // being ASKED; what the answer is still comes from the truth paths
    // below, exactly as it would for any recognised question.
    const confirmed = recallIntent(normalizeQuestion(field.label), ctx.application?.provider ?? null, ctx.learned);
    const known = confirmed ? INTENTS.find((i) => i.key === confirmed.intentKey) : undefined;
    if (confirmed && known) { intent = known; matchedBy = `human confirmed: ${confirmed.because}`; }
  }
  if (!intent) {
    // Wordings the catalog does not recognise but that a scoped, standing
    // rule can still answer: a relatives conflict question, an on-site
    // ability question at the relocation target, or a generic recruiting
    // survey question. Each is self-scoped and returns null/blocks when it
    // does not apply, so an unrelated unmatched field still blocks.
    const rel = resolveRelatives(field, m.matchedBy);
    if (rel) return rel;
    if (isHybridAbilityQuestion(field.label)) return resolveOnsiteHybridAbility(field, ctx, m.matchedBy);
    if (isPronounsQuestion(field.label)) return resolvePronouns(field, m.matchedBy);
    { const consent = resolveConsent(field, m.matchedBy); if (consent) return consent; }
    const survey = classifyLowStakesSurvey(field.label, field.key);
    if (survey.low) return resolveLowStakesSurvey(field, m.matchedBy, survey.reason);
    return blocked(field, null, m.matchedBy, "UNKNOWN",
      "nothing in the question catalog matches this wording, so what is being asked is not established.");
  }

  // Refusals first and unconditionally. There is no answer that makes
  // this system type a government identifier into a form.
  if (intent.neverFill) {
    return { field, intentKey: intent.key, matchedBy: matchedBy, answer: null,
      confidence: "BLOCKED", blockKind: "UNKNOWN",
      blockedReason: `${intent.description} is outside what this system handles. It is never stored and never filled; enter it yourself if the application needs it.`,
      evidenceIds: [], considered: [], refused: true };
  }

  // A years-of-experience question ("5+ years of X", "how many years of X")
  // is answered from measured VERIFIED employment, conservatively, or it
  // blocks. Placed before the answer paths so a definite duration wins; an
  // unresolved one returns null and falls through to the ordinary block.
  if (intent.key === "job_specific_experience") {
    const yrs = resolveExperienceYears(field, ctx, matchedBy);
    if (yrs) return yrs;
  }

  // 1. An approved, reusable question-bank answer.
  const banked = ctx.bank.get(intent.key);
  if (banked) {
    // Authority before fit. An answer this system may not give at all
    // should not be reported as an option-matching problem.
    const grounding = confidenceForBankedAnswer(banked.provenance, banked.evidenceIds.length);
    if ("block" in grounding) {
      return blocked(field, intent.key, matchedBy, "UNKNOWN",
        `an approved answer is stored for this question, but ${grounding.block}`,
        [{ rowId: null, what: `approved answer: ${banked.answer}`, whyRejected: grounding.block }]);
    }
    const fit = fitOption(field, banked.answer);
    if (fit.ok) {
      return { field, intentKey: intent.key, matchedBy: matchedBy, answer: fit.value,
        confidence: grounding.confidence, blockKind: null, blockedReason: null,
        evidenceIds: banked.evidenceIds, considered: [], refused: false };
    }
    return blocked(field, intent.key, matchedBy, "AMBIGUOUS", `an approved answer exists but ${fit.why}`,
      [{ rowId: null, what: `approved answer: ${banked.answer}`, whyRejected: fit.why }]);
  }

  // 2a. A profile column that answers the question directly.
  const column = DIRECT[intent.key];
  if (column) {
    const value = ctx.profile[column];
    if (value === null || value === undefined || value === "")
      return blocked(field, intent.key, matchedBy, "UNKNOWN", `the profile has no ${column}`);
    const fit = fitOption(field, String(value));
    if (!fit.ok) return blocked(field, intent.key, matchedBy, "AMBIGUOUS", fit.why);
    return { field, intentKey: intent.key, matchedBy: matchedBy, answer: fit.value,
      confidence: "VERIFIED", blockKind: null, blockedReason: null,
      evidenceIds: [ctx.profileRowId], considered: [], refused: false };
  }

  if (intent.key === "phone_country") {
    return resolvePhoneCountry(field, ctx, matchedBy);
  }

  // A combined "Full Name" / "Name" control. A_VERIFIED_FACT but not a
  // single DIRECT column: it is the deterministic join of the approved
  // legal first and last name, so it is derived here rather than read off
  // one row. Greenhouse asks for first and last separately and never hit
  // this; Ashby and Lever ask for one field and it blocked as "nothing
  // has been confirmed" because no dispatch reached the derive() case.
  if (intent.key === "full_name") {
    const d = derive(intent, ctx.profile, field);
    if ("block" in d) return blocked(field, intent.key, matchedBy, d.kind, d.block);
    const fit = fitOption(field, d.value);
    if (!fit.ok) return blocked(field, intent.key, matchedBy, "AMBIGUOUS", fit.why);
    return { field, intentKey: intent.key, matchedBy, answer: fit.value,
      confidence: "DERIVED", blockKind: null, blockedReason: null,
      evidenceIds: [ctx.profileRowId], considered: [], refused: false };
  }

  if (intent.key === "education_school" || intent.key === "education_degree" || intent.key === "education_discipline") {
    return resolveEducation(field, ctx, intent.key, matchedBy);
  }

  if (intent.key === "previously_employed_here") {
    return resolvePriorEmployment(field, ctx, matchedBy);
  }

  // A relatives / close-personal-relations conflict-of-interest question,
  // answered from the standing declaration (scoped in relatives.ts).
  { const r = resolveRelatives(field, matchedBy); if (r) return r; }

  // Ability to work hybrid / on-site at the relocation target. Derived from
  // the confirmed relocation truth: a Chicago-office question is Yes because
  // the destination is Chicago. A question naming a different, non-target
  // city is not answered here.
  if (isHybridAbilityQuestion(field.label)) {
    const hy = resolveOnsiteHybridAbility(field, ctx, matchedBy);
    if (hy) return hy;
  }

  // Preferred pronouns (he/him) and ordinary Terms/Privacy consent.
  if (isPronounsQuestion(field.label)) return resolvePronouns(field, matchedBy);
  { const consent = resolveConsent(field, matchedBy); if (consent) return consent; }

  // The country the work will happen in, declared once and reused.
  // Checked against the label and the key together, and only where the
  // wording is actually about work location.
  {
    const rule = matchesAnticipatedWorkCountry(`${field.label ?? ""} ${(field as any).key ?? ""}`);
    if (rule.covered) {
      // The option list is the employer's, and it may spell the country
      // any way it likes. fitOption is given the declared name; where the
      // control offers a list, the fill maps it to the exact option and
      // refuses if that mapping is not unique.
      const fit = fitOption(field, ANTICIPATED_WORK_COUNTRY);
      if (!fit.ok) {
        return { field, intentKey: "anticipated_work_country", matchedBy, answer: ANTICIPATED_WORK_COUNTRY,
          confidence: "VERIFIED", blockKind: null, blockedReason: null,
          evidenceIds: [ctx.profileRowId], considered: [], refused: false };
      }
      return { field, intentKey: "anticipated_work_country", matchedBy, answer: fit.value,
        confidence: "VERIFIED", blockKind: null, blockedReason: null,
        evidenceIds: [ctx.profileRowId], considered: [], refused: false };
    }
  }

  // 2b(i). The current role, from the employment records.
  //
  // Answered only from a record the profile marks current. Falling back
  // to the most recent one would answer "who is your current employer"
  // with a job that ended, which is a different claim.
  if (intent.key === "current_employer" || intent.key === "current_job_title") {
    const current = (ctx.employment ?? []).filter((e) => e.isCurrent);
    if (current.length === 0) {
      return blocked(field, intent.key, matchedBy, "UNKNOWN",
        "no employment record is marked current, so there is no current employer to state.");
    }
    if (current.length > 1) {
      return blocked(field, intent.key, matchedBy, "AMBIGUOUS",
        `${current.length} employment records are marked current, so which one this asks for is a choice`,
        current.map((e) => ({ rowId: e.rowId, what: `${e.employer} — ${e.title ?? ""}`, whyRejected: "one of several current roles" })));
    }
    const e = current[0]!;
    const value = intent.key === "current_employer" ? e.employer : e.title;
    if (!value) return blocked(field, intent.key, matchedBy, "UNKNOWN", "the current employment record has no title recorded");
    const fit = fitOption(field, value);
    if (!fit.ok) return blocked(field, intent.key, matchedBy, "AMBIGUOUS", fit.why);
    return { field, intentKey: intent.key, matchedBy: matchedBy, answer: fit.value,
      confidence: "DERIVED", blockKind: null, blockedReason: null,
      evidenceIds: [e.rowId], considered: [], refused: false };
  }

  // 2b. A deterministic derivation from a frozen row.
  if (intent.category === "B_CALCULATED") {
    const d = derive(intent, ctx.profile, field);
    if ("block" in d) return blocked(field, intent.key, matchedBy, d.kind, d.block,
      [{ rowId: ctx.profileRowId, what: "the approved profile row", whyRejected: d.block }]);
    const fit = fitOption(field, d.value);
    if (!fit.ok) return blocked(field, intent.key, matchedBy, "AMBIGUOUS", fit.why,
      [{ rowId: ctx.profileRowId, what: `derived "${d.value}" because ${d.because}`, whyRejected: fit.why }]);
    return { field, intentKey: intent.key, matchedBy: matchedBy, answer: fit.value,
      confidence: "DERIVED", blockKind: null, blockedReason: null,
      evidenceIds: [ctx.profileRowId], considered: [], refused: false };
  }

  // 3. Open-ended prose. A draft is a proposal, never an answer: it is
  // shown in the queue and becomes HUMAN_CONFIRMED only if approved.
  if (intent.category === "C_AI_DRAFTED_GROUNDED") {
    const draft = ctx.drafts?.get(intent.key);
    if (draft) {
      return blocked(field, intent.key, matchedBy, "AMBIGUOUS",
        "a draft written from verified evidence is ready for review. It is not an answer until approved.",
        [{ rowId: null, what: draft.text, whyRejected: "drafted from evidence and grounding-checked, but never auto-approved" }]);
    }
    return blocked(field, intent.key, matchedBy, "UNKNOWN",
      "this asks for something specific to this employer, which the profile cannot supply on its own.");
  }

  // 3b. A low-stakes recruiting/attribution survey question ("how did you
  // hear about us"). The real-data paths above had their chance first;
  // reaching here with a survey wording that clears every substantive
  // guard means a generic answer is safe and blocking would be pure
  // friction. Guarded so a named referral or any substantive question
  // never lands here.
  {
    const survey = classifyLowStakesSurvey(field.label, field.key);
    if (survey.low) return resolveLowStakesSurvey(field, matchedBy, survey.reason);
  }

  // 4. Sensitive. An explicit stored preference or nothing. Reaching
  // here means the bank lookup above found none.
  if (intent.category === "D_SENSITIVE") {
    // "Answered only from a preference you stored deliberately" was the
    // rule, and the only place such a preference could live was the
    // question bank. A salary target sitting in the profile as an
    // explicit figure is exactly that preference, and it read as absent
    // because nothing looked at it.
    //
    // Deliberately an allowlist. A sensitive intent may be answered from
    // the profile only when a specific column IS the stored preference;
    // there is no general "look around the profile for something
    // relevant", which is how inference gets in.
    if (SENSITIVE_FROM_PROFILE.has(intent.key)) {
      const d = derive(intent, ctx.profile, field);
      if (!("block" in d)) {
        const fit = fitOption(field, d.value);
        if (fit.ok) {
          return { field, intentKey: intent.key, matchedBy, answer: fit.value,
            confidence: "DERIVED", blockKind: null, blockedReason: null,
            evidenceIds: [ctx.profileRowId], considered: [], refused: false };
        }
        return blocked(field, intent.key, matchedBy, "AMBIGUOUS", fit.why,
          [{ rowId: ctx.profileRowId, what: `the stored preference "${d.value}"`, whyRejected: fit.why }]);
      }
      return blocked(field, intent.key, matchedBy, d.kind, d.block,
        [{ rowId: ctx.profileRowId, what: "the approved profile row", whyRejected: d.block }]);
    }
    return blocked(field, intent.key, matchedBy, "UNKNOWN",
      `${intent.description} is never inferred. It is answered only from a preference you stored deliberately, and none exists yet.`);
  }

  return blocked(field, intent.key, matchedBy, "UNKNOWN", "no rule produces an answer for this field.");
}

/**
 * Have you worked here before, answered from the employment history.
 *
 * "No" is a claim about an absence, and it is only sound when the thing
 * it is absent from is complete and the question is asking about exactly
 * that thing. The verified employment records are the complete list of
 * where he has worked, so an employer that appears nowhere in them was
 * not an employer of his, and asking a person to confirm that every time
 * is asking them to re-read their own resume.
 *
 * What breaks the reasoning is the question asking about something wider
 * than the employer named. "Either directly or through a staffing
 * agency" asks about placements the employment records do not describe
 * as that employer at all; a subsidiary, an acquisition or a former
 * trading name asks whether two names are the same company, which the
 * profile cannot establish. Every one of those blocks, because the
 * honest answer is that this system does not know.
 *
 * A name that DOES appear is never answered here either. It might mean
 * yes, it might mean two unrelated companies share a name, and picking
 * one is exactly the guess this is built to avoid.
 */
const WIDER_THAN_THE_EMPLOYER =
  /\b(?:staffing|temp(?:orary)?|recruit\w*|placement|employment)\s+(?:agenc|firm|service|partner)|\bthrough an agency\b|\bsubsidiar|\baffiliate|\bparent company\b|\bacquir|\bacquisition\b|\bmerger\b|\bpredecessor\b|\bany of its\b|\bor any\b|\bthird[- ]party\b|\bcontingent\b|\bcontractor\b|\bconsultan/i;

const normalizeEmployer = (s: string): string =>
  s.toLowerCase().replace(/\b(?:inc|llc|ltd|corp|corporation|co|company|group|holdings|plc|gmbh)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();

/**
 * A relatives / close-personal-relations conflict question, from the
 * standing declaration. Returns null when the wording is not that question,
 * so callers fall through. Runs from BOTH the matched-intent path and the
 * unmatched path, because form wordings for this question routinely miss
 * the catalog's relatives_at_company pattern.
 */
function resolveRelatives(field: FormField, matchedBy: string): ResolvedField | null {
  const rel = matchesRelativesConflict(`${field.label ?? ""} ${(field as any).key ?? ""}`);
  if (!rel.covered) return null;
  const fit = fitOption(field, RELATIVES_ANSWER);
  if (!fit.ok) return blocked(field, "relatives_at_company", matchedBy, "AMBIGUOUS", fit.why);
  return { field, intentKey: "relatives_at_company", matchedBy: `${matchedBy}; standing relatives declaration`,
    answer: fit.value, confidence: "HUMAN_CONFIRMED", blockKind: null, blockedReason: null,
    evidenceIds: [], considered: [], refused: false };
}

/** Preferred pronouns, from HUMAN_CONFIRMED he/him. He/Him if offered, else decline. */
function isPronounsQuestion(label: string): boolean { return /\bpronouns?\b/i.test(label ?? ""); }
function resolvePronouns(field: FormField, matchedBy: string): ResolvedField {
  const opts = field.options ?? [];
  const heHim = opts.find((o) => /\bhe\b[^a-z]*\bhim\b|\bhe\s*\/\s*him\b/i.test(o));
  if (heHim) {
    const fit = fitOption(field, heHim);
    if (fit.ok) return { field, intentKey: "preferred_pronouns", matchedBy: `${matchedBy}; he/him (HUMAN_CONFIRMED)`,
      answer: fit.value, confidence: "HUMAN_CONFIRMED", blockKind: null, blockedReason: null, evidenceIds: [], considered: [], refused: false };
  }
  if (!opts.length) {
    return { field, intentKey: "preferred_pronouns", matchedBy: `${matchedBy}; he/him (HUMAN_CONFIRMED)`,
      answer: "He/Him", confidence: "HUMAN_CONFIRMED", blockKind: null, blockedReason: null, evidenceIds: [], considered: [], refused: false };
  }
  const decline = opts.find((o) => /prefer not to (share|say|answer)|decline|do not want to answer/i.test(o));
  if (decline) {
    const fit = fitOption(field, decline);
    if (fit.ok) return { field, intentKey: "preferred_pronouns", matchedBy: `${matchedBy}; no He/Him option, declined`,
      answer: fit.value, confidence: "HUMAN_CONFIRMED", blockKind: null, blockedReason: null, evidenceIds: [], considered: [], refused: false };
  }
  return blocked(field, "preferred_pronouns", matchedBy, "AMBIGUOUS", "the control offers neither a He/Him option nor a prefer-not-to-share option");
}

/** Ordinary application Terms/Privacy consent -> agree; unusual legal terms block. */
const CONSENT_OK = /\bterms of (use|service)\b|\bprivacy (policy|agreement|notice|statement)\b|\bterms (and|&) conditions\b|\bdata (privacy|processing|protection)\b|\bapplication (terms|agreement)\b|\bi (agree|acknowledge|consent) to\b|\bprivacy\b.*\bagreement\b/i;
const CONSENT_UNUSUAL = /\barbitration\b|\bclass[- ]action\b|\bnon-?compete\b|\bnon-?solicit\b|\bassignment of (inventions|ip|intellectual)\b|\bintellectual property\b|\bbackground (check|screen)\b|\bcredit (check|report)\b|\bdrug (test|screen)\b|\bnon-?disclosure\b|\bnda\b|\bconfidentiality agreement\b/i;
function resolveConsent(field: FormField, matchedBy: string): ResolvedField | null {
  const t = field.label ?? "";
  if (!CONSENT_OK.test(t)) return null;
  if (CONSENT_UNUSUAL.test(t)) {
    return blocked(field, "terms_consent", matchedBy, "UNKNOWN",
      "this consent references a materially unusual legal obligation, which is left for you to accept.");
  }
  const opts = field.options ?? [];
  const yes = opts.find((o) => /^(yes|i (agree|acknowledge|consent)|agree|accept)/i.test(o)) ?? "Yes";
  const fit = fitOption(field, yes);
  if (!fit.ok) return blocked(field, "terms_consent", matchedBy, "AMBIGUOUS", fit.why);
  return { field, intentKey: "terms_consent", matchedBy: `${matchedBy}; ordinary application terms (standing authorization)`,
    answer: fit.value, confidence: "HUMAN_CONFIRMED", blockKind: null, blockedReason: null, evidenceIds: [], considered: [], refused: false };
}

/** An on-site / hybrid ABILITY question ("can you come into our X office?"). */
const HYBRID_ABILITY_RE =
  /\bable to (?:come (?:in|into)|be in|work (?:from|at|in|out of|on-?site))\b|\bcome (?:in|into) (?:the |our )?(?:\w+ )?offices?\b|\bwork (?:from |out of )?(?:the |our )?offices?\b|(?:hybrid|on-?site|in-?office)\b[^?]{0,70}\b(?:able|willing|come in|days? (?:a|per) week|per week|report)\b|\bable to work (?:a |in a )?hybrid\b|\bcomfortable\b[^?]{0,40}\b(?:hybrid|on-?site|in-?office|coming (?:in|into))\b/i;
function isHybridAbilityQuestion(label: string): boolean { return HYBRID_ABILITY_RE.test(label ?? ""); }

const STATE_FULL: Record<string, string> = { il: "illinois", oh: "ohio" };
/**
 * Ability to work hybrid/on-site at the relocation target, derived from the
 * confirmed relocation truth. A question naming the destination (Chicago),
 * the destination state, or the current location is Yes; one that names no
 * such place cannot be confirmed and blocks rather than guessing.
 */
function resolveOnsiteHybridAbility(field: FormField, ctx: ResolveContext, matchedBy: string): ResolvedField {
  const p = ctx.profile;
  const raw = [p.relocation_destination_city, p.relocation_destination_state, p.city, p.state]
    .filter(Boolean).map((s: any) => String(s).toLowerCase());
  const terms = [...raw];
  for (const t of raw) if (STATE_FULL[t]) terms.push(STATE_FULL[t]);
  const label = (field.label ?? "").toLowerCase();
  const namesTarget = terms.some((t) => t.length >= 2 && new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(label));
  if (!namesTarget) {
    return blocked(field, "onsite_hybrid_ability", matchedBy, "UNKNOWN",
      "asks about working on-site/hybrid but names no location matching the relocation destination or current residence, so ability there is not established by the relocation truth.");
  }
  const fit = fitOption(field, "Yes");
  if (!fit.ok) return blocked(field, "onsite_hybrid_ability", matchedBy, "AMBIGUOUS", fit.why);
  return { field, intentKey: "onsite_hybrid_ability",
    matchedBy: `${matchedBy}; derived from the confirmed relocation to ${p.relocation_destination_city ?? "the target metro"}`,
    answer: fit.value, confidence: "DERIVED", blockKind: null, blockedReason: null,
    evidenceIds: [ctx.profileRowId], considered: [], refused: false };
}

/** Degree-level spellings a form's option list might use, from a credential. */
function degreeVariants(credential: string): string[] {
  const c = credential.toLowerCase();
  const out = [credential];
  const add = (...xs: string[]) => out.push(...xs);
  if (/\b(ph\.?d|doctor|doctorate)\b/.test(c)) add("Doctorate", "PhD", "Doctoral Degree");
  else if (/\bmaster|m\.?s\.?|m\.?a\.?|m\.?b\.?a|mba\b/.test(c)) add("Master's", "Master's Degree", "Masters", "Master");
  else if (/\bbachelor|b\.?s\.?|b\.?a\.?\b/.test(c)) add("Bachelor's", "Bachelor's Degree", "Bachelors", "Bachelor", "Bachelor's Degree (BA/BS)");
  else if (/\bassociate|a\.?a\.?|a\.?s\.?\b/.test(c)) add("Associate's", "Associate's Degree", "Associates", "Associate");
  return [...new Set(out)];
}

/**
 * School and degree, from the highest / most recent education record.
 *
 * The context is sorted highest-first, so [0] is the credential a single
 * "School"/"Degree"/"highest education" field wants. A school field takes
 * the institution; a degree field takes the credential, and where the
 * control offers a fixed list it maps to the level it names (a "Bachelor
 * of Science" onto a "Bachelor's Degree" option) and refuses if none fit.
 */
function resolveEducation(field: FormField, ctx: ResolveContext, key: string, matchedBy: string): ResolvedField {
  const edu = ctx.education ?? [];
  if (!edu.length) return blocked(field, key, matchedBy, "UNKNOWN", "no education records are on file to answer this from");
  const top = edu[0]!;
  if (key === "education_school") {
    // The full record first; the institution itself only when a closed
    // list offers that and not the school within it.
    let first: { ok: false; why: string } | null = null;
    for (const spelling of institutionSpellings(top.institution)) {
      const fit = fitOption(field, spelling);
      if (fit.ok) return { field, intentKey: key, matchedBy, answer: fit.value, confidence: "VERIFIED",
        blockKind: null, blockedReason: null, evidenceIds: [top.rowId], considered: [], refused: false };
      first ??= fit;
    }
    return blocked(field, key, matchedBy, "AMBIGUOUS", first!.why);
  }
  if (key === "education_discipline") {
    if (!top.fieldOfStudy) return blocked(field, key, matchedBy, "UNKNOWN", "the most recent education record has no field of study recorded");
    let first: { ok: false; why: string } | null = null;
    for (const spelling of disciplineSpellings(top.fieldOfStudy)) {
      const fit = fitOption(field, spelling);
      if (fit.ok) return { field, intentKey: key, matchedBy, answer: fit.value, confidence: "VERIFIED",
        blockKind: null, blockedReason: null, evidenceIds: [top.rowId], considered: [], refused: false };
      first ??= fit;
    }
    return blocked(field, key, matchedBy, "AMBIGUOUS", first!.why);
  }
  // degree
  if (!top.credential) return blocked(field, key, matchedBy, "UNKNOWN", "the most recent education record has no credential recorded");
  for (const cand of degreeVariants(top.credential)) {
    const fit = fitOption(field, cand);
    if (fit.ok) return { field, intentKey: key, matchedBy, answer: fit.value, confidence: "VERIFIED",
      blockKind: null, blockedReason: null, evidenceIds: [top.rowId], considered: [], refused: false };
  }
  return blocked(field, key, matchedBy, "AMBIGUOUS",
    `the degree "${top.credential}" did not match any option the control offers`);
}

function resolvePriorEmployment(field: FormField, ctx: ResolveContext, matchedBy: string): ResolvedField {
  const employer = ctx.application?.employer ?? null;

  // ---- the standing declaration ---------------------------------------
  //
  // Declared truth about the person, so it outranks the inference from the
  // employment records below and resolves VERIFIED. It is checked against
  // the label AND the field key, because Workday puts the meaning in
  // candidateIsPreviousWorker while showing a label as bare as "Yes/No".
  const rule = matchesPriorEmployment(`${field.label ?? ""} ${(field as any).key ?? ""}`);
  if (rule.covered) {
    // One exception, and it is not a hedge. If the employer actually
    // appears in his own verified employment history, two verified
    // sources disagree, and writing "No" onto an employment form on the
    // strength of the more general one would be stating something false.
    // That is worth a person's attention rather than an automatic answer.
    const conflict = employer
      ? (ctx.employment ?? []).find((e) => {
          const known = normalizeEmployer(e.employer), wanted = normalizeEmployer(employer);
          return known === wanted || known.includes(wanted) || wanted.includes(known);
        })
      : undefined;
    if (conflict) {
      return blocked(field, "previously_employed_here", matchedBy, "AMBIGUOUS",
        `the standing answer to prior employment is No, but ${conflict.employer} in the employment history `
        + `resembles ${employer}. Two verified sources disagree and this one goes on an employment form, `
        + "so it needs a person rather than a default.",
        [{ rowId: conflict.rowId, what: `employment record: ${conflict.employer}`,
           whyRejected: "it contradicts the standing prior-employment answer" }]);
    }
    const fit = fitOption(field, PRIOR_EMPLOYMENT_ANSWER);
    if (!fit.ok) return blocked(field, "previously_employed_here", matchedBy, "AMBIGUOUS", fit.why);
    return { field, intentKey: "previously_employed_here", matchedBy, answer: fit.value,
      confidence: "VERIFIED", blockKind: null, blockedReason: null,
      evidenceIds: [ctx.profileRowId], considered: [], refused: false };
  }

  if (!employer) {
    return blocked(field, "previously_employed_here", matchedBy, "UNKNOWN",
      "the employer this posting belongs to is not recorded, so there is nothing to check the employment history against.");
  }

  const wider = WIDER_THAN_THE_EMPLOYER.exec(field.label);
  if (wider) {
    return blocked(field, "previously_employed_here", matchedBy, "UNKNOWN",
      `this asks about more than employment by ${employer} itself (${JSON.stringify(wider[0].trim())}), and the profile `
      + "records who employed him, not which agencies or related companies placed him. Answering it means knowing something the truth profile does not establish.");
  }

  const history = ctx.employment ?? [];
  if (!history.length) {
    return blocked(field, "previously_employed_here", matchedBy, "UNKNOWN",
      "no employment records are available, so an absence from them establishes nothing.");
  }

  const wanted = normalizeEmployer(employer);
  const hit = history.find((e) => {
    const known = normalizeEmployer(e.employer);
    return known === wanted || known.includes(wanted) || wanted.includes(known);
  });
  if (hit) {
    return blocked(field, "previously_employed_here", matchedBy, "AMBIGUOUS",
      `${employer} resembles ${hit.employer} in the employment history, and whether they are the same company is a `
      + "judgement the profile does not record.",
      [{ rowId: hit.rowId, what: `employment record: ${hit.employer}`, whyRejected: "a similar name is not an established identity" }]);
  }

  const fit = fitOption(field, "No");
  if (!fit.ok) return blocked(field, "previously_employed_here", matchedBy, "AMBIGUOUS", fit.why);
  return { field, intentKey: "previously_employed_here", matchedBy, answer: fit.value,
    confidence: "DERIVED", blockKind: null, blockedReason: null,
    evidenceIds: history.map((e) => e.rowId),
    considered: [], refused: false };
}

/**
 * The phone's calling country, and only from a confirmed one.
 *
 * profile.country is where he lives and says nothing about the number.
 * profile.phone has no international prefix, so nothing can be read out
 * of it either. If phone_country has not been confirmed, this blocks,
 * which is the honest answer rather than a residence-shaped guess.
 */
function resolvePhoneCountry(field: FormField, ctx: ResolveContext, matchedBy: string): ResolvedField {
  const iso = ctx.profile["phone_country"];
  if (!iso) {
    return blocked(field, "phone_country", matchedBy, "UNKNOWN",
      "the calling country of the phone number has not been confirmed. It is never taken from the residence country, and an unprefixed number does not carry one.",
      [{ rowId: ctx.profileRowId, what: `residence country: ${ctx.profile["country"] ?? "unset"}`,
         whyRejected: "where someone lives does not establish the calling country of their phone" }]);
  }

  const name = COUNTRY_NAMES[String(iso).toUpperCase()];
  const options = field.options ?? [];
  if (options.length > 0) {
    // Options read "United States +1", so an exact comparison never
    // matches. The country has to be named in the option, as a word.
    const wanted = options.filter((o) => {
      const t = o.toLowerCase();
      return (name && new RegExp(`\\b${name.toLowerCase()}\\b`).test(t))
        || new RegExp(`\\b${String(iso).toLowerCase()}\\b`).test(t);
    });
    if (wanted.length === 1) {
      return { field, intentKey: "phone_country", matchedBy, answer: wanted[0]!,
        confidence: "DERIVED", blockKind: null, blockedReason: null,
        evidenceIds: [ctx.profileRowId], considered: [], refused: false };
    }
    return blocked(field, "phone_country", matchedBy, "AMBIGUOUS",
      wanted.length === 0
        ? `the confirmed calling country (${iso}) is not among the offered options`
        : `${wanted.length} offered options name ${iso}, so which one this wants is a choice`,
      wanted.map((w) => ({ rowId: null, what: w, whyRejected: "one of several options naming the same country" })));
  }

  return { field, intentKey: "phone_country", matchedBy, answer: name ?? String(iso),
    confidence: "DERIVED", blockKind: null, blockedReason: null,
    evidenceIds: [ctx.profileRowId], considered: [], refused: false };
}

/**
 * The standing preference is to skip cover letters unless a posting
 * forces one. An optional cover-letter field is not a gap to fill.
 */
export function shouldSkip(field: FormField): boolean {
  return !field.required && matchIntent(field.label).intent?.key === "cover_letter";
}

/**
 * Stops one field inheriting another field's answer.
 *
 * The resolver matches on intent, and several form fields legitimately
 * share one. "Address Line 2" and "Phone Extension" both matched the
 * same intents as "Address Line 1" and "Phone Number", so a Northern
 * Trust form came back with the street address on both address lines and
 * the phone number in the extension box. Submitted, that is wrong twice
 * over and looks like carelessness to the employer.
 *
 * These are secondary fields: they exist to hold a part of the value
 * that the primary field does not, so repeating the primary's value is
 * never right. When the profile has nothing for them, the truthful
 * answer is a deliberate blank, and that is different from "unanswered".
 *
 * Not Workday-specific. Every two-line address form has this shape.
 */
// Each pattern matches ONLY the secondary field, so no exclusion is
// needed. An earlier version paired each with an "of" pattern naming the
// primary and skipped a field matching both -- which excluded "Phone
// Extension" for containing the word "phone", the very case it was
// written for.
const SECONDARY_FIELD: Array<{ test: RegExp; why: string }> = [
  { test: /line\s*2|address\s*(?:line\s*)?2|^\s*apt\b|^\s*unit\b|^\s*suite\b/i,
    why: "the profile's single address line is complete" },
  { test: /extension|\bext\.?\s*$/i,
    why: "the profile records no phone extension" },
];

/**
 * Blanks a secondary field that merely echoed its primary.
 *
 * Returns the resolution unchanged when it is not an echo, so a genuine
 * answer for a second line is never discarded.
 */
export function guardInheritedAnswer(
  resolved: ResolvedField,
  primaryValues: string[],
): ResolvedField {
  if (resolved.confidence === "BLOCKED") return resolved;
  const answer = String(resolved.answer ?? "");
  if (!answer) return resolved;
  const label = String(resolved.field.label ?? "");
  const rule = SECONDARY_FIELD.find((r) => r.test.test(label));
  if (!rule) return resolved;
  if (!primaryValues.some((v) => v && v === answer)) return resolved;
  return {
    ...resolved,
    answer: "",
    confidence: "DERIVED",
    blockKind: null,
    blockedReason: null,
    matchedBy: `deliberate blank: ${rule.why}`,
  };
}
