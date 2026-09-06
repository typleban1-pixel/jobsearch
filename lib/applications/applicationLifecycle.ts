/**
 * Application lifecycle semantics for the autonomous worker's selection.
 *
 * A job's OPENING can be occupied by an application in three meaningfully
 * different ways, and the worker must treat them differently:
 *
 *   SUBMITTED               a submission reached the employer. Exactly-once:
 *                           never submit this opening again.
 *   ACTIVE (in progress)    a non-closed, non-submitted attempt exists
 *                           (DRAFT/PREPARING/AWAITING_REVIEW/READY_TO_SUBMIT/
 *                           BLOCKED_NEEDS_INPUT). Reuse/resume it; do not start
 *                           a duplicate for the same opening.
 *   CLOSED                  ABANDONED / WITHDRAWN / REJECTED. A historical
 *                           record. It must NOT be reused, and must NOT mark
 *                           the opening as worked -- otherwise one abandoned
 *                           row (e.g. a dry-run that abandoned itself)
 *                           permanently blocks the job from ever being
 *                           prepared fresh, which is the bug this fixes.
 *
 * SUBMISSION_UNCERTAIN (a prior submit click with no confirmation) is NOT a
 * status here; it is guarded separately by submit_click_attempted_at in the
 * submit path and is never auto-retried.
 */
export const CLOSED_APP_STATUSES = new Set(["REJECTED", "WITHDRAWN", "ABANDONED"]);

export const isClosedApplication = (status: string | null | undefined): boolean =>
  CLOSED_APP_STATUSES.has(String(status ?? ""));

/**
 * The one ACTIVE application per job, for the prepare-or-reuse decision.
 * Closed applications are excluded so a closed row is never reused and never
 * hides a job from fresh preparation. Submitted applications are kept (the
 * worker skips them via submitted_at) so exactly-once still holds. When a job
 * has several non-closed apps the last wins, matching prior behaviour.
 */
export function activeApplicationByJob<T extends { job_id: string; status: string; submitted_at?: string | null }>(apps: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const a of apps) {
    if (isClosedApplication(a.status)) continue;
    m.set(a.job_id, a);
  }
  return m;
}

/**
 * The set of canonical opening ids already worked -- by a submission OR an
 * active in-progress attempt. Closed applications do not count, so an
 * abandoned attempt never blocks its opening's job (or a repost of it) from a
 * fresh application. jobOpening maps a job id to its canonical opening id.
 */
export function openingsWorked<T extends { job_id: string; status: string }>(apps: T[], jobOpening: (jobId: string) => string | null | undefined): Set<string> {
  const s = new Set<string>();
  for (const a of apps) {
    if (isClosedApplication(a.status)) continue;
    const op = jobOpening(a.job_id);
    if (op) s.add(op);
  }
  return s;
}
