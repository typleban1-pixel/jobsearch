/**
 * Deciding what kind of thing was just learned.
 *
 * This is the safety-critical part of the feedback loop, and it is
 * deliberately dull: a written table of intents, a few structural
 * checks, and no inference beyond them. An intent whose answer depends
 * on the posting can never be classified as a fact about the person, no
 * matter how confidently the human answered it, because the confidence
 * is real and the generalisation is still false.
 *
 * The default is ONE_OFF. A correction has to earn reuse.
 */
import { INTENTS } from "../applications/intents.ts";
import type { AnswerConditions, FeedbackClassification, FeedbackEvent, ReuseScope } from "./types.ts";

/**
 * Intents whose answer is a property of the person.
 *
 * The test for membership is whether the answer could change because
 * the posting changed. Work authorization does not. Willingness to
 * relocate does not. Anything that does is not on this list.
 *
 * Nor is anything whose column holds a structured value that free text
 * would corrupt. Residence and relocation destination are already
 * verified facts held as separate city and state columns, and "Chicago,
 * IL" typed into a form is not a safe way to rewrite them.
 */
/*
 * Every column named here must exist on the profile table. Six of the
 * original nine did not -- work_authorized_us, gender, race,
 * veteran_status, disability_status and hispanic_ethnicity are not
 * profile columns -- so promoting any of those intents would have thrown
 * on the update rather than storing anything. Nothing had ever reached
 * this path, so it had never thrown. classifier-selftest now checks the
 * map against the live table.
 *
 * The five self-identification intents are gone from this map for a
 * second and better reason than the missing columns. A demographic
 * self-declaration is not profile truth about employability; it is an
 * answer given to a particular form, and the resolver reads those from
 * the question bank. Routing them here would have written them somewhere
 * nothing reads.
 */
export const PERSONAL_FACT_INTENTS: Record<string, string> = {
  work_authorization: "work_authorization",
  visa_sponsorship: "requires_sponsorship",
  willing_to_relocate: "willing_to_relocate",
  relocation_assistance: "relocation_assistance_required",
};

/**
 * Intents whose answer is about a particular posting.
 *
 * Commute is the clearest case: "yes" is a statement about one office,
 * and the same person answering about an office in another city would
 * say no. Salary, availability, travel and desired location behave the
 * same way. These may never be promoted to profile facts.
 */
/**
 * Questions whose answer is about THIS employer, not about the person.
 *
 * "Have you previously been employed by Home Chef?" answered No is true of
 * Home Chef and says nothing about Lorain County Community College, which
 * did employ him. Banked by intent, that No would answer every employer's
 * version of the question. These are reused only for the same employer.
 */
export const EMPLOYER_INTENTS = new Set([
  "previously_employed_here", "relatives_at_company",
  // "Samsara Careers Site" is how he heard about Samsara. Banked as
  // reusable, it was typed into Shepherd's form as how he heard about
  // Shepherd. The channel is a fact about one employer's posting.
  "referral_source",
]);

export const CONTEXTUAL_INTENTS = new Set([
  "can_commute", "commute_confirmation", "onsite_schedule", "hybrid_schedule",
  "desired_work_location", "salary_expectation", "start_date", "availability",
  "willing_to_travel", "travel_percentage", "notice_period", "shift_availability",
]);

/**
 * Wordings that describe the form rather than the person.
 *
 * Kept narrow on purpose: this is reached only when the human's own
 * words say the problem was the control, not the answer.
 */
const ADAPTER_SIGNALS = /\b(this field|the field|control|widget|dropdown|selector|autocomplete|duplicate|helper|not a real|wrong field|combobox|iframe)\b/i;

export interface Classification {
  classification: FeedbackClassification;
  scope: ReuseScope;
  /** Written so a person can disagree with it later. */
  because: string;
  /** The profile column this would update, when it is a fact. */
  profileField: string | null;
  /** Conditions that must match before the answer may be reused. */
  conditions: AnswerConditions;
}

const hasLocation = (c: AnswerConditions) =>
  Boolean(c.locationCity || c.locationMetro || c.locationState);

/**
 * Classifies one intervention.
 *
 * Order matters. Adapter corrections are recognised first, because they
 * are not answers at all. Contextual intents come next, before the
 * personal-fact table, so that no contextual answer can slip through on
 * a name collision. Everything unrecognised falls through to ONE_OFF.
 */
