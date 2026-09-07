/**
 * Turns the per-job results of a bulk queue into one legible line.
 *
 * The bulk "Queue N Jobs" action returns a state per job. Some jobs cannot
 * be queued (a MANUAL_REVIEW verdict, a closed posting, no current version),
 * and when EVERY selected job is refused nothing on the card list changes --
 * so the reader has to be told, at the button, why. This is that message,
 * kept as a pure function so the click-to-feedback path is testable without a
 * browser (the gap that let "the button does nothing" ship).
 */
export interface QueueResult { jobId: string; state: string; message: string }
export interface QueueTally { queued: number; already: number; skipped: number; note: string }

export function summarizeQueue(results: QueueResult[]): QueueTally {
  let queued = 0;
  let already = 0;
  const reasons: string[] = [];
  for (const r of results) {
    if (r.state === "queued") queued += 1;
    else if (r.state === "already") already += 1;
    else reasons.push(r.message);
  }
  // Distinct reasons, so "2 need review" reads as one cause, not two lines.
  const distinct = [...new Set(reasons.filter(Boolean))];
  const note = [
    queued ? `${queued} preparing` : "",
    already ? `${already} already applied` : "",
    reasons.length
      ? `${reasons.length} not prepared (${distinct.slice(0, 2).join("; ")}${distinct.length > 2 ? "; …" : ""})`
      : "",
  ].filter(Boolean).join(" · ");
  return { queued, already, skipped: reasons.length, note };
}
