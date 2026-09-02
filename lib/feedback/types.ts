/**
 * What is learned when a human answers a question the system could not.
 *
 * A correction is evidence about something, and the whole system turns
 * on WHICH something. "No, I do not require relocation assistance" is a
 * fact about a person and holds everywhere. "Yes, I can commute to that
 * office" is a fact about one office and holds nowhere else. "That field
 * is the country selector, not a residence field" is a fact about a
 * form. Storing all three the same way is how a system ends up telling
 * an employer in New York that the candidate can commute to their
 * office because he once said yes to one in Chicago.
 *
 * So every intervention is classified before it is reused, and the
 * classification decides the scope. Nothing here is a model: the rules
 * are written down, the evidence is stored, and the reasoning that led
 * to a later answer can be read back.
 */

export const FEEDBACK_VERSION = 1;

export type FeedbackClassification =
  /** A fact about the person. May become authoritative profile truth. */
  | "PROFILE_FACT"
  /** Evidence that a wording means an intent the system already has. */
  | "SEMANTIC_MAPPING"
  /** True only under stated conditions. Never becomes a global fact. */
  | "CONTEXTUAL_ANSWER"
  /** A fact about a form or an ATS, not about the person. */
  | "ADAPTER_CORRECTION"
  /** An approved reply to a recognised question, stored in the bank. */
  | "BANK_ANSWER"
  /** Deliberately not reusable. Kept for history only. */
  | "ONE_OFF";

/**
 * How far a piece of learning reaches.
 *
 * Ordered narrowest first. When several apply, the narrowest justified
 * one wins, because a narrow rule that is wrong misfires once and a
 * broad rule that is wrong misfires forever.
 */
export type ReuseScope =
  | "NONE"
  | "JOB"
  | "EMPLOYER"
  | "PROVIDER"
  | "LOCATION"
  | "TIME_SENSITIVE"
  /** This exact wording, wherever it is asked. Never a near match. */
  | "QUESTION"
  | "INTENT"
  | "GLOBAL_FACT";

export const SCOPE_ORDER: ReuseScope[] = [
  "NONE", "JOB", "EMPLOYER", "PROVIDER", "LOCATION", "TIME_SENSITIVE", "QUESTION", "INTENT", "GLOBAL_FACT",
];

export type FeedbackConfidence = "VERIFIED" | "DERIVED" | "HUMAN_CONFIRMED" | "BLOCKED";

/** The conditions a contextual answer depends on. */
export interface AnswerConditions {
  /** The office or work location the answer was given about. */
  locationCity?: string | null;
  locationState?: string | null;
  locationMetro?: string | null;
  /** Remote, hybrid, onsite: a commute answer means nothing without it. */
  remotePolicy?: string | null;
  /** Free-form conditions the human stated, kept verbatim. */
  notes?: string | null;
}

/**
 * One human intervention, with everything needed to audit it later.
 *
 * The "before" fields matter as much as the answer: they are the record
 * of what the system actually knew at the time, and they are why a
 * later reader can tell learning from hindsight.
 */
export interface FeedbackEvent {
  applicationId: string;
  jobId: string | null;
  canonicalOpeningId: string | null;
  employer: string | null;
  provider: string | null;

  questionRaw: string;
  questionNormalized: string;
  providerFieldKey: string | null;

  /** What the resolver thought the question was, before the human spoke. */
  intentBefore: string | null;
  confidenceBefore: FeedbackConfidence;
  /** Why automation stopped: the blocked reason or the stop reason. */
  whyStopped: string;

  /** What the system offered, if it offered anything. */
  proposedAnswer: string | null;
  /** What the human actually supplied. */
  humanAnswer: string;
  /** The intent the human's answer establishes, when they named one. */
  intentConfirmed: string | null;

  /** Where the posting was, which is what a commute answer depends on. */
  conditions: AnswerConditions;
  occurredAt: string;

  /**
   * Whether the person asked for this answer to be reused.
   *
   * Answering a question once says what the answer is on this occasion.
   * It does not say the answer holds next time, and only the person
   * knows which they meant. False means keep it for the record and
   * nothing else, whatever the classifier would otherwise conclude.
   *
   * Undefined preserves the behaviour callers had before the queue could
   * express the difference, so the CLI recorder is unaffected.
   */
  reuseRequested?: boolean;
}

/**
 * An approved answer to be stored for reuse under a stable intent.
 *
 * The question bank is where the resolver looks first, so this is the
 * reuse path for a question the catalog recognises. Provenance is
 * carried explicitly and is always USER_RESPONSE: the person is the
 * source, and storing what they said does not make it evidence.
 */
export interface BankWrite {
  intentKey: string;
  intentDescription: string;
  category: string;
  answer: string;
  sensitive: boolean;
  classification: string;
  /** Set when an existing bank row is being confirmed again. */
  existingId: string | null;
  because: string;
}

/** A wording confirmed to mean an intent. */
export interface SemanticMapping {
  id: string;
  normalizedQuestion: string;
  intentKey: string;
  /** Null means the mapping has been confirmed beyond one ATS. */
  provider: string | null;
  confirmations: number;
  status: "PROPOSED" | "ACTIVE" | "CONTRADICTED";
  fromEventIds: string[];
}

/** An answer that holds only under its conditions. */
export interface ContextualAnswer {
  id: string;
  /** Null for an answer keyed on wording alone. */
  intentKey: string | null;
  /** Set for a QUESTION-scoped answer: the exact wording it answers. */
  normalizedQuestion: string | null;
  answer: string;
  scope: ReuseScope;
  conditions: AnswerConditions;
  employer: string | null;
  provider: string | null;
  jobId: string | null;
  /** After this, the answer is stale and is not reused. */
  expiresAt: string | null;
  confirmations: number;
  fromEventIds: string[];
}

/** Something learned about a form, which is never an answer. */
export interface AdapterRule {
  id: string;
  provider: string;
  kind: "WIDGET_HELPER" | "CONTROL_IDENTITY" | "OPTION_SEMANTICS" | "FIELD_LABEL";
  subject: string;
  note: string;
  confirmations: number;
  fromEventIds: string[];
}

/** Feedback that disagrees with something already believed. */
export interface FeedbackConflict {
  id: string;
  kind: "PROFILE_FACT" | "SEMANTIC_MAPPING" | "CONTEXTUAL_ANSWER" | "BANK_ANSWER";
  subject: string;
  existing: string;
  incoming: string;
  fromEventId: string;
  status: "OPEN" | "RESOLVED";
  /** Always: nothing is decided automatically. */
  resolution: string | null;
}

/** A profile fact promoted from an intervention. */
export interface LearnedProfileFact {
  field: string;
  value: string | boolean | null;
  provenance: "HUMAN_CONFIRMED";
  fromEventId: string;
}
