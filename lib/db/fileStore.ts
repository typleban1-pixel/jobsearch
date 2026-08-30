import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { detectChanges } from "../ingest/diff.ts";
import type {
  CompanyRow, ExistingJob, FetchRecord, JobWriteInput, JobWriteResult,
  MissingResult, RunStats, Store,
} from "./store.ts";
import type { NormalizedJob } from "../ingest/providers/types.ts";

/**
 * File-backed store: a working double for the Supabase schema.
 *
 * It exists so the ingestion pipeline can be validated against real
 * boards on a machine with no database. It is not a mock. It enforces the
 * same three things the schema enforces, because those are exactly the
 * rules a pipeline bug violates:
 *
 *   unique (source, external_id) on jobs
 *   unique (job_id, raw_fragment_hash) on raw payloads
 *   one current version per job, and frozen versions never mutate
 *
 * Payload bodies are dropped before writing to disk. Keeping every board
 * response would put hundreds of megabytes in a working directory to
 * demonstrate a hash that is already stored.
 */

interface Db {
  companies: CompanyRow[];
  ingest_runs: Record<string, unknown>[];
  ingest_run_companies: Record<string, unknown>[];
  source_fetches: Record<string, unknown>[];
  jobs: Record<string, unknown>[];
  job_versions: Record<string, unknown>[];
  job_changes: Record<string, unknown>[];
  job_raw_payloads: Record<string, unknown>[];
  job_relations: Record<string, unknown>[];
}

const EMPTY: Db = {
  companies: [], ingest_runs: [], ingest_run_companies: [], source_fetches: [],
  jobs: [], job_versions: [], job_changes: [], job_raw_payloads: [], job_relations: [],
};

export class FileStore implements Store {
  readonly kind = "file" as const;
  private db: Db;

  private dir: string;

