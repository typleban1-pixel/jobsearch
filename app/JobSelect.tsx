"use client";
import { useJobsQueue } from "./jobs/JobsQueue.tsx";
import { StateBadge } from "./StateBadge.tsx";
import type { JobCard } from "../lib/portal/db.ts";

/**
 * A card's one pipeline control.
 *
 * No application yet: a checkbox to select it for bulk preparation, and a
 * "Prepare application" button that prepares just this one. An application
 * exists (from the server, or created a moment ago from this page): its
 * state, in the same words the Applications page uses, leading to it.
 * A job is therefore never offered for preparation twice.
 */
export function JobPipelineControl({ jobId, openingId, appState }: {
  jobId: string; openingId: string; appState: JobCard["applicationState"];
}) {
  const q = useJobsQueue();
  const just = q?.queuedOf(jobId);
  if (just?.state === "queued") {
    return <StateBadge state="PREPARING" />;
  }
  if (just?.state === "already") {
    return <span className="statebadge s-already">In applications</span>;
  }
  if (appState) return <StateBadge state={appState.state} href={appState.href} />;
  if (!q) return null;
  const busy = q.busy;
  return (
    <span className="pipeline-select">
      <label className="jobselect" title="Select to prepare several at once">
        <input type="checkbox" checked={q.selectedIds.has(jobId)} onChange={() => q.toggle(jobId, openingId)}
          aria-label="Select this job" />
      </label>
      <button type="button" className="btn-primary" disabled={busy} onClick={() => q.prepare([jobId])}>
        Prepare application <span aria-hidden="true">&rarr;</span>
      </button>
    </span>
  );
}
