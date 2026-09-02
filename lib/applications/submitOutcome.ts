/**
 * Classifying how a submission run ended.
 *
 * The only question that matters is whether the irreversible employer
 * Submit click may have occurred. Not what kind of interruption
 * happened, not whether the process exited cleanly: whether the
 * employer may already hold the application.
 *
 * A CAPTCHA before the click is a handoff and safe to retry. The same
 * CAPTCHA after the click is ambiguous. A timeout before the click is
 * safe; the same timeout a second later is not. When it cannot be
 * established either way, the answer is AMBIGUOUS, because the cost of
 * being wrong is a duplicate application to a real employer.
 */

export type SubmitOutcome = "CONFIRMED" | "SAFE_STOP" | "AMBIGUOUS" | "DECLINED";

export interface RunFacts {
  /** The employer confirmed receipt and it was persisted. */
  submittedAt: string | null;
  /**
   * Written immediately before the click and never cleared by the
   * submitter, so it survives the process being killed.
   */
  clickAttemptedAt: string | null;
  /** When the listener claimed this run. Anything earlier belongs to a previous run. */
  claimedAt: string;
  /** The request was refused before any browser work started. */
  declined?: boolean;
}

export function classifyOutcome(f: RunFacts): { outcome: SubmitOutcome; reason: string } {
  if (f.declined) {
    return { outcome: "DECLINED", reason: "the request was refused before any browser work began" };
  }
  if (f.submittedAt) {
    return { outcome: "CONFIRMED", reason: "the employer confirmed receipt" };
  }

  // A marker from an earlier run says nothing about this one. Only a
  // click during this claim counts.
  const clickedThisRun = f.clickAttemptedAt !== null && f.clickAttemptedAt >= f.claimedAt;
  if (clickedThisRun) {
    return {
      outcome: "AMBIGUOUS",
      reason: "submit was clicked and no confirmation could be read; the employer may hold this application",
    };
  }
  return {
    outcome: "SAFE_STOP",
    reason: "the run ended before the submit click, so nothing reached the employer",
  };
}

/** Whether a person may ask for this to be submitted again. */
export function retryAllowed(outcome: SubmitOutcome | null): boolean {
  return outcome === null || outcome === "SAFE_STOP" || outcome === "DECLINED";
}
