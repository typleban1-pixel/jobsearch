"use client";
import { useJobsQueue } from "./jobs/JobsQueue.tsx";

/**
 * A card's queue control: a checkbox when the job is selectable, or a
 * persistent state pill once an application exists for it (so it can
 * never be accidentally queued twice). The pill reflects either the
 * server-loaded application status or the just-queued client result.
 */
const PILL: Record<string, string> = {
  DRAFT: "Queued", PREPARING: "Preparing", BLOCKED_NEEDS_INPUT: "Needs you",
  AWAITING_REVIEW: "Needs review", READY_TO_SUBMIT: "Ready", SUBMITTED: "Submitted",
  ACKNOWLEDGED: "Submitted", IN_PROCESS: "Submitted", INTERVIEWING: "Submitted", OFFER: "Submitted",
};

export function JobSelect({ jobId, openingId, appStatus }: { jobId: string; openingId: string; appStatus: string | null }) {
  const q = useJobsQueue();
  if (!q) return null;
  const justQueued = q.queuedOf(jobId);
  const effective = justQueued?.state === "queued" ? "DRAFT" : appStatus;

  if (effective || justQueued?.state === "already") {
    const label = effective ? (PILL[effective] ?? "In applications") : "In applications";
    return <span className={`statepill s-${(effective ?? "already").toLowerCase()}`}>{label}</span>;
  }
  return (
    <label className="jobselect" title="Select to queue">
      <input type="checkbox" checked={q.selectedIds.has(jobId)} onChange={() => q.toggle(jobId, openingId)} />
    </label>
  );
}
