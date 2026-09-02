/**
 * Keeping application state honest when candidacy changes underneath it.
 *
 * THE DEFECT
 *
 * SpotHero reached READY_TO_SUBMIT at 04:46 on 31 August. At 22:20 the
 * same day, score-candidacy recomputed the verdict for that job and
 * wrote REJECT. Nothing looked at the application, so it sat advertising
 * itself as ready to send for two days while the authoritative verdict
 * said it should never be sent.
 *
 * Two separate things made that possible:
 *
 *   score-candidacy UPSERTS on (job, profile, formula, taxonomy, model),
 *   so a re-run replaces a verdict in place. The verdict that authorized
 *   preparation is simply gone, and there is no record it ever said
 *   anything else.
 *
 *   Nothing reconciles downstream state afterwards. checkCandidacy is
 *   consulted when preparation STARTS and revalidateBeforeSubmit when a
 *   submission is attempted, and between those two moments an
 *   application can be left in a state its verdict no longer supports.
 *
 * WHY NOT JUST RELY ON THE SUBMIT GUARD
 *
 * revalidateBeforeSubmit would have refused the send, so nothing unsafe
 * could have left the building. But "the guard will catch it" is not the
 * same as "the state is true": a person reading the queue saw an
 * application described as ready to submit, and that description was
 * false for two days. The guard is the last line, not the only one.
 *
 * WHAT THIS DOES NOT DO
 *
 * It never deletes an application and never erases that one was
 * prepared. The artifact, the answers and the history stay exactly where
 * they are. The only thing it changes is the claim the status makes
 * about what may happen next.
 */

/** Verdicts under which an application may hold a submission-ready state. */
const PERMITS_SUBMISSION = new Set(["APPLICATION_CANDIDATE", "STRETCH"]);

/** Statuses that assert an application is ready, or nearly ready, to send. */
const FORWARD_STATUSES = new Set(["READY_TO_SUBMIT", "AWAITING_REVIEW"]);

/** Statuses that are already terminal and are never disturbed. */
const CLOSED = new Set(["SUBMITTED", "ABANDONED", "REJECTED", "WITHDRAWN", "CLOSED",
  "ACKNOWLEDGED", "IN_PROCESS", "INTERVIEWING", "OFFER"]);

export interface ApplicationState {
  id: string;
  status: string;
  submittedAt: string | null;
  humanApproved: boolean;
}

export interface Reconciliation {
  applicationId: string;
  from: string;
  to: string;
  clearApproval: boolean;
  reason: string;
}

/**
 * What should change about one application, given the current verdict.
 *
 * Returns null when nothing should change, which is the answer for the
 * overwhelming majority and keeps this cheap to run after every scoring
 * pass.
 *
 * A submitted application is never reconciled. Whatever the verdict says
 * now, the document was sent, and rewriting the state afterwards would
 * be editing history rather than describing it.
 */
export function reconcileOne(
  app: ApplicationState,
  verdict: string | null,
): Reconciliation | null {
  if (app.submittedAt) return null;
  if (CLOSED.has(app.status)) return null;
  if (!FORWARD_STATUSES.has(app.status)) return null;

  // No verdict at all is not the same as a bad one. It means scoring has
  // not run for this job, and inventing a downgrade from silence is the
  // inference this system refuses to make everywhere else.
  if (verdict === null) return null;
  if (PERMITS_SUBMISSION.has(verdict)) return null;

  // MANUAL_REVIEW is not a refusal; it is a request for a person. It
  // does not permit submission, so a READY_TO_SUBMIT claim is wrong, but
  // it is honestly described by AWAITING_REVIEW rather than by anything
  // stronger.
  const to = "AWAITING_REVIEW";
  if (app.status === to) {
    // Already where it belongs. An approval is still wrong, though: it
    // was consent to send something the verdict now refuses.
    return app.humanApproved
      ? { applicationId: app.id, from: app.status, to,
          clearApproval: true,
          reason: `the current candidacy verdict is ${verdict}, which does not permit submission, `
            + "so the standing approval no longer refers to something that may be sent" }
      : null;
  }

  return {
    applicationId: app.id,
    from: app.status,
    to,
    clearApproval: app.humanApproved,
    reason: `the current candidacy verdict is ${verdict}, which does not permit submission. `
      + "The application was prepared under an earlier verdict that has since been recomputed; "
      + "it is returned to review rather than left advertising itself as ready to send. "
      + "Nothing about the prepared document has been changed or removed.",
  };
}

/** Every change a scoring pass implies for the applications it touched. */
export function reconcileAll(
  apps: ApplicationState[],
  verdictByApplication: Map<string, string | null>,
): Reconciliation[] {
  return apps
    .map((a) => reconcileOne(a, verdictByApplication.get(a.id) ?? null))
    .filter((r): r is Reconciliation => r !== null);
}
