"use client";
import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { summarizeQueue } from "../../lib/portal/queueFeedback.ts";

export interface QueuedResult { state: "queued" | "already"; applicationId?: string }
interface QueueCtx {
  selectedIds: Set<string>;
  busy: boolean;
  toggle: (jobId: string, openingId: string) => void;
  /** Prepare these jobs now (one, or the whole selection). */
  prepare: (jobIds: string[]) => Promise<void>;
  queuedOf: (jobId: string) => QueuedResult | undefined;
}
const Ctx = createContext<QueueCtx | null>(null);
export const useJobsQueue = () => useContext(Ctx);

/**
 * Selection and preparation from the Jobs list.
 *
 * Checking a card only selects it; applications are created when
 * "Prepare N applications" (or a card's own "Prepare application") is
 * pressed, through the same endpoint. Results update the cards in place
 * with no page reload, and a job that could not be prepared stays
 * selected so it can be retried. The backend still calls this a queue;
 * the person is preparing applications.
 */
export function JobsQueue({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Map<string, string>>(new Map()); // jobId -> openingId
  const [queued, setQueued] = useState<Map<string, QueuedResult>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const toggle = useCallback((jobId: string, openingId: string) => {
    setSelected((prev) => { const m = new Map(prev); m.has(jobId) ? m.delete(jobId) : m.set(jobId, openingId); return m; });
  }, []);

  const prepare = async (jobIds: string[]) => {
    if (submitting || jobIds.length === 0) return;
    setSubmitting(true); setNote(null);
    try {
      const res = await fetch("/api/applications/queue", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobIds }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setNote(json.error ?? "Could not start preparing — try again."); return; }
      const results: Array<{ jobId: string; state: string; applicationId?: string; message: string }> = json.results ?? [];
      const nextSel = new Map(selected); const nextQ = new Map(queued);
      for (const r of results) {
        if (r.state === "queued") { nextQ.set(r.jobId, { state: "queued", applicationId: r.applicationId }); nextSel.delete(r.jobId); }
        else if (r.state === "already") { nextQ.set(r.jobId, { state: "already" }); nextSel.delete(r.jobId); }
        // A refused job stays selected so it can be retried; the reason is
        // shown at the button rather than off-screen.
      }
      setSelected(nextSel); setQueued(nextQ);
      setNote(summarizeQueue(results).note || "Nothing to prepare.");
    } finally { setSubmitting(false); }
  };

  const n = selected.size;
  return (
    <Ctx.Provider value={{ selectedIds: new Set(selected.keys()), busy: submitting, toggle, prepare, queuedOf: (id) => queued.get(id) }}>
      {children}
      {(note || n > 0) && (
        <div className="queuedock">
          {note && <p className="queuemsg" role="status" aria-live="polite">{note}</p>}
          {n > 0 && (
            <div className="queuebar" role="region" aria-label="Selected jobs">
              <span><b>{n}</b> selected</span>
              <button className="btn-quiet" onClick={() => { setSelected(new Map()); setNote(null); }} disabled={submitting}>Clear</button>
              <button className="btn-primary" onClick={() => prepare([...selected.keys()])} disabled={submitting}>
                {submitting ? "Preparing…" : `Prepare ${n} application${n === 1 ? "" : "s"} →`}
              </button>
            </div>
          )}
        </div>
      )}
    </Ctx.Provider>
  );
}
