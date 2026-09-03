/**
 * One human state, and one next action, per application.
 *
 * The internal state machine is right and stays exactly as it is. What
 * it is not is something to read at a glance: "READY_TO_SUBMIT with
 * human_approved false and 5 blocked answers" describes a situation
 * precisely without saying what to do about it.
 *
 * This maps the internal record onto the four states a person actually
 * operates in, and names the single next action for each. It decides
 * nothing: every input is already computed elsewhere, and a refusal
 * reported here was decided by the submission guard, not invented.
 */

export type PresentationState = "NEEDS_YOU" | "PREPARING" | "READY" | "SUBMITTED" | "CLOSED";

export interface ApplicationFacts {
  status: string;
  humanApproved: boolean;
  allFieldsConfident: boolean;
  blockedAnswers: number;
  submittedAt: string | null;
  confirmationReceived: boolean;
  provider: string;
  /** Refusal codes from revalidateBeforeSubmit, empty when it passes. */
  refusals: string[];
  /** True when the internal record is in HANDOFF, which a person never needs to know. */
  handoff: boolean;
  /** A submission request is queued but no worker has claimed it. */
  submitQueued?: boolean;
  /**
   * How many application fields have actually been discovered.
   *
   * Zero is not coverage. all_fields_confident is recomputed by a
   * trigger over the answer rows, so with no rows it cannot be
   * recomputed at all and an older true can survive a form that was
   * never read. Northern Trust sat in exactly that state: no fields, no
   * answers, and a page offering to approve nothing.
   *
   * Optional so existing callers keep working; when it is absent the
   * old behaviour applies, and when it is zero approval is refused.
   */
  discoveredFields?: number;
  /** A worker has claimed the request and is running it now. */
  submitRunning?: boolean;
  /** How the last request ended. */
  submitOutcome?: "CONFIRMED" | "SAFE_STOP" | "AMBIGUOUS" | "DECLINED" | null;
  /**
   * Where the employer actually takes applications.
   *
   * "Continue on Ashby" used to point at the internal review page,
   * because every action in this module shared one href and this field
   * did not exist. A button named after the employer has to go there.
   */
  applyUrl?: string | null;
  /**
   * Why this application needs a person, in the words of what is
   * actually true for THIS provider.
   */
  handoffReason?: string | null;
}

export interface Presentation {
  state: PresentationState;
  /** What is going on, in a sentence a person can act on. */
  summary: string;
  /** The one button. */
  action: { label: string; href: string } | null;
}

const ATS_LABEL: Record<string, string> = {
  WORKDAY: "Workday", GREENHOUSE: "Greenhouse", LEVER: "Lever", ASHBY: "Ashby",
};

