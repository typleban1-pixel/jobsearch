import type { NormalizedJob } from "../ingest/providers/types.ts";
import type { DetectedChange } from "../ingest/diff.ts";

/**
 * Persistence boundary.
 *
 * Two implementations exist: Supabase (real) and a file-backed double
 * used to validate the pipeline where no database is reachable. The
 * double is not a convenience: it enforces the same unique constraints
 * and the same append-only rules, so a pipeline bug that the schema would
 * have caught is caught here too rather than surfacing on first push.
 */

export type JobStatus =
  | "OPEN" | "POSSIBLY_CLOSED" | "CLOSED_OR_REMOVED" | "CONFIRMED_CLOSED" | "ARCHIVED";

export interface CompanyRow {
  id: string;
  name: string;
  domain: string | null;
  ats_provider: string;
  ats_token: string | null;
  lifecycle: string;
  priority_score: number;
  consecutive_check_failures: number;
  open_job_count: number | null;
}

export interface ExistingJob {
  id: string;
  external_id: string;
  content_hash: string | null;
  status: JobStatus;
  consecutive_missing_checks: number;
  current_version_id: string | null;
  current_version_number: number;
  current_normalized: NormalizedJob | null;
}

export interface FetchRecord {
  ingest_run_id: string;
  company_id: string | null;
  ats_provider: string;
  endpoint_url: string;
  http_status: number | null;
  ok: boolean;
  error: string | null;
  response_bytes: number;
  response_hash: string | null;
  jobs_in_payload: number | null;
  duration_ms: number;
  fetcher_version: number;
  raw_body: string | null;
  raw_body_retained: boolean;
  retention_reason: string | null;
  retain_until: string | null;
}

export interface JobWriteResult {
  jobId: string;
  isNew: boolean;
  versionCreated: boolean;
  versionNumber: number;
  changes: DetectedChange[];
  duplicateOfJobId: string | null;
}

export interface RunStats {
  companies_checked: number;
  companies_failed: number;
  jobs_seen: number;
  jobs_new: number;
  jobs_changed: number;
  jobs_missing: number;
  llm_calls: number;
  estimated_cost_cents: number;
  error_summary: string | null;
  status: string;
}

export interface Store {
  readonly kind: "supabase" | "file";

  listCompaniesToCheck(limit: number): Promise<CompanyRow[]>;
  upsertCompany(input: {
    name: string; domain: string | null; ats_provider: string; ats_token: string;
    lifecycle: string; priority_score: number; industries: string[];
    discovery_method: string; discovery_source: string | null;
  }): Promise<CompanyRow>;
  markCompanyVerified(companyId: string, jobCount: number): Promise<void>;
  recordCompanyCheck(input: {
    companyId: string; ok: boolean; jobCount: number | null;
    durationMs: number; error: string | null; runId: string;
  }): Promise<void>;

  startRun(): Promise<string>;
  finishRun(runId: string, stats: RunStats): Promise<void>;

  recordFetch(record: FetchRecord): Promise<string>;

  listJobsForCompany(companyId: string, source: string): Promise<ExistingJob[]>;

  /** Staged closed detection. Only ever called after a SUCCESSFUL fetch. */
  markMissing(input: {
    companyId: string; source: string; seenExternalIds: Set<string>;
  }): Promise<MissingResult>;

  recordDuplicate(jobId: string, duplicateOfJobId: string): Promise<void>;

  /**
   * Batched deliberately. A single Greenhouse board can be 574 jobs, and
   * a per-job round trip would make a daily run take minutes of pure
   * latency for work the database can do in a handful of statements.
   */
  writeJobs(inputs: JobWriteInput[]): Promise<JobWriteResult[]>;

  healthReport(): Promise<Record<string, unknown>>;

  /**
   * Persist and release. A no-op against Supabase, where every statement
   * has already committed, and the actual write for the file-backed
   * store. Scripts must call it in a finally block: without it a run that
   * only verifies companies leaves nothing behind.
   */
  close(): Promise<void>;
}

export interface JobWriteInput {
  companyId: string;
  source: string;
  runId: string;
  fetchId: string;
  normalized: NormalizedJob;
  raw: unknown;
  contentHash: string;
  descriptionHash: string;
  rawFragmentHash: string;
  normalizerVersion: number;
  fetcherVersion: number;
  /** The job as it stood before this run, or undefined if never seen. */
  existing: ExistingJob | undefined;
  fetchedAt: string;
}

export interface MissingResult {
  possiblyClosed: number;
  closedOrRemoved: number;
}
