import { getProvider } from "./providers/index.ts";
import { contentHash, descriptionHash } from "./diff.ts";
import { hashObject } from "./hash.ts";
import type { Store, CompanyRow, JobWriteInput } from "../db/store.ts";
import type { NormalizedJob } from "./providers/types.ts";

export interface CompanyOutcome {
  company: string;
  provider: string;
  token: string;
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  responseBytes: number;
  postings: number;
  jobsNew: number;
  jobsChanged: number;
  jobsUnchanged: number;
  possiblyClosed: number;
  closedOrRemoved: number;
  duplicatesFound: number;
  warnings: string[];
  error: string | null;
}

export interface RunOutcome {
  runId: string;
  startedAt: string;
  durationMs: number;
  companies: CompanyOutcome[];
  totals: {
    companiesChecked: number; companiesFailed: number;
    jobsSeen: number; jobsNew: number; jobsChanged: number; jobsUnchanged: number;
    jobsMissing: number; duplicates: number; bytesFetched: number;
    llmCalls: number;
  };
}

/**
 * A daily ingest run.
 *
 * Phase 2 makes ZERO LLM calls. Everything here is either a structured
 * field from the board or a deterministic rule, which is the point: an
 * LLM cannot be cheaper or more reliable than a field the ATS already
 * hands us, and spending one on `workplaceType` would be paying to add
 * uncertainty.
 */
export async function runIngest(
  store: Store,
  opts: { companies?: CompanyRow[]; limit?: number; concurrency?: number; log?: (s: string) => void } = {},
): Promise<RunOutcome> {
  const log = opts.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const runId = await store.startRun();

  const companies = opts.companies ?? (await store.listCompaniesToCheck(opts.limit ?? 100));
  const outcomes: CompanyOutcome[] = [];
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, companies.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= companies.length) return;
      const company = companies[i]!;
      const outcome = await ingestCompany(store, runId, company, log);
      outcomes.push(outcome);
    }
  });
  await Promise.all(workers);

  const totals = {
    companiesChecked: outcomes.length,
    companiesFailed: outcomes.filter((o) => !o.ok).length,
    jobsSeen: sum(outcomes, (o) => o.postings),
    jobsNew: sum(outcomes, (o) => o.jobsNew),
    jobsChanged: sum(outcomes, (o) => o.jobsChanged),
    jobsUnchanged: sum(outcomes, (o) => o.jobsUnchanged),
    jobsMissing: sum(outcomes, (o) => o.possiblyClosed + o.closedOrRemoved),
    duplicates: sum(outcomes, (o) => o.duplicatesFound),
    bytesFetched: sum(outcomes, (o) => o.responseBytes),
    llmCalls: 0,
  };

  await store.finishRun(runId, {
    status: totals.companiesFailed === outcomes.length && outcomes.length > 0 ? "FAILED" : "COMPLETED",
    companies_checked: totals.companiesChecked,
    companies_failed: totals.companiesFailed,
    jobs_seen: totals.jobsSeen,
    jobs_new: totals.jobsNew,
    jobs_changed: totals.jobsChanged,
    jobs_missing: totals.jobsMissing,
    llm_calls: 0,
    estimated_cost_cents: 0,
    error_summary: outcomes.filter((o) => !o.ok).map((o) => `${o.company}: ${o.error}`).join("; ") || null,
  });

  return { runId, startedAt, durationMs: Date.now() - t0, companies: outcomes, totals };
}

