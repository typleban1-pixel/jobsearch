"use client";
import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { summarizeQueue } from "../../lib/portal/queueFeedback.ts";

export interface QueuedResult { state: "queued" | "already"; applicationId?: string }
interface QueueCtx {
  selectedIds: Set<string>;
  toggle: (jobId: string, openingId: string) => void;
  queuedOf: (jobId: string) => QueuedResult | undefined;
}
const Ctx = createContext<QueueCtx | null>(null);
export const useJobsQueue = () => useContext(Ctx);

/**
 * Client-side selection for bulk queueing. Checking a card only selects
 * it; the DRAFTs are created only when "Queue Jobs" is pressed. Results
 * update card state in place -- no full-page refresh -- and a job that
 * could not be queued stays selected so it can be retried.
 */
export function JobsQueue({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Map<string, string>>(new Map()); // jobId -> openingId
  const [queued, setQueued] = useState<Map<string, QueuedResult>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const toggle = useCallback((jobId: string, openingId: string) => {
    setSelected((prev) => { const m = new Map(prev); m.has(jobId) ? m.delete(jobId) : m.set(jobId, openingId); return m; });
  }, []);

  const queue = async () => {
    if (submitting || selected.size === 0) return;
    setSubmitting(true); setNote(null);
    try {
      const jobIds = [...selected.keys()];
      const res = await fetch("/api/applications/queue", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobIds }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setNote(json.error ?? "Could not queue — try again."); return; }
      const results: Array<{ jobId: string; state: string; applicationId?: string; message: string }> = json.results ?? [];
      const nextSel = new Map(selected); const nextQ = new Map(queued);
      for (const r of results) {
        if (r.state === "queued") { nextQ.set(r.jobId, { state: "queued", applicationId: r.applicationId }); nextSel.delete(r.jobId); }
        else if (r.state === "already") { nextQ.set(r.jobId, { state: "already" }); nextSel.delete(r.jobId); }
        // A refused job stays selected so it can be retried; the reason is now
        // shown at the button (see the dock) rather than only off-screen.
      }
      setSelected(nextSel); setQueued(nextQ);
      setNote(summarizeQueue(results).note || "Nothing to queue.");
    } finally { setSubmitting(false); }
  };

  return (
    <Ctx.Provider value={{ selectedIds: new Set(selected.keys()), toggle, queuedOf: (id) => queued.get(id) }}>
      {children}
      {(note || selected.size > 0) && (
        <div className="queuedock">
          {note && <p className="queuemsg" role="status" aria-live="polite">{note}</p>}
          {selected.size > 0 && (
            <div className="queuebar" role="region" aria-label="Bulk queue">
              <span><b>{selected.size}</b> selected</span>
              <button className="btn-quiet" onClick={() => { setSelected(new Map()); setNote(null); }} disabled={submitting}>Clear</button>
              <button className="btn-primary" onClick={queue} disabled={submitting}>
                {submitting ? "Queuing…" : `Queue ${selected.size} Job${selected.size === 1 ? "" : "s"}`}
              </button>
            </div>
          )}
        </div>
      )}
    </Ctx.Provider>
  );
}
