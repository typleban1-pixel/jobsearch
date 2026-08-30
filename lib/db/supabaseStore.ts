import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { required } from "../env.ts";
import { detectChanges } from "../ingest/diff.ts";
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

    const versions: Array<Record<string, unknown>> = [];
    const ids = jobs.map((j) => j["id"] as string);
    for (let i = 0; i < ids.length; i += 500) {
      const batch = await this.run("listJobsForCompany.versions",
        this.db.from("job_versions")
          .select("id,job_id,version_number,normalized_cache:description_text,content_hash")
          .in("job_id", ids.slice(i, i + 500))
          .eq("is_current", true));
      versions.push(...((batch ?? []) as Array<Record<string, unknown>>));
    }
    const byJob = new Map(versions.map((v) => [v["job_id"] as string, v]));

    return jobs.map((j) => {
      const v = byJob.get(j["id"] as string);
      return {
        id: j["id"] as string,
        external_id: j["external_id"] as string,
        content_hash: (j["content_hash"] as string) ?? null,
        status: j["status"] as ExistingJob["status"],
        consecutive_missing_checks: (j["consecutive_missing_checks"] as number) ?? 0,
        current_version_id: (v?.["id"] as string) ?? null,
        current_version_number: (v?.["version_number"] as number) ?? 0,
        // The previous normalized object is not loaded here. Change
        // detection keys on content_hash, and the field-level diff is
        // rebuilt from the frozen version row only when a hash moved.
        current_normalized: null,
      };
    });
  }

  async writeJobs(inputs: JobWriteInput[]): Promise<JobWriteResult[]> {
    const results: JobWriteResult[] = [];
    const newOnes = inputs.filter((i) => !i.existing);
    const changed = inputs.filter((i) => i.existing && i.existing.content_hash !== i.contentHash);
    const unchanged = inputs.filter((i) => i.existing && i.existing.content_hash === i.contentHash);

    // Unchanged: touch the heartbeat only. No version, no payload row, no
    // description rewrite. This is the path most jobs take every day and
    // it is what keeps a daily run cheap.
    if (unchanged.length) {
      for (let i = 0; i < unchanged.length; i += 500) {
        const slice = unchanged.slice(i, i + 500);
        await this.run("writeJobs.touch",
          this.db.from("jobs").upsert(slice.map((u) => ({
            id: u.existing!.id,
            last_seen_at: u.fetchedAt,
            last_seen_open_at: u.fetchedAt,
            consecutive_missing_checks: 0,
            ...(u.existing!.status !== "OPEN"
              ? { status: "OPEN", status_changed_at: u.fetchedAt,
                  closed_detection_reason: "reappeared on board" }
              : {}),
          })), { onConflict: "id" }));
      }
      for (const u of unchanged) {
        results.push({
          jobId: u.existing!.id, isNew: false, versionCreated: false,
          versionNumber: u.existing!.current_version_number, changes: [],
          duplicateOfJobId: null,
        });
      }
    }

    for (const input of [...newOnes, ...changed]) {
      results.push(await this.writeOne(input));
    }
    return results;
  }

  private async writeOne(input: JobWriteInput): Promise<JobWriteResult> {
    const n = input.normalized;
    const row = jobRow(input);
    let jobId: string;
    let isNew = false;

    if (!input.existing) {
      const data = await this.run("writeOne.insertJob",
        this.db.from("jobs").insert({
          ...row,
          company_id: input.companyId, source: input.source, external_id: n.sourceJobId,
          first_seen_at: input.fetchedAt, status: "OPEN", consecutive_missing_checks: 0,
        }).select("id").single());
      jobId = (data as { id: string }).id;
      isNew = true;
    } else {
      jobId = input.existing.id;
      await this.run("writeOne.updateJob",
        this.db.from("jobs").update({
          ...row,
          ...(input.existing.status !== "OPEN"
            ? { status: "OPEN", status_changed_at: input.fetchedAt,
                closed_detection_reason: "reappeared on board" }
            : {}),
        }).eq("id", jobId));
    }

    await this.run("writeOne.description",
      this.db.from("job_descriptions").upsert({
        job_id: jobId, description_text: n.descriptionText,
        fetched_at: input.fetchedAt, content_hash: input.descriptionHash,
      }, { onConflict: "job_id" }));

    // Read the previous frozen version before superseding it: the field
    // diff has to compare against what was actually stored, not against
    // whatever the last run happened to hold in memory.
    let prev: NormalizedJob | null = null;
    if (input.existing?.current_version_id) {
      const v = await this.run("writeOne.prevVersion",
        this.db.from("job_versions").select("*").eq("id", input.existing.current_version_id).single());
      prev = versionToNormalized(v as Record<string, unknown>);
      await this.run("writeOne.supersede",
        this.db.from("job_versions").update({ is_current: false })
          .eq("id", input.existing.current_version_id));
    }

    const versionNumber = (input.existing?.current_version_number ?? 0) + 1;
    const versionData = await this.run("writeOne.insertVersion",
      this.db.from("job_versions").insert({
        job_id: jobId, version_number: versionNumber,
        title: n.title, department: n.department,
        location_raw: n.locationRaw, city: n.city, state: n.state,
        country: n.country, metro: n.metro,
        remote_policy: n.remotePolicy, remote_geographic_restriction: n.remoteRestriction,
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
        content_hash: input.contentHash,
        normalizer_version: input.normalizerVersion,
        observed_at: input.fetchedAt, is_current: true,
      }).select("id").single());
    const versionId = (versionData as { id: string }).id;

    const changes = prev ? detectChanges(prev, n) : [];
    if (changes.length) {
      await this.run("writeOne.changes",
        this.db.from("job_changes").insert(changes.map((c) => ({
          job_id: jobId, from_version_id: input.existing!.current_version_id,
          to_version_id: versionId, kind: c.kind, field_name: c.fieldName,
          old_value: c.oldValue, new_value: c.newValue, is_material: c.isMaterial,
          detected_at: input.fetchedAt,
        }))));
    }

    // unique (job_id, raw_fragment_hash) makes this idempotent: an
    // unchanged raw fragment inserts nothing.
    await this.run("writeOne.payload",
      this.db.from("job_raw_payloads").upsert({
        job_id: jobId, job_version_id: versionId, source_fetch_id: input.fetchId,
        ingest_run_id: input.runId, source: input.source,
        source_job_id: n.sourceJobId, source_url: n.url,
        raw_fragment: input.raw, raw_fragment_hash: input.rawFragmentHash,
        raw_fragment_bytes: JSON.stringify(input.raw).length,
        normalized: n, normalizer_version: input.normalizerVersion,
        normalization_warnings: n.normalizationWarnings,
        content_hash: input.contentHash, fetched_at: input.fetchedAt,
      }, { onConflict: "job_id,raw_fragment_hash", ignoreDuplicates: true }));

    return { jobId, isNew, versionCreated: true, versionNumber, changes, duplicateOfJobId: null };
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

    for (let i = 0; i < missing.length; i += 500) {
      const slice = missing.slice(i, i + 500);
      await this.run("markMissing",
        this.db.from("jobs").upsert(slice.map((j) => {
          const misses = j.consecutive_missing_checks + 1;
          const next = misses >= 3 ? "CLOSED_OR_REMOVED" : "POSSIBLY_CLOSED";
          if (next === "CLOSED_OR_REMOVED") closedOrRemoved++; else possiblyClosed++;
          return {
            id: j.id, consecutive_missing_checks: misses, last_seen_at: now,
            status: next, status_changed_at: now,
            closed_detection_reason: `absent from ${misses} consecutive successful board fetch(es)`,
          };
        }), { onConflict: "id" }));
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

function jobRow(input: JobWriteInput): Record<string, unknown> {
  const n = input.normalized;
  return {
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
    sourceJobId: "", url: null, applyUrl: null,
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
