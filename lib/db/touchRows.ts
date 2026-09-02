/**
 * Upsert batches for jobs whose content did not change.
 *
 * THE DEFECT THIS CLOSES
 *
 * touchUnchanged built one row per input and spread the status fields in
 * conditionally: a job that had gone away and come back got status,
 * status_changed_at and closed_detection_reason; a job that was already
 * OPEN got none of them, because an UPDATE that omits a column leaves it
 * alone and that is exactly the desired behavior.
 *
 * PostgREST does not send one statement per row. It sends one
 * INSERT ... ON CONFLICT for the whole batch, and the column list is the
 * UNION of the keys across every row in it. So the moment one reappeared
 * job shared a batch with ordinary unchanged ones, `status` became a
 * column of the statement and every row that omitted it was sent an
 * explicit NULL. Postgres validates NOT NULL against the proposed tuple
 * before it resolves the conflict, so the statement died even though
 * every one of those rows already existed and would only have been
 * updated:
 *
 *   null value in column "status" of relation "jobs" violates not-null
 *   constraint | code: 23502
 *
 * One throw aborted the whole ingest run through Promise.all, so no
 * board after it was reconciled. It was intermittent because it needs a
 * reappearance and an ordinary touch in the same 500-row slice.
 *
 * THE FIX
 *
 * Never put two shapes in one statement. Rows are partitioned by the
 * columns they actually need before anything is chunked, so the union of
 * keys within a batch is the same as the keys of any row in it.
 *
 * What is deliberately NOT done: adding status to every row to make the
 * shapes match. That would write a lifecycle column on every unchanged
 * job on every run, and pairing it with status_changed_at would
 * manufacture a change timestamp for jobs that did not change. The
 * absence of those fields on an ordinary touch is the design, not an
 * oversight.
 */
import type { JobWriteInput } from "./store.ts";

/** Which columns a touched row needs. The two shapes are never mixed. */
export type TouchShape = "OPEN" | "REAPPEARED";

export interface TouchBatch {
  shape: TouchShape;
  rows: Record<string, unknown>[];
}

/** Columns every touched row carries, whatever its shape. */
const commonRow = (u: JobWriteInput): Record<string, unknown> => ({
  id: u.existing!.id,
  company_id: u.companyId,
  source: u.source,
  external_id: u.normalized.sourceJobId,
  title: u.normalized.title,
  last_seen_at: u.fetchedAt,
  last_seen_open_at: u.fetchedAt,
  consecutive_missing_checks: 0,
});

/**
 * A job that was already OPEN. It keeps the status metadata it has:
 * status is not resent, so status_changed_at is not disturbed and the
 * row does not claim a transition that did not happen.
 */
export const openRow = (u: JobWriteInput): Record<string, unknown> => commonRow(u);

/**
 * A job that had left the board and is back. This is a real transition
 * and carries the timestamp and reason for it.
 */
export const reappearedRow = (u: JobWriteInput): Record<string, unknown> => ({
  ...commonRow(u),
  status: "OPEN",
  status_changed_at: u.fetchedAt,
  closed_detection_reason: "reappeared on board",
});

export const isReappearing = (u: JobWriteInput): boolean => u.existing!.status !== "OPEN";

/**
 * Homogeneous batches, ready to upsert one at a time.
 *
 * Partition first, then chunk. Chunking first and partitioning inside
 * each chunk would give the same shapes but a different number of
 * statements; partitioning first also means a single reappearance in a
 * run of ten thousand touches costs one extra statement rather than
 * splitting a slice.
 */
export function touchBatches(inputs: JobWriteInput[], size = 500): TouchBatch[] {
  const open = inputs.filter((u) => !isReappearing(u));
  const reappeared = inputs.filter(isReappearing);
  const out: TouchBatch[] = [];
  const push = (shape: TouchShape, rows: Record<string, unknown>[]) => {
    for (let i = 0; i < rows.length; i += size) out.push({ shape, rows: rows.slice(i, i + size) });
  };
  push("OPEN", open.map(openRow));
  push("REAPPEARED", reappeared.map(reappearedRow));
  return out;
}

/**
 * The columns of a batch, as PostgREST will compute them: the union
 * across its rows. Exported so a test can assert the union equals every
 * individual row's key set, which is the property that was violated.
 */
export const batchColumns = (b: TouchBatch): string[] =>
  [...new Set(b.rows.flatMap((r) => Object.keys(r)))].sort();