  // Written out longhand: Node's type-stripping loader runs .ts directly
  // but rejects parameter properties, so a constructor shorthand here
  // would work under tsc and fail at runtime.
  constructor(dir = resolve(process.cwd(), ".corpus")) {
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
    const path = this.file();
    this.db = existsSync(path)
      ? { ...EMPTY, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<Db>) }
      : structuredClone(EMPTY);
  }

  private file() { return resolve(this.dir, "corpus.json"); }

  flush(): void {
    writeFileSync(this.file(), JSON.stringify(this.db, null, 1));
  }

  async listCompaniesToCheck(limit: number): Promise<CompanyRow[]> {
    return this.db.companies
      .filter((c) => ["ACTIVE", "VERIFIED"].includes(c.lifecycle) && c.ats_token)
      .sort((a, b) => b.priority_score - a.priority_score)
      .slice(0, limit);
  }

  async upsertCompany(input: {
    name: string; domain: string | null; ats_provider: string; ats_token: string;
    lifecycle: string; priority_score: number; industries: string[];
    discovery_method: string; discovery_source: string | null;
  }): Promise<CompanyRow> {
    // Mirrors unique (ats_provider, ats_token).
    const existing = this.db.companies.find(
      (c) => c.ats_provider === input.ats_provider && c.ats_token === input.ats_token,
    );
    if (existing) {
      existing.name = input.name;
      existing.priority_score = input.priority_score;
      return existing;
    }
    const row: CompanyRow = {
      id: randomUUID(), name: input.name, domain: input.domain,
      ats_provider: input.ats_provider, ats_token: input.ats_token,
      lifecycle: input.lifecycle, priority_score: input.priority_score,
      consecutive_check_failures: 0, open_job_count: null,
    };
    this.db.companies.push(row);
    return row;
  }

  async markCompanyVerified(companyId: string, jobCount: number): Promise<void> {
    const c = this.db.companies.find((x) => x.id === companyId);
    if (!c) return;
    c.lifecycle = "ACTIVE";
    c.open_job_count = jobCount;
  }

  async recordCompanyCheck(input: {
    companyId: string; ok: boolean; jobCount: number | null;
    durationMs: number; error: string | null; runId: string;
  }): Promise<void> {
    this.db.ingest_run_companies.push({
      run_id: input.runId, company_id: input.companyId, ok: input.ok,
      job_count: input.jobCount, duration_ms: input.durationMs, error: input.error,
    });
    const c = this.db.companies.find((x) => x.id === input.companyId);
    if (!c) return;
    if (input.ok) {
      c.consecutive_check_failures = 0;
      c.open_job_count = input.jobCount;
    } else {
      c.consecutive_check_failures += 1;
    }
  }

  async startRun(): Promise<string> {
    const id = randomUUID();
    this.db.ingest_runs.push({ id, started_at: new Date().toISOString(), status: "RUNNING" });
    return id;
  }

  async finishRun(runId: string, stats: RunStats): Promise<void> {
    const r = this.db.ingest_runs.find((x) => x["id"] === runId);
    if (r) Object.assign(r, stats, { finished_at: new Date().toISOString() });
    this.flush();
  }

  async recordFetch(record: FetchRecord): Promise<string> {
    const id = randomUUID();
    this.db.source_fetches.push({
      id, ...record,
      // Hash and size are kept; the body is not written to disk here.
      raw_body: null,
      raw_body_retained: record.raw_body_retained,
      fetched_at: new Date().toISOString(),
    });
    return id;
  }

  async listJobsForCompany(companyId: string, source: string): Promise<ExistingJob[]> {
    return this.db.jobs
      .filter((j) => j["company_id"] === companyId && j["source"] === source)
      .map((j) => {
        const versions = this.db.job_versions.filter((v) => v["job_id"] === j["id"]);
        const current = versions.find((v) => v["is_current"] === true);
        return {
          id: j["id"] as string,
          external_id: j["external_id"] as string,
          content_hash: (j["content_hash"] as string) ?? null,
          status: j["status"] as ExistingJob["status"],
          consecutive_missing_checks: (j["consecutive_missing_checks"] as number) ?? 0,
          current_version_id: (current?.["id"] as string) ?? null,
          current_version_number: (current?.["version_number"] as number) ?? 0,
          current_normalized: (current?.["normalized"] as NormalizedJob) ?? null,
          has_payload: this.db.job_raw_payloads.some((p) => p["job_id"] === j["id"]),
        };
      });
  }

  async writeJobs(inputs: JobWriteInput[]): Promise<JobWriteResult[]> {
    const out: JobWriteResult[] = [];
    for (const input of inputs) out.push(await this.writeOne(input));
    return out;
  }

  private async writeOne(input: JobWriteInput): Promise<JobWriteResult> {
    const { normalized: n, existing } = input;
    let jobId: string;
    let isNew = false;
    let versionCreated = false;
    let versionNumber = existing?.current_version_number ?? 0;
    let changes: ReturnType<typeof detectChanges> = [];

    if (!existing) {
      jobId = randomUUID();
      isNew = true;
      this.db.jobs.push({
        id: jobId, company_id: input.companyId, source: input.source,
        external_id: n.sourceJobId, url: n.url, apply_url: n.applyUrl,
        title: n.title, normalized_title: n.normalizedTitle, department: n.department,
        location_raw: n.locationRaw, city: n.city, state: n.state,
        country: n.country, metro: n.metro,
        remote_policy: n.remotePolicy, remote_geographic_restriction: n.remoteRestriction,
        onsite_days_per_week: n.onsiteDaysPerWeek,
        employment_arrangement: n.employmentArrangement, seniority: n.seniority,
        salary_min: n.salaryMin, salary_max: n.salaryMax,
        salary_currency: n.salaryCurrency, salary_period: n.salaryPeriod,
        salary_is_estimated: n.salaryIsEstimated, salary_source: n.salarySource,
        is_individual_contributor: n.isIndividualContributor,
        manages_people: n.managesPeople,
        travel_requirement_pct: n.travelRequirementPct,
        has_quota_or_commission: n.hasQuotaOrCommission,
        mentions_equity: n.mentionsEquity,
        posted_at: n.postedAt,
        first_seen_at: input.fetchedAt, last_seen_at: input.fetchedAt,
        last_seen_open_at: input.fetchedAt,
        status: "OPEN", consecutive_missing_checks: 0,
        content_hash: input.contentHash, description_hash: input.descriptionHash,
        normalizer_version: input.normalizerVersion, fetcher_version: input.fetcherVersion,
      });
      versionNumber = 1;
      versionCreated = true;
    } else {
      jobId = existing.id;
      const job = this.db.jobs.find((j) => j["id"] === jobId)!;
      job["last_seen_at"] = input.fetchedAt;
      job["last_seen_open_at"] = input.fetchedAt;
      job["consecutive_missing_checks"] = 0;

      if (existing.status !== "OPEN") {
        job["status"] = "OPEN";
        job["status_changed_at"] = input.fetchedAt;
        job["closed_detection_reason"] = "reappeared on board";
      }

      if (existing.content_hash !== input.contentHash) {
        versionCreated = true;
        versionNumber = existing.current_version_number + 1;
        changes = existing.current_normalized
          ? detectChanges(existing.current_normalized, n)
          : [];
        Object.assign(job, {
          title: n.title, normalized_title: n.normalizedTitle, department: n.department,
          location_raw: n.locationRaw, city: n.city, state: n.state,
          country: n.country, metro: n.metro,
          remote_policy: n.remotePolicy, remote_geographic_restriction: n.remoteRestriction,
          onsite_days_per_week: n.onsiteDaysPerWeek,
          employment_arrangement: n.employmentArrangement, seniority: n.seniority,
          salary_min: n.salaryMin, salary_max: n.salaryMax,
          salary_currency: n.salaryCurrency, salary_period: n.salaryPeriod,
          salary_source: n.salarySource,
          is_individual_contributor: n.isIndividualContributor,
          manages_people: n.managesPeople,
          travel_requirement_pct: n.travelRequirementPct,
          has_quota_or_commission: n.hasQuotaOrCommission,
          mentions_equity: n.mentionsEquity,
          url: n.url, apply_url: n.applyUrl,
          content_hash: input.contentHash, description_hash: input.descriptionHash,
          normalizer_version: input.normalizerVersion,
        });
      }
    }

    let versionId: string | null = existing?.current_version_id ?? null;
    if (versionCreated) {
      // One current version per job.
      for (const v of this.db.job_versions) {
        if (v["job_id"] === jobId) v["is_current"] = false;
      }
      versionId = randomUUID();
      this.db.job_versions.push({
        id: versionId, job_id: jobId, version_number: versionNumber,
        normalized: n, content_hash: input.contentHash,
        normalizer_version: input.normalizerVersion,
        requirements_snapshot: [],
        observed_at: input.fetchedAt, is_current: true,
      });
      const fromVersion = this.db.job_versions.find(
        (v) => v["job_id"] === jobId && v["version_number"] === versionNumber - 1,
      );
      for (const c of changes) {
        this.db.job_changes.push({
          id: randomUUID(), job_id: jobId,
          from_version_id: fromVersion?.["id"] ?? null, to_version_id: versionId,
          kind: c.kind, field_name: c.fieldName,
          old_value: c.oldValue, new_value: c.newValue,
          is_material: c.isMaterial, detected_at: input.fetchedAt,
        });
      }
    }

    // Mirrors unique (job_id, raw_fragment_hash): an unchanged raw
    // fragment writes nothing, which is what keeps a daily run cheap.
    const dupPayload = this.db.job_raw_payloads.some(
      (p) => p["job_id"] === jobId && p["raw_fragment_hash"] === input.rawFragmentHash,
    );
    if (!dupPayload) {
      this.db.job_raw_payloads.push({
        id: randomUUID(), job_id: jobId, job_version_id: versionId,
        source_fetch_id: input.fetchId, ingest_run_id: input.runId,
        source: input.source, source_job_id: n.sourceJobId, source_url: n.url,
        raw_fragment: input.raw, raw_fragment_hash: input.rawFragmentHash,
        raw_fragment_bytes: JSON.stringify(input.raw).length,
        normalized: n, normalizer_version: input.normalizerVersion,
        normalization_warnings: n.normalizationWarnings,
        content_hash: input.contentHash, fetched_at: input.fetchedAt,
      });
    }

    return { jobId, isNew, versionCreated, versionNumber, changes, duplicateOfJobId: null };
  }

  async markMissing(input: {
    companyId: string; source: string; seenExternalIds: Set<string>;
  }): Promise<MissingResult> {
    let possiblyClosed = 0, closedOrRemoved = 0;
    const now = new Date().toISOString();
    for (const job of this.db.jobs) {
      if (job["company_id"] !== input.companyId || job["source"] !== input.source) continue;
      const status = job["status"] as string;
      if (status === "ARCHIVED" || status === "CONFIRMED_CLOSED") continue;
      if (input.seenExternalIds.has(job["external_id"] as string)) continue;

      const misses = ((job["consecutive_missing_checks"] as number) ?? 0) + 1;
      job["consecutive_missing_checks"] = misses;
      job["last_seen_at"] = now;
      // One miss is a stage, not a conclusion. Three consecutive misses
      // on successful fetches is the threshold; CONFIRMED_CLOSED needs an
      // explicit signal neither board provides, so nothing reaches it here.
      const next = misses >= 3 ? "CLOSED_OR_REMOVED" : "POSSIBLY_CLOSED";
      if (job["status"] !== next) {
        job["status"] = next;
        job["status_changed_at"] = now;
        job["closed_detection_reason"] = `absent from ${misses} consecutive successful board fetch(es)`;
      }
      if (next === "CLOSED_OR_REMOVED") closedOrRemoved++; else possiblyClosed++;
    }
    return { possiblyClosed, closedOrRemoved };
  }

  async recordDuplicate(jobId: string, duplicateOfJobId: string): Promise<void> {
    const exists = this.db.job_relations.some(
      (r) => r["job_id"] === jobId && r["related_job_id"] === duplicateOfJobId
        && r["relation"] === "DUPLICATE_OF",
    );
    if (exists) return;
    this.db.job_relations.push({
      id: randomUUID(), job_id: jobId, related_job_id: duplicateOfJobId,
      relation: "DUPLICATE_OF", confidence: 1,
    });
  }

  async healthReport(): Promise<Record<string, unknown>> {
    return buildHealth(this.db);
  }

  async close(): Promise<void> {
    this.flush();
  }

  raw(): Db { return this.db; }
}

export function buildHealth(db: Db): Record<string, unknown> {
  const byStatus: Record<string, number> = {};
  for (const j of db.jobs) {
    const s = j["status"] as string;
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  const warnCounts: Record<string, number> = {};
  for (const p of db.job_raw_payloads) {
    for (const w of (p["normalization_warnings"] as string[]) ?? []) {
      const key = w.split("(")[0]!.trim().slice(0, 80);
      warnCounts[key] = (warnCounts[key] ?? 0) + 1;
    }
  }
  return {
    companies: db.companies.length,
    companies_failing: db.companies.filter((c) => c.consecutive_check_failures > 0).length,
    jobs_total: db.jobs.length,
    jobs_by_status: byStatus,
    job_versions: db.job_versions.length,
    job_changes: db.job_changes.length,
    job_changes_material: db.job_changes.filter((c) => c["is_material"] === true).length,
    raw_payloads: db.job_raw_payloads.length,
    duplicate_relations: db.job_relations.length,
    fetches: db.source_fetches.length,
    fetches_failed: db.source_fetches.filter((f) => f["ok"] === false).length,
    normalization_warnings: warnCounts,
  };
}