export function present(f: ApplicationFacts, applicationId: string): Presentation {
  const href = `/applications/${applicationId}`;

  // Submitted is terminal and says so plainly. Clicking submit is not
  // submission: without employer confirmation this must not read as sent.
  if (f.submittedAt) {
    return f.confirmationReceived
      ? { state: "SUBMITTED", summary: "Submitted. Employer confirmation received.",
          action: { label: "View application", href } }
      : { state: "SUBMITTED", summary: "Submission needs verification. No employer confirmation yet.",
          action: { label: "Check submission", href } };
  }

  // An unverified submission outranks everything else on the row. The
  // employer may hold this application; nothing about it is routine
  // until a person has been and looked.
  if (f.submitOutcome === "AMBIGUOUS") {
    return {
      state: "NEEDS_YOU",
      summary: "Submit was clicked but the employer did not confirm receipt. "
        + "Check whether they received it before anything else happens.",
      action: { label: "Check this submission", href: `${href}/review` },
    };
  }

  // In flight. Said plainly, and with nothing to click.
  if (f.submitRunning) {
    return { state: "PREPARING", summary: "Submitting\u2026", action: null };
  }
  if (f.submitQueued) {
    return { state: "PREPARING", summary: "Starting submission\u2026", action: null };
  }

  if (f.status === "ABANDONED" || f.status === "WITHDRAWN") {
    return { state: "CLOSED", summary: "Closed. Not being pursued.", action: { label: "View application", href } };
  }

  // HANDOFF is an internal word. What a person needs is the thing they
  // have to go and do, named as the thing itself.
  if (f.handoff) {
    const ats = ATS_LABEL[f.provider] ?? f.provider;
    return {
      state: "NEEDS_YOU",
      // Only what is actually established for this provider. The old
      // copy told every provider it required a sign-in, which was
      // written for Workday and untrue of Ashby, whose problem is that
      // it publishes no form at all.
      // No "your progress has been saved" tail.
      //
      // It was true of Popl, where the system had filled part of the
      // form, and false of Northern Trust, where nothing has been filled
      // and there are no answers at all. A reassurance that is wrong
      // half the time is worse than no reassurance: the sentence a
      // person needs is the one naming what to go and do.
      summary: f.handoffReason ?? `${ats} needs you to finish this application.`,
      action: f.applyUrl
        ? { label: `Continue on ${ats}`, href: f.applyUrl }
        : { label: "Open application", href: `${href}/review` },
    };
  }

  if (f.blockedAnswers > 0) {
    return {
      state: "NEEDS_YOU",
      summary: `${f.blockedAnswers} question${f.blockedAnswers === 1 ? " needs" : "s need"} your answer`,
      action: { label: "Answer questions", href: `${href}/questions` },
    };
  }

  if (f.status === "BLOCKED_NEEDS_INPUT") {
    return { state: "NEEDS_YOU", summary: "Something is needed from you before this can continue.",
      action: { label: "Open application", href } };
  }

  // A refusal from the submission guard, split by whether a person can
  // do anything about it.
  //
  // "Needs you" has to mean there is an action available. SpotHero was
  // refused because its candidacy is now REJECT: no amount of reviewing,
  // re-approving or re-preparing makes a REJECT submittable, so putting
  // it in the queue of things awaiting a person was asking for attention
  // that could not be spent. It belongs with the closed work.
  //
  // The other refusals are different in kind. A posting that changed, or
  // a resume that no longer matches the approved one, is fixed by
  // re-preparing and re-reading it, and that is genuinely work for a
  // person.
  if (f.refusals.length > 0) {
    const said: Record<string, string> = {
      CANDIDACY_REFUSES: "Skipped. This no longer looks like a good match, so it is not safe to send.",
      NOT_ELIGIBLE: "Skipped. This job no longer meets your eligibility rules.",
      POSTING_NOT_OPEN: "Closed. The posting is no longer open.",
      ALREADY_SUBMITTED_ON_OPENING: "Closed. You have already applied to this opening.",
      APPROVAL_PREDATES_CANDIDACY: "The job was re-analyzed after you approved this. It needs another look.",
      POSTING_CHANGED: "The employer changed this posting after it was prepared.",
      ARTIFACT_CHANGED: "The prepared resume no longer matches the one you approved.",
    };
    // Nothing a person does changes these, so they are not work.
    const TERMINAL = new Set([
      "CANDIDACY_REFUSES", "NOT_ELIGIBLE", "POSTING_NOT_OPEN", "ALREADY_SUBMITTED_ON_OPENING",
    ]);
    const terminal = f.refusals.find((c) => TERMINAL.has(c));
    if (terminal) {
      return { state: "CLOSED", summary: said[terminal] ?? "Skipped by the system.",
        action: { label: "View application", href } };
    }
    const first = f.refusals[0]!;
    return { state: "NEEDS_YOU", summary: said[first] ?? "This needs another look before it can be sent.",
      action: { label: "Review application", href: `${href}/review` } };
  }

  // An application with no discovered fields is never ready, whatever
  // the confidence flag says: there is nothing to have been confident
  // about. Checked before the ready paths below rather than inside them,
  // so no route can reach approval past it.
  const nothingDiscovered = f.discoveredFields === 0;

  if (f.status === "AWAITING_REVIEW" || (f.allFieldsConfident && !nothingDiscovered && !f.humanApproved)) {
    return { state: "READY", summary: "Application prepared and checked.",
      action: { label: "Review application", href: `${href}/review` } };
  }

  if (f.status === "READY_TO_SUBMIT" && f.humanApproved && f.allFieldsConfident && !nothingDiscovered) {
    if (f.submitOutcome === "SAFE_STOP") {
      return { state: "READY",
        summary: "The last attempt stopped before anything was sent. You can try again.",
        action: { label: "Submit application", href: `${href}/review` } };
    }
    if (f.submitOutcome === "DECLINED") {
      return { state: "READY",
        summary: "The last request was declined before it started. You can try again.",
        action: { label: "Submit application", href: `${href}/review` } };
    }
    return { state: "READY", summary: "Approved and ready to send.",
      action: { label: "Submit application", href: `${href}/review` } };
  }

  return { state: "PREPARING", summary: "Being prepared. Nothing needed from you.", action: null };
}
