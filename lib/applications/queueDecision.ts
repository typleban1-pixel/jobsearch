/**
 * Whether one job may be bulk-queued, as a pure decision.
 *
 * Separated from the route so the ordering of the gates -- not found,
 * closed, ineligible, not-a-candidate, already-applied, no-version -- is
 * testable without a request. "queue" is the only state that creates a
 * DRAFT; every other state is a per-job reason the caller reports and
 * moves on, so a partial failure is safe. It reads candidacy but changes
 * nothing about it.
 */
export type QueueState =
  | "queue" | "already" | "not_found" | "not_open" | "not_eligible" | "not_a_candidate" | "no_version";

export interface QueueDecision { state: QueueState; message: string }

export function classifyQueueJob(input: {
  job: { status: string; eligibility: string; canonical_opening_id: string | null } | undefined;
  verdict: string | undefined;
  versionId: string | undefined;
  /** A live application (any status other than REJECTED/WITHDRAWN/ABANDONED) already exists on the opening. */
  hasLiveApplication: boolean;
}): QueueDecision {
  const { job, verdict, versionId, hasLiveApplication } = input;
  if (!job) return { state: "not_found", message: "job not found" };
  if (job.status !== "OPEN") return { state: "not_open", message: "posting is no longer open" };
  if (job.eligibility === "INELIGIBLE") return { state: "not_eligible", message: "ruled out by your location/eligibility" };
  if (verdict === "REJECT") return { state: "not_a_candidate", message: "not a candidate" };
  if (verdict === "MANUAL_REVIEW") return { state: "not_a_candidate", message: "needs review before applying" };
  // A live application already exists -- including a SUBMITTED one, which
  // is live and so is never re-queued.
  if (hasLiveApplication) return { state: "already", message: "already in your applications" };
  if (!versionId) return { state: "no_version", message: "posting has no current version to freeze" };
  return { state: "queue", message: "ready to queue" };
}