export function classifyFeedback(ev: FeedbackEvent): Classification {
  const intent = ev.intentConfirmed ?? ev.intentBefore;

  // 0. Reuse is requested, never assumed.
  //
  // Answering a question says what the answer is on this occasion. Only
  // the person knows whether it holds next time, so an explicit refusal
  // ends the matter before any rule below can conclude otherwise. This
  // is what keeps a single answer from quietly becoming a standing fact.
  if (ev.reuseRequested === false) {
    return {
      classification: "ONE_OFF",
      scope: "NONE",
      because: "reuse was not requested, so the answer is kept for the record and never reused",
      profileField: null, conditions: {},
    };
  }

  // 1. About the form. Never an answer about the person.
  if (ADAPTER_SIGNALS.test(ev.humanAnswer) && !ev.intentConfirmed) {
    return {
      classification: "ADAPTER_CORRECTION",
      scope: ev.provider ? "PROVIDER" : "NONE",
      because: "the correction describes the control rather than answering the question, so it teaches the adapter and never becomes a personal answer",
      profileField: null, conditions: {},
    };
  }

  // 2. Depends on the posting. Reusable only where the posting matches.
  if (intent && CONTEXTUAL_INTENTS.has(intent)) {
    return {
      classification: "CONTEXTUAL_ANSWER",
      scope: hasLocation(ev.conditions) ? "LOCATION" : ev.jobId ? "JOB" : "NONE",
      because: hasLocation(ev.conditions)
        ? `the answer is about ${[ev.conditions.locationCity, ev.conditions.locationState].filter(Boolean).join(", ") || ev.conditions.locationMetro}, and holds only for postings in that place`
        : "the answer depends on the posting, and no location was recorded, so it cannot be reused at all",
      profileField: null,
      conditions: ev.conditions,
    };
  }

  // 2b. About this employer. Reusable for this employer and no other.
  if (intent && EMPLOYER_INTENTS.has(intent)) {
    return {
      classification: "CONTEXTUAL_ANSWER",
      scope: ev.employer ? "EMPLOYER" : "NONE",
      because: ev.employer
        ? `the answer is about ${ev.employer} and holds only for ${ev.employer}`
        : "the answer is about one employer and no employer was recorded, so it cannot be reused",
      profileField: null, conditions: {},
    };
  }
  // 3. A fact about the person. The semantics have to be unambiguous,
  //    which here means the intent is on the written list.
  if (intent && PERSONAL_FACT_INTENTS[intent]) {
    return {
      classification: "PROFILE_FACT",
      scope: "GLOBAL_FACT",
      because: `${intent} is a property of the person and does not change with the posting`,
      profileField: PERSONAL_FACT_INTENTS[intent]!,
      conditions: {},
    };
  }

  // 4. The human named an intent the resolver had not matched. That is
  //    evidence about wording, not about the person.
  if (ev.intentConfirmed && ev.intentConfirmed !== ev.intentBefore) {
    return {
      classification: "SEMANTIC_MAPPING",
      scope: ev.provider ? "PROVIDER" : "INTENT",
      because: `the human confirmed this wording asks ${ev.intentConfirmed}, which is evidence about the question rather than about the answer`,
      profileField: null, conditions: {},
    };
  }

  // 4b. A question the catalog recognises, whose answer is neither a
  //     property of the person nor dependent on the posting.
  //
  //     Age, consent acknowledgements, "have you worked here before":
  //     stable replies the resolver looks for in the question bank and
  //     until now had no way of ever finding there. Refused outright for
  //     an intent this system never fills, because a reply that must not
  //     be stored must not be stored for reuse either.
  if (intent && ev.reuseRequested === true) {
    const known = INTENTS.find((i) => i.key === intent);
    if (known?.neverFill) {
      return {
        classification: "ONE_OFF",
        scope: "NONE",
        because: `${known.description} is never stored by this system, so it is not kept for reuse either`,
        profileField: null, conditions: {},
      };
    }
    if (known) {
      return {
        classification: "BANK_ANSWER",
        scope: "INTENT",
        because: `${known.description} is a stable question, so the approved reply is stored in the question bank`
          + " where the resolver looks for it, and it stays a reply rather than becoming a fact",
        profileField: null, conditions: {},
      };
    }
  }

  // 5. A question the catalog does not recognise, which the person has
  //    answered and asked to reuse.
  //
  //    There is no intent to key this on and there must not be one:
  //    inventing a generic intent so the answer becomes storable is how
  //    "5+ years of SEO experience" turns into "SEO: yes". It is keyed
  //    on the exact wording instead, which is the same unit
  //    semantic_mappings already treats as evidence, and it answers that
  //    wording and nothing that merely resembles it.
  if (!intent && ev.reuseRequested === true) {
    return {
      classification: "CONTEXTUAL_ANSWER",
      scope: "QUESTION",
      because: "the catalog does not recognise this question, so the answer is keyed on its exact wording"
        + " and is reused only where that exact wording is asked again",
      profileField: null, conditions: ev.conditions,
    };
  }

  return {
    classification: "ONE_OFF",
    scope: "NONE",
    because: "nothing here generalises: the answer is kept for the record and is never reused",
    profileField: null, conditions: {},
  };
}

/**
 * Normalizes a question for comparison.
 *
 * Punctuation, case and required-field markers vary between forms and
 * mean nothing. Words do not: nothing here strips or stems words, so
 * "commute to our Chicago office" and "commute to our New York office"
 * stay different questions.
 */
export function normalizeQuestion(text: string): string {
  return text.toLowerCase()
    .replace(/\*/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
