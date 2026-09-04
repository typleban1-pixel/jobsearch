/**
 * A single company's uncaught exception must never abort the rest of the
 * scheduled ingest window. Reproduces the real failure mode (Toast:
 * fetch succeeds, then a store write throws) with a fake provider and a
 * fake Store, and asserts the run isolates it: every company is still
 * attempted, the thrower yields exactly one failed outcome, finishRun
 * still runs, and error_summary names the thrower with its exact message.
 */
import { registerProvider } from "../lib/ingest/providers/index.ts";
import { runIngest } from "../lib/ingest/run.ts";
import type { AtsProvider, FetchResult, NormalizedJob } from "../lib/ingest/providers/types.ts";
import type { Store, CompanyRow, RunStats, ExistingJob, MissingResult, JobWriteInput, JobWriteResult } from "../lib/db/store.ts";

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

// Fetch always succeeds with an empty board; the throw is injected in the
// store, downstream of the fetch, exactly like the production crash.
const fakeProvider: AtsProvider = {
  name: "test" as any, normalizerVersion: 1, fetcherVersion: 1,
  boardUrl: (token: string) => `test://board/${token}`,
  async fetchBoard(): Promise<FetchResult> {
    return { ok: true, httpStatus: 200, endpointUrl: "test://board", durationMs: 1,
      responseBytes: 2, responseHash: "h", rawBody: null, postings: [], error: null };
  },
  normalize(): NormalizedJob { throw new Error("normalize should not be called with an empty board"); },
};
registerProvider("test" as any, fakeProvider);

class FakeStore implements Store {
  readonly kind = "file" as const;
  finished: RunStats | null = null;
  checks: Array<{ companyId: string; ok: boolean }> = [];
  throwFor: Set<string>;
  constructor(throwFor: Set<string>) { this.throwFor = throwFor; }
  async listCompaniesToCheck(): Promise<CompanyRow[]> { return []; }
  async startRun() { return "run-1"; }
  async finishRun(_id: string, stats: RunStats) { this.finished = stats; }
  async recordFetch() { return "fetch-1"; }
  async listJobsForCompany(companyId: string): Promise<ExistingJob[]> {
    if (this.throwFor.has(companyId)) throw new Error(`boom-${companyId}`); // the injected downstream failure
    return [];
  }
  async markMissing(): Promise<MissingResult> { return { possiblyClosed: 0, closedOrRemoved: 0 }; }
  async recordDuplicate() {}
  async writeJobs(inputs: JobWriteInput[]): Promise<JobWriteResult[]> {
    return inputs.map((_, i) => ({ jobId: `j${i}`, isNew: true, versionCreated: true, versionNumber: 1, changes: [], duplicateOfJobId: null }));
  }
  async recordCompanyCheck(input: { companyId: string; ok: boolean }) { this.checks.push({ companyId: input.companyId, ok: input.ok }); }
  async upsertCompany(): Promise<CompanyRow> { throw new Error("unused"); }
  async markCompanyVerified() {}
  async healthReport() { return {}; }
  async close() {}
}

const companies = (n: number): CompanyRow[] => Array.from({ length: n }, (_, i) => ({
  id: `c${i}`, name: `Company ${i}`, domain: null, ats_provider: "test", ats_token: `t${i}`,
  lifecycle: "ACTIVE", priority_score: 0, consecutive_check_failures: 0, open_job_count: 0,
}));

// ---- Case 1: one throws, 99 succeed ----
{
  const store = new FakeStore(new Set(["c42"]));
  const list = companies(100);
  const out = await runIngest(store, { companies: list, concurrency: 4 });
  ok(out.companies.length === 100, "all 100 companies attempted (none abandoned)", String(out.companies.length));
  const failed = out.companies.filter((o) => !o.ok);
  ok(failed.length === 1, "exactly one failed outcome", String(failed.length));
  ok(failed[0]?.company === "Company 42" && failed[0]?.error === "threw: boom-c42", "failed outcome names the thrower + exact message", failed[0]?.error ?? "");
  ok(out.companies.filter((o) => o.ok).length === 99, "the other 99 continue and succeed", String(out.companies.filter((o) => o.ok).length));
  ok(store.finished !== null, "finishRun still executed");
  ok(store.finished?.status === "COMPLETED", "run ends COMPLETED (partial), not stranded/failed", store.finished?.status);
  ok((store.finished?.error_summary ?? "").includes("Company 42") && (store.finished?.error_summary ?? "").includes("boom-c42"), "error_summary contains thrower + exact error", store.finished?.error_summary ?? "");
  ok(store.finished?.companies_checked === 100 && store.finished?.companies_failed === 1, "totals: 100 checked / 1 failed", `${store.finished?.companies_checked}/${store.finished?.companies_failed}`);
  // no successful outcome was converted to failed: every non-thrower reached a real company-check
  ok(store.checks.filter((c) => c.ok).length === 99, "99 successful company-checks recorded (no success flipped to failed)", String(store.checks.filter((c) => c.ok).length));
}

// ---- Case 2: multiple independent throws are isolated separately ----
{
  const store = new FakeStore(new Set(["c10", "c50", "c90"]));
  const out = await runIngest(store, { companies: companies(100), concurrency: 4 });
  ok(out.companies.length === 100, "all 100 attempted with 3 throwers");
  const failed = out.companies.filter((o) => !o.ok);
  ok(failed.length === 3, "exactly three failed outcomes", String(failed.length));
  const msgs = failed.map((o) => o.error).sort();
  ok(JSON.stringify(msgs) === JSON.stringify(["threw: boom-c10", "threw: boom-c50", "threw: boom-c90"]), "each thrower isolated with its own exact error", msgs.join(", "));
  ok(out.companies.filter((o) => o.ok).length === 97, "the other 97 succeed", String(out.companies.filter((o) => o.ok).length));
  const es = store.finished?.error_summary ?? "";
  ok(["Company 10", "Company 50", "Company 90"].every((n) => es.includes(n)), "error_summary lists all three throwers", es);
  ok(store.finished?.status === "COMPLETED", "run still COMPLETED with three isolated failures");
}

// ---- Case 3: no throws -> unchanged behavior (regression guard) ----
{
  const store = new FakeStore(new Set());
  const out = await runIngest(store, { companies: companies(20), concurrency: 4 });
  ok(out.companies.every((o) => o.ok), "with no throws every outcome is ok (behavior preserved)");
  ok(store.finished?.companies_failed === 0, "no failures recorded when nothing throws");
}

console.log(bad ? `\n${bad} FAILED` : `\ningest-isolation-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