async function ingestCompany(
  store: Store, runId: string, company: CompanyRow, log: (s: string) => void,
): Promise<CompanyOutcome> {
  const provider = getProvider(company.ats_provider);
  const token = company.ats_token!;
  const warnings: string[] = [];
  const base: CompanyOutcome = {
    company: company.name, provider: company.ats_provider, token,
    ok: false, httpStatus: null, durationMs: 0, responseBytes: 0,
    postings: 0, jobsNew: 0, jobsChanged: 0, jobsUnchanged: 0,
    possiblyClosed: 0, closedOrRemoved: 0, duplicatesFound: 0,
    warnings, error: null,
  };

  const fetched = await provider.fetchBoard(token);
  const fetchedAt = new Date().toISOString();
  base.httpStatus = fetched.httpStatus;
  base.durationMs = fetched.durationMs;
  base.responseBytes = fetched.responseBytes;
  base.postings = fetched.postings.length;
  base.ok = fetched.ok;
  base.error = fetched.error;

  const previousCount = company.open_job_count ?? null;
  const suspiciousEmpty = fetched.ok && fetched.postings.length === 0 && (previousCount ?? 0) > 0;
  if (suspiciousEmpty) {
    warnings.push(
      `board returned 0 postings but held ${previousCount} last time; treating as suspect and NOT ageing existing jobs`,
    );
  }
  if (fetched.ok && previousCount && fetched.postings.length > 0 &&
      fetched.postings.length < previousCount * 0.5) {
    warnings.push(`board shrank from ${previousCount} to ${fetched.postings.length} postings`);
  }

  // Retention: a failed fetch always keeps its body, and so does any
  // fetch that actually produced a change. An unchanged daily payload is
  // fully described by a hash that matches yesterday's, so keeping it
  // would be paying storage to learn nothing.
  const retainReason = !fetched.ok
    ? "fetch failed"
    : suspiciousEmpty
      ? "board returned zero postings unexpectedly"
      : null;

  const fetchId = await store.recordFetch({
    ingest_run_id: runId, company_id: company.id, ats_provider: company.ats_provider,
    endpoint_url: fetched.endpointUrl, http_status: fetched.httpStatus, ok: fetched.ok,
    error: fetched.error, response_bytes: fetched.responseBytes,
    response_hash: fetched.responseHash, jobs_in_payload: fetched.postings.length,
    duration_ms: fetched.durationMs, fetcher_version: provider.fetcherVersion,
    raw_body: retainReason ? fetched.rawBody : null,
    raw_body_retained: Boolean(retainReason && fetched.rawBody),
    retention_reason: retainReason,
    retain_until: retainReason ? null : isoDate(90),
  });

  if (!fetched.ok) {
    // A failed fetch must never close a job. This is the single most
    // consequential rule in the run: an ATS outage would otherwise mark
    // an entire company's postings closed overnight.
    await store.recordCompanyCheck({
      companyId: company.id, ok: false, jobCount: null,
      durationMs: fetched.durationMs, error: fetched.error, runId,
    });
    log(`  ${company.name}: FAILED (${fetched.error})`);
    return base;
  }

  const normalized: NormalizedJob[] = [];
  for (const posting of fetched.postings) {
    try {
      normalized.push(provider.normalize(posting));
    } catch (err) {
      warnings.push(`normalization threw for source job ${posting.sourceJobId}: ${String(err)}`);
    }
  }

  const existing = await store.listJobsForCompany(company.id, company.ats_provider);
  const byExternalId = new Map(existing.map((e) => [e.external_id, e]));

  // Exact deduplication, two kinds.
  //
  //   Identity: the same source id seen twice in one payload. Boards do
  //   emit this. The second copy is dropped, not written twice, because
  //   unique (source, external_id) would reject it anyway.
  //
  //   Content: different source ids whose normalized content hashes
  //   match. Greenhouse in particular lists one role in several
  //   locations as separate postings. Both are kept as real jobs, since
  //   the board treats them as separately applicable, and the later one
  //   is linked DUPLICATE_OF the first.
  const seenSourceIds = new Set<string>();
  const byContentHash = new Map<string, string>();
  const writes: JobWriteInput[] = [];
  const dupPairs: Array<{ externalId: string; ofExternalId: string }> = [];

  for (const [idx, n] of normalized.entries()) {
    if (seenSourceIds.has(n.sourceJobId)) {
      warnings.push(`payload repeated source job id ${n.sourceJobId}; kept first copy only`);
      continue;
    }
    seenSourceIds.add(n.sourceJobId);

    const ch = contentHash(n);
    const firstWithHash = byContentHash.get(ch);
    if (firstWithHash && firstWithHash !== n.sourceJobId) {
      dupPairs.push({ externalId: n.sourceJobId, ofExternalId: firstWithHash });
    } else {
      byContentHash.set(ch, n.sourceJobId);
    }

    writes.push({
      companyId: company.id, source: company.ats_provider, runId, fetchId,
      normalized: n, raw: fetched.postings[idx]!.raw,
      contentHash: ch,
      descriptionHash: descriptionHash(n),
      rawFragmentHash: hashObject(fetched.postings[idx]!.raw),
      normalizerVersion: provider.normalizerVersion,
      fetcherVersion: provider.fetcherVersion,
      existing: byExternalId.get(n.sourceJobId),
      fetchedAt,
    });
  }

  const results = await store.writeJobs(writes);
  base.jobsNew = results.filter((r) => r.isNew).length;
  base.jobsChanged = results.filter((r) => !r.isNew && r.versionCreated).length;
  base.jobsUnchanged = results.filter((r) => !r.versionCreated).length;

  const idToJob = new Map(writes.map((w, i) => [w.normalized.sourceJobId, results[i]!.jobId]));
  for (const pair of dupPairs) {
    const a = idToJob.get(pair.externalId);
    const b = idToJob.get(pair.ofExternalId);
    if (a && b) {
      await store.recordDuplicate(a, b);
      base.duplicatesFound++;
    }
  }

  if (!suspiciousEmpty) {
    const missing = await store.markMissing({
      companyId: company.id, source: company.ats_provider, seenExternalIds: seenSourceIds,
    });
    base.possiblyClosed = missing.possiblyClosed;
    base.closedOrRemoved = missing.closedOrRemoved;
  }

  await store.recordCompanyCheck({
    companyId: company.id, ok: true, jobCount: fetched.postings.length,
    durationMs: fetched.durationMs, error: null, runId,
  });

  log(
    `  ${company.name}: ${fetched.postings.length} postings ` +
    `(+${base.jobsNew} new, ~${base.jobsChanged} changed, =${base.jobsUnchanged} unchanged, ` +
    `-${base.possiblyClosed + base.closedOrRemoved} missing) ${fetched.durationMs}ms`,
  );
  return base;
}

/**
 * Board verification: proves a guessed token is real before a company is
 * allowed to become ACTIVE. A token that looks plausible and returns
 * nothing is worse than no token, because the company then appears
 * checked while contributing no coverage.
 */
export async function verifyBoard(
  providerName: string, token: string,
): Promise<{ ok: boolean; jobCount: number; httpStatus: number | null; error: string | null; durationMs: number }> {
  const provider = getProvider(providerName);
  const res = await provider.fetchBoard(token, { timeoutMs: 30_000 });
  return {
    ok: res.ok && res.postings.length > 0,
    jobCount: res.postings.length,
    httpStatus: res.httpStatus,
    error: res.ok && res.postings.length === 0 ? "board resolved but returned zero postings" : res.error,
    durationMs: res.durationMs,
  };
}

function sum<T>(items: T[], f: (t: T) => number): number {
  return items.reduce((acc, t) => acc + f(t), 0);
}

function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}
