import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { required } from "../env.ts";
import { detectChanges } from "../ingest/diff.ts";
import { touchBatches } from "./touchRows.ts";
import type {
  CompanyRow, ExistingJob, FetchRecord, JobWriteInput, JobWriteResult,
  MissingResult, RunStats, Store,
} from "./store.ts";
import type { NormalizedJob } from "../ingest/providers/types.ts";

/**
 * The real store.
 *
 * Uses the service role key, so it bypasses RLS by design and is bound
 * instead by the append-only triggers in migration 0007. This client must
 * never be constructed in browser code: the key it reads can write
 * anything.
 */
export class SupabaseStore implements Store {
  readonly kind = "supabase" as const;
  private db: SupabaseClient;

  constructor() {
    this.db = createClient(
      required("SUPABASE_URL"),
      required("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }

  private async run<T>(label: string, p: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
    const { data, error } = await p;
    if (error) {
      const e = error as { message?: string; details?: string; hint?: string; code?: string };
      throw new Error(
        `${label} failed: ${e.message ?? String(error)}` +
          (e.details ? ` | ${e.details}` : "") +
          (e.hint ? ` | hint: ${e.hint}` : "") +
          (e.code ? ` | code: ${e.code}` : ""),
      );
    }
    return data;
  }

  async countActiveBoards(): Promise<number> {
    const { count } = await this.db.from("companies")
      .select("id", { count: "exact", head: true })
      .in("lifecycle", ["ACTIVE", "VERIFIED"]).not("ats_token", "is", null);
    return count ?? 0;
  }

  async listCompaniesToCheck(limit: number): Promise<CompanyRow[]> {
    // Mirrors companies_check_order_idx: lifecycle, then priority, then
    // least-recently-checked first.
    const data = await this.run("listCompaniesToCheck",
      this.db.from("companies")
        .select("id,name,domain,ats_provider,ats_token,lifecycle,priority_score,consecutive_check_failures,open_job_count")
        .in("lifecycle", ["ACTIVE", "VERIFIED"])
        .not("ats_token", "is", null)
        .order("priority_score", { ascending: false })
        .order("last_checked_at", { ascending: true, nullsFirst: true })
        .limit(limit));
    return (data ?? []) as CompanyRow[];
  }

  async upsertCompany(input: {
    name: string; domain: string | null; ats_provider: string; ats_token: string;
    lifecycle: string; priority_score: number; industries: string[];
    discovery_method: string; discovery_source: string | null;
  }): Promise<CompanyRow> {
    const data = await this.run("upsertCompany",
      this.db.from("companies")
        .upsert({ ...input }, { onConflict: "ats_provider,ats_token" })
        .select("id,name,domain,ats_provider,ats_token,lifecycle,priority_score,consecutive_check_failures,open_job_count")
        .single());
    return data as CompanyRow;
  }

  async markCompanyVerified(companyId: string, jobCount: number): Promise<void> {
    // active_companies_are_verified requires ats_token AND verified_at,
    // so both move together or the constraint rejects the row.
    await this.run("markCompanyVerified",
      this.db.from("companies").update({
        lifecycle: "ACTIVE",
        verified_at: new Date().toISOString(),
        verification_confidence: "HIGH",
        open_job_count: jobCount,
        open_job_count_at: new Date().toISOString(),
      }).eq("id", companyId));
  }

  async recordCompanyCheck(input: {
    companyId: string; ok: boolean; jobCount: number | null;
    durationMs: number; error: string | null; runId: string;
  }): Promise<void> {
    await this.run("recordCompanyCheck.runCompany",
      this.db.from("ingest_run_companies").upsert({
        run_id: input.runId, company_id: input.companyId, ok: input.ok,
        job_count: input.jobCount, duration_ms: input.durationMs, error: input.error,
      }, { onConflict: "run_id,company_id" }));

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { last_checked_at: now };
    if (input.ok) {
      patch["last_successful_check_at"] = now;
      patch["consecutive_check_failures"] = 0;
      patch["open_job_count"] = input.jobCount;
      patch["open_job_count_at"] = now;
    } else {
      patch["last_failed_check_at"] = now;
      const cur = await this.run("recordCompanyCheck.read",
        this.db.from("companies").select("consecutive_check_failures").eq("id", input.companyId).single());
      patch["consecutive_check_failures"] =
        (((cur as { consecutive_check_failures?: number } | null)?.consecutive_check_failures) ?? 0) + 1;
    }
    await this.run("recordCompanyCheck.company",
      this.db.from("companies").update(patch).eq("id", input.companyId));
  }

  async startRun(): Promise<string> {
    const data = await this.run("startRun",
      this.db.from("ingest_runs").insert({ status: "RUNNING" }).select("id").single());
    return (data as { id: string }).id;
  }

  async finishRun(runId: string, stats: RunStats): Promise<void> {
    await this.run("finishRun",
      this.db.from("ingest_runs")
        .update({ ...stats, finished_at: new Date().toISOString() })
        .eq("id", runId));
  }

  async recordFetch(record: FetchRecord): Promise<string> {
    const data = await this.run("recordFetch",
      this.db.from("source_fetches").insert(record).select("id").single());
    return (data as { id: string }).id;
  }

  async listJobsForCompany(companyId: string, source: string): Promise<ExistingJob[]> {
    // PostgREST caps an unranged select at 1000 rows, and a board with
    // more jobs than that would silently look like every job past the cap
    // had vanished, closing them all. Paged explicitly.
    const jobs: Array<Record<string, unknown>> = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const batch = await this.run("listJobsForCompany",
        this.db.from("jobs")
          .select("id,external_id,content_hash,status,consecutive_missing_checks")
          .eq("company_id", companyId).eq("source", source)
          .order("id", { ascending: true })
          .range(from, from + page - 1));
      const rows = (batch ?? []) as Array<Record<string, unknown>>;
      jobs.push(...rows);
      if (rows.length < page) break;
    }
    if (jobs.length === 0) return [];

    // Filtered through a join on the parent rather than by passing job
    // ids in an .in() list.
    //
    // The .in() version failed in production: 500 uuids build a 19,630
    // character URL and PostgREST rejects anything past the ~16 KB
    // header limit. Chunking the list would have worked, but it leaves
    // the bug latent, waiting for whatever chunk size eventually gets
    // raised. Filtering on jobs.company_id makes the URL a fixed size no
    // matter how many jobs a company has.
    const versions: Array<Record<string, unknown>> = [];
    for (let from = 0; ; from += page) {
      const batch = await this.run("listJobsForCompany.versions",
        this.db.from("job_versions")
          .select("id,job_id,version_number,jobs!inner(company_id)")
          .eq("jobs.company_id", companyId)
          .eq("is_current", true)
          .order("job_id", { ascending: true })
          .range(from, from + page - 1));
      const rows = (batch ?? []) as Array<Record<string, unknown>>;
      versions.push(...rows);
      if (rows.length < page) break;
    }
    const byJob = new Map(versions.map((v) => [v["job_id"] as string, v]));

    // Same join trick, same reason: fixed-size URL regardless of how many
    // jobs the company has.
    const withPayload = new Set<string>();
    for (let from = 0; ; from += page) {
      const batch = await this.run("listJobsForCompany.payloads",
        this.db.from("job_raw_payloads")
          .select("job_id,jobs!inner(company_id)")
          .eq("jobs.company_id", companyId)
          .order("job_id", { ascending: true })
          .range(from, from + page - 1));
      const rows = (batch ?? []) as Array<{ job_id: string }>;
      for (const r of rows) withPayload.add(r.job_id);
      if (rows.length < page) break;
    }

    return jobs.map((j) => {
      const v = byJob.get(j["id"] as string);
      return {
        id: j["id"] as string,
        external_id: j["external_id"] as string,
        // A job with no current version is reported as having no content
        // hash, so it routes to the changed path and gets one.
        //
        // The four writes behind a job (job, description, version,
        // payload) are separate PostgREST calls with no transaction
        // spanning them. If a run dies between them the job row exists
        // with a content_hash but no version, and matching on that hash
        // would send it down the unchanged path forever, leaving it
        // permanently versionless. This makes the next run repair it.
        content_hash: v ? ((j["content_hash"] as string) ?? null) : null,
        status: j["status"] as ExistingJob["status"],
        consecutive_missing_checks: (j["consecutive_missing_checks"] as number) ?? 0,
        current_version_id: (v?.["id"] as string) ?? null,
        current_version_number: (v?.["version_number"] as number) ?? 0,
        // Deliberately not loading description_text here. This runs for
        // every job on every company, and pulling the full frozen text
        // just to learn a version id was megabytes per company. The diff
        // reads the previous version only for jobs whose hash moved.
        current_normalized: null,
        has_payload: withPayload.has(j["id"] as string),
      };
    });
  }

  /**
   * Batched.
   *
   * The first cold load against Supabase ran at 5.8 jobs/sec because
   * every new or changed job made about five sequential round trips.
   * 3,841 jobs is roughly 19,000 requests in series, which is eleven
   * minutes of pure latency for work the database can do in a few dozen
   * statements. The file-backed store hid this completely: it is
   * in-memory, so per-row writes cost nothing there.
   *
   * Three paths, each batched separately because they need different
   * statements:
   *
   *   unchanged  heartbeat only. No version, no payload, no description
   *              rewrite. Most jobs take this path every day.
   *   new        insert job, description, version 1, raw payload.
   *   changed    supersede the current version, then the same as new
   *              plus a diff against the frozen previous version.
   */
  async writeJobs(inputs: JobWriteInput[]): Promise<JobWriteResult[]> {
    const unchanged = inputs.filter((i) => i.existing && i.existing.content_hash === i.contentHash);
    const newOnes = inputs.filter((i) => !i.existing);
    const changed = inputs.filter((i) => i.existing && i.existing.content_hash !== i.contentHash);

    const results: JobWriteResult[] = [];
    results.push(...(await this.touchUnchanged(unchanged)));
    results.push(...(await this.insertNewJobs(newOnes)));
    results.push(...(await this.updateChangedJobs(changed)));
    return results;
  }

  private async touchUnchanged(inputs: JobWriteInput[]): Promise<JobWriteResult[]> {
    // Repair pass: unchanged content, but the source-provenance row never
    // landed. Writes the payload against the version that already exists,
    // without manufacturing a new version for a job that did not change.
    const needsPayload = inputs.filter((i) => !i.existing!.has_payload);
    if (needsPayload.length) {
      const versionIds = new Map<string, string>();
      for (const i of needsPayload) {
        if (i.existing!.current_version_id) versionIds.set(i.existing!.id, i.existing!.current_version_id);
      }
      await this.writePayloads(
        needsPayload.map((i) => ({ input: i, jobId: i.existing!.id })),
        versionIds,
      );
    }

    // One shape per statement. PostgREST sends a batch as a single
    // INSERT ... ON CONFLICT whose column list is the UNION of the keys
    // across its rows, so a reappeared job sharing a batch with ordinary
    // touches put `status` into the statement and sent NULL for every
    // row that omitted it. See lib/db/touchRows.ts.
    for (const batch of touchBatches(inputs, 500)) {
      await this.run(`touchUnchanged.${batch.shape.toLowerCase()}`,
        this.db.from("jobs").upsert(batch.rows, { onConflict: "id" }));
    }
    return inputs.map((u) => ({
      jobId: u.existing!.id, isNew: false, versionCreated: false,
      versionNumber: u.existing!.current_version_number, changes: [],
      duplicateOfJobId: null,
    }));
  }

  private async insertNewJobs(inputs: JobWriteInput[]): Promise<JobWriteResult[]> {
    const results: JobWriteResult[] = [];

    for (const slice of chunk(inputs, 400)) {
      const inserted = await this.run("insertNewJobs.jobs",
        this.db.from("jobs").insert(slice.map((i) => ({
          ...jobRow(i),
          company_id: i.companyId, source: i.source, external_id: i.normalized.sourceJobId,
          first_seen_at: i.fetchedAt, status: "OPEN", consecutive_missing_checks: 0,
        }))).select("id,source,external_id"));

      // Mapped by natural key rather than by array position: PostgREST
      // makes no promise that returned rows come back in input order.
      const idByKey = new Map(
        (inserted as Array<{ id: string; source: string; external_id: string }>)
          .map((r) => [`${r.source}::${r.external_id}`, r.id]),
      );
      const withIds = slice.map((i) => {
        const jobId = idByKey.get(`${i.source}::${i.normalized.sourceJobId}`);
        if (!jobId) throw new Error(`insertNewJobs: no id returned for ${i.source}/${i.normalized.sourceJobId}`);
        return { input: i, jobId };
      });

      await this.writeDescriptions(withIds);
      const versionIds = await this.writeVersions(withIds.map((w) => ({ ...w, versionNumber: 1 })));
      await this.writePayloads(withIds, versionIds);

      for (const w of withIds) {
        results.push({
          jobId: w.jobId, isNew: true, versionCreated: true, versionNumber: 1,
          changes: [], duplicateOfJobId: null,
        });
      }
    }
    return results;
  }

  private async updateChangedJobs(inputs: JobWriteInput[]): Promise<JobWriteResult[]> {
    const results: JobWriteResult[] = [];

    // 100, not 200: this path passes version ids through .in(), and the
    // URL grows with the chunk. 100 uuids is roughly 3.7 KB, comfortably
    // under the header limit that broke listJobsForCompany.
    for (const slice of chunk(inputs, 100)) {
      const withIds = slice.map((i) => ({ input: i, jobId: i.existing!.id }));

      // The frozen previous version, read before it is superseded. The
      // diff has to compare against what was actually stored, not against
      // whatever this process happens to hold in memory.
      const prevIds = slice.map((i) => i.existing!.current_version_id).filter((x): x is string => Boolean(x));
      const prevRows = prevIds.length
        ? await this.run("updateChangedJobs.prevVersions",
            this.db.from("job_versions").select("*").in("id", prevIds))
        : [];
      const prevByJob = new Map(
        (prevRows as Array<Record<string, unknown>>).map((v) => [v["job_id"] as string, v]),
      );

      // Supersede first. job_versions_one_current is a unique index, so
      // inserting the new current version before clearing the old one
      // would be rejected. Only is_current moves, which is the single
      // column the append-only trigger permits.
      if (prevIds.length) {
        await this.run("updateChangedJobs.supersede",
          this.db.from("job_versions").update({ is_current: false }).in("id", prevIds));
      }

      await this.run("updateChangedJobs.jobs",
        this.db.from("jobs").upsert(slice.map((i) => ({
          id: i.existing!.id,
          company_id: i.companyId, source: i.source, external_id: i.normalized.sourceJobId,
          ...jobRow(i),
          ...(i.existing!.status !== "OPEN"
            ? { status: "OPEN", status_changed_at: i.fetchedAt,
                closed_detection_reason: "reappeared on board" }
            : {}),
        })), { onConflict: "id" }));

      await this.writeDescriptions(withIds);
      const versionIds = await this.writeVersions(
        withIds.map((w) => ({ ...w, versionNumber: w.input.existing!.current_version_number + 1 })),
      );
      await this.writePayloads(withIds, versionIds);

      const changeRows: Array<Record<string, unknown>> = [];
      for (const w of withIds) {
        const prev = prevByJob.get(w.jobId);
        const changes = prev ? detectChanges(versionToNormalized(prev), w.input.normalized) : [];
        const toVersionId = versionIds.get(w.jobId);
        for (const c of changes) {
          changeRows.push({
            job_id: w.jobId,
            from_version_id: w.input.existing!.current_version_id,
            to_version_id: toVersionId,
            kind: c.kind, field_name: c.fieldName,
            old_value: c.oldValue, new_value: c.newValue,
            is_material: c.isMaterial, detected_at: w.input.fetchedAt,
          });
        }
        results.push({
          jobId: w.jobId, isNew: false, versionCreated: true,
          versionNumber: w.input.existing!.current_version_number + 1,
          changes, duplicateOfJobId: null,
        });
      }
      for (const c of chunk(changeRows, 500)) {
        await this.run("updateChangedJobs.changes", this.db.from("job_changes").insert(c));
      }
    }
    return results;
  }

  private async writeDescriptions(rows: Array<{ input: JobWriteInput; jobId: string }>): Promise<void> {
    for (const slice of chunk(rows, 200)) {
      await this.run("writeDescriptions",
        this.db.from("job_descriptions").upsert(slice.map((w) => ({
          job_id: w.jobId,
          description_text: w.input.normalized.descriptionText,
          fetched_at: w.input.fetchedAt,
          content_hash: w.input.descriptionHash,
        })), { onConflict: "job_id" }));
    }
  }

  private async writeVersions(
    rows: Array<{ input: JobWriteInput; jobId: string; versionNumber: number }>,
  ): Promise<Map<string, string>> {
    const byJob = new Map<string, string>();
    for (const slice of chunk(rows, 200)) {
      const inserted = await this.run("writeVersions",
        this.db.from("job_versions").insert(slice.map((w) => {
          const n = w.input.normalized;
          return {
            job_id: w.jobId, version_number: w.versionNumber,
            title: n.title, department: n.department,
            location_raw: n.locationRaw, city: n.city, state: n.state,
            country: n.country, metro: n.metro,
            remote_policy: n.remotePolicy,
            remote_geographic_restriction: n.remoteRestriction,
            onsite_days_per_week: n.onsiteDaysPerWeek,
            employment_arrangement: n.employmentArrangement, seniority: n.seniority,
            salary_min: n.salaryMin, salary_max: n.salaryMax,
            salary_currency: n.salaryCurrency, salary_period: n.salaryPeriod,
            salary_is_estimated: n.salaryIsEstimated,
            is_individual_contributor: n.isIndividualContributor,
            manages_people: n.managesPeople,
            travel_requirement_pct: n.travelRequirementPct,
            has_quota_or_commission: n.hasQuotaOrCommission,
            mentions_equity: n.mentionsEquity,
            description_text: n.descriptionText,
            requirements_snapshot: [],
            content_hash: w.input.contentHash,
            normalizer_version: w.input.normalizerVersion,
            observed_at: w.input.fetchedAt, is_current: true,
          };
        })).select("id,job_id"));
      for (const r of inserted as Array<{ id: string; job_id: string }>) {
        byJob.set(r.job_id, r.id);
      }
    }
    return byJob;
  }

  private async writePayloads(
    rows: Array<{ input: JobWriteInput; jobId: string }>,
    versionIds: Map<string, string>,
  ): Promise<void> {
    // Smaller chunks: a raw fragment averages ~11 KB and the normalized
    // object rides alongside it, so 100 rows is already a few megabytes.
    for (const slice of chunk(rows, 100)) {
      await this.run("writePayloads",
        this.db.from("job_raw_payloads").upsert(slice.map((w) => {
          const n = w.input.normalized;
          return {
            job_id: w.jobId,
            job_version_id: versionIds.get(w.jobId) ?? null,
            source_fetch_id: w.input.fetchId, ingest_run_id: w.input.runId,
            source: w.input.source, source_job_id: n.sourceJobId, source_url: n.url,
            raw_fragment: w.input.raw, raw_fragment_hash: w.input.rawFragmentHash,
            raw_fragment_bytes: JSON.stringify(w.input.raw).length,
            normalized: n, normalizer_version: w.input.normalizerVersion,
            normalization_warnings: n.normalizationWarnings,
            content_hash: w.input.contentHash, fetched_at: w.input.fetchedAt,
          };
        }), { onConflict: "job_id,raw_fragment_hash", ignoreDuplicates: true }));
    }
  }

  async readBoardCursor(provider: string, token: string) {
    const { data } = await this.db.from("board_ingest_state")
      .select("next_offset,backfill_complete,postings_seen")
      .eq("provider", provider).eq("token", token).maybeSingle();
    if (!data) return null;
    return {
      nextOffset: data.next_offset ?? 0,
      backfillComplete: Boolean(data.backfill_complete),
      postingsSeen: data.postings_seen ?? 0,
    };
  }

  async writeBoardCursor(input: {
    provider: string; token: string; nextOffset: number;
    backfillComplete: boolean; postingsSeen: number; error: string | null;
  }): Promise<void> {
    await this.run("writeBoardCursor", this.db.from("board_ingest_state").upsert({
      provider: input.provider, token: input.token,
      next_offset: input.nextOffset,
      backfill_complete: input.backfillComplete,
      backfill_completed_at: input.backfillComplete ? new Date().toISOString() : null,
      postings_seen: input.postingsSeen,
      last_run_at: new Date().toISOString(),
      last_error: input.error,
    }, { onConflict: "provider,token" }));
  }

  async markMissing(input: {
    companyId: string; source: string; seenExternalIds: Set<string>;
  }): Promise<MissingResult> {
    const all = await this.listJobsForCompany(input.companyId, input.source);
    const missing = all.filter(
      (j) => !input.seenExternalIds.has(j.external_id) &&
             j.status !== "ARCHIVED" && j.status !== "CONFIRMED_CLOSED",
    );
    let possiblyClosed = 0, closedOrRemoved = 0;
    const now = new Date().toISOString();

    // UPDATE, not upsert.
    //
    // Every row here came from listJobsForCompany, so it exists and only
    // ever needed updating. Upsert made this an INSERT ... ON CONFLICT,
    // and a BEFORE INSERT trigger on jobs assigns an opening from
    // NEW.company_id: the partial payload carried none, so the trigger
    // tried to write an openings row with a null company_id and the whole
    // ingest aborted. Adding company_id to the payload would have fixed
    // the error and left the trigger creating an orphan opening on an
    // insert arm that never commits, so the fix is to stop pretending
    // these might be new rows.
    for (const j of missing) {
      const misses = j.consecutive_missing_checks + 1;
      const next = misses >= 3 ? "CLOSED_OR_REMOVED" : "POSSIBLY_CLOSED";
      if (next === "CLOSED_OR_REMOVED") closedOrRemoved++; else possiblyClosed++;
      await this.run("markMissing",
        this.db.from("jobs").update({
          consecutive_missing_checks: misses, last_seen_at: now,
          status: next, status_changed_at: now,
          closed_detection_reason: `absent from ${misses} consecutive successful board fetch(es)`,
        }).eq("id", j.id));
    }
    return { possiblyClosed, closedOrRemoved };
  }

  async recordDuplicate(jobId: string, duplicateOfJobId: string): Promise<void> {
    await this.run("recordDuplicate",
      this.db.from("job_relations").upsert({
        job_id: jobId, related_job_id: duplicateOfJobId,
        relation: "DUPLICATE_OF", confidence: 1,
      }, { onConflict: "job_id,related_job_id,relation", ignoreDuplicates: true }));
  }

  async close(): Promise<void> {
    // Nothing to flush: every statement above has already committed.
  }

  async healthReport(): Promise<Record<string, unknown>> {
    const count = async (table: string, apply?: (q: any) => any) => {
      let q = this.db.from(table).select("*", { count: "exact", head: true });
      if (apply) q = apply(q);
      const { count: c, error } = await q;
      if (error) throw new Error(`health ${table}: ${error.message}`);
      return c ?? 0;
    };
    return {
      companies: await count("companies"),
      companies_active: await count("companies", (q) => q.eq("lifecycle", "ACTIVE")),
      companies_failing: await count("companies", (q) => q.gt("consecutive_check_failures", 0)),
      jobs_total: await count("jobs"),
      jobs_open: await count("jobs", (q) => q.eq("status", "OPEN")),
      jobs_possibly_closed: await count("jobs", (q) => q.eq("status", "POSSIBLY_CLOSED")),
      jobs_closed_or_removed: await count("jobs", (q) => q.eq("status", "CLOSED_OR_REMOVED")),
      job_versions: await count("job_versions"),
      job_changes: await count("job_changes"),
      job_changes_material: await count("job_changes", (q) => q.eq("is_material", true)),
      raw_payloads: await count("job_raw_payloads"),
      fetches: await count("source_fetches"),
      fetches_failed: await count("source_fetches", (q) => q.eq("ok", false)),
      duplicate_relations: await count("job_relations", (q) => q.eq("relation", "DUPLICATE_OF")),
    };
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function jobRow(input: JobWriteInput): Record<string, unknown> {
  const n = input.normalized;
  return {
    provider_opening_key: n.providerOpeningKey,
    url: n.url, apply_url: n.applyUrl,
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
    last_seen_at: input.fetchedAt, last_seen_open_at: input.fetchedAt,
    consecutive_missing_checks: 0,
    content_hash: input.contentHash, description_hash: input.descriptionHash,
    normalizer_version: input.normalizerVersion, fetcher_version: input.fetcherVersion,
    updated_at: new Date().toISOString(),
  };
}

/** Rebuilds the comparison object from a frozen version row. */
function versionToNormalized(v: Record<string, unknown>): NormalizedJob {
  return {
    // Comparison shape only. Opening identity is not a version field and
    // never participates in change detection.
    sourceJobId: "", providerOpeningKey: null, url: null, applyUrl: null,
    title: (v["title"] as string) ?? "",
    normalizedTitle: (v["title"] as string) ?? "",
    department: (v["department"] as string) ?? null,
    locationRaw: (v["location_raw"] as string) ?? null,
    city: (v["city"] as string) ?? null,
    state: (v["state"] as string) ?? null,
    country: (v["country"] as string) ?? null,
    metro: (v["metro"] as string) ?? null,
    remotePolicy: (v["remote_policy"] as NormalizedJob["remotePolicy"]) ?? "UNCLEAR",
    remoteRestriction: (v["remote_geographic_restriction"] as string) ?? null,
    onsiteDaysPerWeek: (v["onsite_days_per_week"] as number) ?? null,
    employmentArrangement: (v["employment_arrangement"] as NormalizedJob["employmentArrangement"]) ?? "UNKNOWN",
    seniority: (v["seniority"] as NormalizedJob["seniority"]) ?? "UNKNOWN",
    salaryMin: (v["salary_min"] as number) ?? null,
    salaryMax: (v["salary_max"] as number) ?? null,
    salaryCurrency: (v["salary_currency"] as string) ?? null,
    salaryPeriod: (v["salary_period"] as string) ?? null,
    salaryIsEstimated: Boolean(v["salary_is_estimated"]),
    salarySource: null,
    isIndividualContributor: (v["is_individual_contributor"] as boolean) ?? null,
    managesPeople: (v["manages_people"] as boolean) ?? null,
    travelRequirementPct: (v["travel_requirement_pct"] as number) ?? null,
    hasQuotaOrCommission: (v["has_quota_or_commission"] as boolean) ?? null,
    mentionsEquity: (v["mentions_equity"] as boolean) ?? null,
    postedAt: null,
    descriptionText: (v["description_text"] as string) ?? "",
    normalizationWarnings: [],
  };
}
