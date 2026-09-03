/**
 * Why this application has not submitted, in one precise reason.
 *
 * "Blocked" without a reason forces a person to reconstruct the gate
 * logic in their head; the system already knows which gate said no, so
 * the answer is derived from real state and never guessed at the UI
 * layer. Exactly one blocker is reported -- the one a person would fix
 * first -- ordered the way the submission path itself checks them.
 */

export type BlockerCode =
  | "SUBMITTED"
  | "SUBMISSION_IN_PROGRESS"     // a worker holds the claim right now
  | "ENQUEUED"                   // requested; the listener owns the next step
  | "AMBIGUOUS_SUBMIT_STATE"     // clicked, no confirmation; never auto-retried
  | "SUBMISSION_FAILED"          // last run stopped; the stop reason says why
  | "WAITING_FOR_MY_ANSWER"
  | "FORM_NOT_READ"              // zero discovered fields; nothing to approve yet
  | "WAITING_FOR_MY_REVIEW"
  | "ATS_NOT_AUTOMATED"          // provider capability/pause; handoff to a person
  | "AUTHENTICATION_REQUIRED"
  | "REVALIDATION_FAILED"        // approval no longer matches present facts
  | "DAILY_CAP_REACHED"
  | "READY_TO_SUBMIT"
  | "JOB_CLOSED_OR_CHANGED"
  | "PROCESSING";                // pipeline still working; nothing for a person

export interface BlockerFacts {
  status: string;
  submittedAt: string | null;
  submitQueued: boolean;
  submitRunning: boolean;
  submitOutcome: "CONFIRMED" | "SAFE_STOP" | "AMBIGUOUS" | "DECLINED" | null;
  /** Machine-readable stop from the last SAFE_STOP, when one was recorded. */
  lastStopCode?: string | null;
  lastStopDetail?: string | null;
  humanApproved: boolean;
  blockedAnswers: number;
  requiredUnanswered: number;
  discoveredFields: number;
  /** Refusal codes from revalidateBeforeSubmit; empty when it passes. */
  refusals: string[];
  provider: string;
  providerCapability: string | null;   // PRODUCTION | NONE | null(unknown)
  providerPaused: boolean;
  applyUrl?: string | null;
  handoffReason?: string | null;
  dailyCapReached: boolean;
  jobStatus: string;                   // OPEN | CLOSED | ...
}

export interface Blocker {
  code: BlockerCode;
  /** Plain English: what is true. */
  status: string;
  /** Plain English: why it has not submitted, or that nothing is wrong. */
  reason: string;
  /** What the person should do. null when no action is needed from them. */
  action: { label: string; href: string } | null;
}

export function deriveBlocker(f: BlockerFacts, id: string): Blocker {
  const href = `/applications/${id}`;

  // Ordered as the submission path checks them: terminal states first,
  // then in-flight, then the person's own gates, then policy.
  if (f.submittedAt) {
    return { code: "SUBMITTED", status: "Submitted", reason: "The employer confirmed receipt.", action: null };
  }
  if (f.submitOutcome === "AMBIGUOUS") {
    return { code: "AMBIGUOUS_SUBMIT_STATE", status: "Needs your eyes",
      reason: "Submit was clicked and no confirmation was observed. The employer may hold this; it is never retried automatically.",
      action: { label: "Inspect the run", href: `${href}/events` } };
  }
  if (f.submitRunning) {
    return { code: "SUBMISSION_IN_PROGRESS", status: "Submitting now",
      reason: "A worker holds this application and is filling the employer's form.", action: null };
  }
  if (f.submitQueued) {
    return { code: "ENQUEUED", status: "Queued to submit",
      reason: "The submission listener owns the next step; no action is needed from you.", action: null };
  }

  if (f.jobStatus && f.jobStatus !== "OPEN") {
    return { code: "JOB_CLOSED_OR_CHANGED", status: "Posting closed",
      reason: "The employer's posting is no longer open, so nothing will be submitted.", action: null };
  }

  // The person's own gates, in the order they can act on them.
  if (f.blockedAnswers > 0 || f.requiredUnanswered > 0) {
    const n = Math.max(f.blockedAnswers, f.requiredUnanswered);
    return { code: "WAITING_FOR_MY_ANSWER", status: "Needs your answer",
      reason: `${n} required question${n === 1 ? "" : "s"} unresolved. The system will not guess them.`,
      action: { label: `Answer ${n} question${n === 1 ? "" : "s"}`, href: "/apply/questions" } };
  }
  if (f.discoveredFields === 0) {
    return { code: "FORM_NOT_READ", status: "Form not read yet",
      reason: "The employer's form has not been discovered, so there is nothing to review or approve.",
      action: f.applyUrl ? { label: `Open on ${f.provider}`, href: f.applyUrl } : null };
  }

  // Provider capability before review: reviewing an application the
  // machine cannot submit ends in a handoff, and saying so first is
  // more honest than a review button that leads to a wall.
  const capable = f.providerCapability === "PRODUCTION" && !f.providerPaused;
  if (!capable && /authenticat|sign.?in|session/i.test(String(f.handoffReason ?? ""))) {
    return { code: "AUTHENTICATION_REQUIRED", status: "Sign-in needed",
      reason: f.handoffReason ?? "The employer's site needs you to sign in before this can continue.",
      action: f.applyUrl ? { label: `Continue on ${f.provider}`, href: f.applyUrl } : null };
  }
  if (!capable && f.humanApproved) {
    return { code: "ATS_NOT_AUTOMATED", status: "Hand-finish required",
      reason: `${f.provider} submission is not automated; finish it on the employer's site.`,
      action: f.applyUrl ? { label: `Continue on ${f.provider}`, href: f.applyUrl } : null };
  }

  if (!f.humanApproved && f.status !== "READY_TO_SUBMIT") {
    return { code: "WAITING_FOR_MY_REVIEW", status: "Needs your review",
      reason: "Every field is resolved. It submits after you approve it (or policy authorizes it).",
      action: { label: "Review application", href: `${href}/review` } };
  }

  if (f.refusals.length) {
    return { code: "REVALIDATION_FAILED", status: "Approval out of date",
      reason: `The approval no longer matches present facts: ${f.refusals.join(", ")}. Re-review to proceed.`,
      action: { label: "Review again", href: `${href}/review` } };
  }
  if (f.dailyCapReached) {
    return { code: "DAILY_CAP_REACHED", status: "Waiting for tomorrow",
      reason: "The daily application cap is reached. It becomes eligible again at midnight; no action is needed.",
      action: null };
  }
  if (f.submitOutcome === "SAFE_STOP") {
    return { code: "SUBMISSION_FAILED", status: "Last attempt stopped",
      reason: f.lastStopDetail
        ? `The run stopped safely before the submit click: ${String(f.lastStopDetail).split("\n")[0]}`
        : "The run stopped safely before the submit click; the event log has the recorded reason.",
      action: { label: "See what stopped it", href: `${href}/events` } };
  }
  if (f.status === "READY_TO_SUBMIT" && (f.humanApproved)) {
    return { code: "READY_TO_SUBMIT", status: "Ready",
      reason: "Every gate passes. The listener submits it next; no action is needed from you.", action: null };
  }
  return { code: "PROCESSING", status: "Processing",
    reason: "The pipeline is still preparing this application; nothing is needed from you yet.", action: null };
}
