/**
 * One place that records what a fill run did.
 *
 * There were three: fill-application.ts, fill-lever.ts and
 * submit-application.ts each built their own record object and inserted
 * it. Three copies is why a fourth path recorded nothing at all. The
 * Popl application is the evidence: the system opened an Ashby form,
 * filled part of it, a person finished and submitted it, and no row in
 * application_fill_runs says the form was ever opened. That is the hole
 * this module closes, by being the only way a run gets written.
 *
 * The rule it enforces is narrow and worth stating plainly:
 *
 *   If the system opened an employer form and put anything into it, or
 *   uploaded anything to it, that fact is recorded. Whether a machine or
 *   a person drove the keyboard afterwards does not change it.
 *
 * Fill provenance stays separate from submission_mode. submission_mode
 * answers "who pressed submit". fill_mode answers "who filled the
 * fields". A partial fill followed by a human takeover has
 * fill_mode = ASSISTED_MANUAL and submit_click_attempted = false, and
 * nothing about that record can be read as an automated submission.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FillOutcomeName } from "../browser/stopReasons.ts";

/** Who drove the browser. Not a claim about who submitted anything. */
export type FillMode = "AUTOMATED" | "ASSISTED_MANUAL";

/** The artifact actually handed to the employer's file input, if any. */
export interface UploadedArtifact {
  resumeId: string;
  sha256: string;
  path: string;
}

export interface FillRunStart {
  applicationId: string;
  provider: string;
  fillMode: FillMode;
  runDir: string;
  startedAt: string;
  formSnapshotHash: string | null;
}

/**
 * Opens a run. Called before the browser touches the form, so that a
 * process killed mid-fill still has a start time to reconcile against.
 */
export function startFillRun(input: {
  applicationId: string;
  provider: string;
  runDir: string;
  fillMode?: FillMode;
  formSnapshotHash?: string | null;
}): FillRunStart {
  return {
    applicationId: input.applicationId,
    provider: input.provider,
    fillMode: input.fillMode ?? "AUTOMATED",
    runDir: input.runDir,
    startedAt: new Date().toISOString(),
    formSnapshotHash: input.formSnapshotHash ?? null,
  };
}

export interface FillRunResult {
  outcome: FillOutcomeName;
  /** The stop or handoff reason, in words a person can act on. */
  detail: string;
  filled: ReadonlyArray<{ field: string; value: string }>;
  leftBlank: ReadonlyArray<{ field: string; why: string }>;
  parserReconciliation?: unknown;
  guardReport?: unknown;
  /** Null when nothing was uploaded. Never a guess. */
  artifact?: UploadedArtifact | null;
  /**
   * True only where an irreversible employer submit action may have been
   * taken. The filler has no code path that can set this; only the
   * submit worker does, and only after writing its own boundary column.
   */
  submitClickAttempted?: boolean;
  /** Anything the caller wants kept in run.json but not in the table. */
  extra?: Record<string, unknown>;
}

/** The row, built in exactly one place. */
export function fillRunRecord(start: FillRunStart, result: FillRunResult) {
  const filled = result.filled.length;
  const blank = result.leftBlank.length;
  return {
    application_id: start.applicationId,
    started_at: start.startedAt,
    finished_at: new Date().toISOString(),
    provider: start.provider,
    fill_mode: start.fillMode,
    outcome: result.outcome,
    stop_detail: result.detail.slice(0, 2000),
    form_snapshot_hash_at_fill: start.formSnapshotHash,
    fields_attempted: filled + blank,
    fields_filled: filled,
    fields_left_blank: blank,
    parser_reconciliation: result.parserReconciliation ?? [],
    guard_report: result.guardReport ?? {},
    screenshot_dir: start.runDir,
    resume_id: result.artifact?.resumeId ?? null,
    artifact_sha256: result.artifact?.sha256 ?? null,
    artifact_path: result.artifact?.path ?? null,
    submit_click_attempted: result.submitClickAttempted === true,
  };
}

/**
 * The audit line. Written from the record rather than from the caller's
 * narration, so the event and the row cannot describe different runs.
 *
 * It says what was uploaded and whether submit was touched, because
 * those are the two questions asked of a fill six weeks later and
 * neither should require opening a screenshot directory to answer.
 */
export function fillRunEventDetail(record: ReturnType<typeof fillRunRecord>): string {
  const drove = record.fill_mode === "ASSISTED_MANUAL"
    ? "System opened the form and filled part of it; a person took over."
    : "Filled by the worker.";
  const artifact = record.artifact_sha256
    ? `Uploaded ${record.artifact_path} (sha256 ${record.artifact_sha256.slice(0, 12)}).`
    : "Nothing uploaded.";
  const submit = record.submit_click_attempted
    ? "An irreversible submit action was attempted during this run."
    : "The submit control was not touched.";
  return `${record.outcome}: ${record.stop_detail.slice(0, 400)} ${drove} `
    + `Filled ${record.fields_filled} of ${record.fields_attempted}, left blank ${record.fields_left_blank}. `
    + `${artifact} ${submit} Evidence in ${record.screenshot_dir}.`;
}

/** The event name, from a fixed set. Never assembled from a provider string. */
export function fillRunEventName(record: ReturnType<typeof fillRunRecord>): string {
  if (record.fill_mode === "ASSISTED_MANUAL") return "ASSISTED_FILL_RECORDED";
  return record.outcome === "HANDOFF" ? "FILL_HANDOFF" : "FILL_STOPPED";
}

/**
 * Writes the run: the directory first, then the table, then the event.
 *
 * The directory is written unconditionally and before anything else,
 * because it is the durable artifact and the only one that survives the
 * database being unreachable. A failure to record in the database is
 * reported and does not throw: losing the console output of a completed
 * fill because the audit insert failed would be a worse outcome than an
 * unrecorded row, and the directory still holds the truth.
 */
export async function recordFillRun(
  db: SupabaseClient,
  start: FillRunStart,
  result: FillRunResult,
): Promise<{ record: ReturnType<typeof fillRunRecord>; warnings: string[] }> {
  const record = fillRunRecord(start, result);
  const warnings: string[] = [];

  await mkdir(start.runDir, { recursive: true }).catch(() => undefined);
  await writeFile(
    join(start.runDir, "run.json"),
    JSON.stringify({ ...record, ...(result.extra ?? {}), filled: result.filled, leftBlank: result.leftBlank }, null, 2),
  ).catch((e: unknown) => { warnings.push(`run.json not written: ${String(e)}`); });

  const { error: recErr } = await db.from("application_fill_runs").insert(record);
  if (recErr) warnings.push(`fill run not recorded in the database: ${recErr.message}`);

  const { error: evtErr } = await db.from("application_events").insert({
    application_id: start.applicationId,
    event: fillRunEventName(record),
    detail: fillRunEventDetail(record),
    actor: "system",
  });
  if (evtErr) warnings.push(`fill run event not recorded: ${evtErr.message}`);

  return { record, warnings };
}
