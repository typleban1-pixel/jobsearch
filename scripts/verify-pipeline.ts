/**
 * End-to-end verification of the behaviours a live board will not
 * perform on demand: a posting changing, a posting disappearing, a board
 * erroring, a board going empty.
 *
 * Real Greenhouse payloads are fetched once and then replayed through the
 * real orchestrator with controlled edits. Nothing here is mocked except
 * the HTTP response itself.
 *
 *   node scripts/verify-pipeline.ts
 */
import { rmSync } from "node:fs";
import { FileStore } from "../lib/db/fileStore.ts";
import { greenhouse } from "../lib/ingest/providers/greenhouse.ts";
import { registerProvider } from "../lib/ingest/providers/index.ts";
import { runIngest } from "../lib/ingest/run.ts";
import { sha256 } from "../lib/ingest/hash.ts";
import type { AtsProvider, FetchResult, RawPosting } from "../lib/ingest/providers/types.ts";
import type { CompanyRow } from "../lib/db/store.ts";

const DIR = ".corpus-verify";
rmSync(DIR, { recursive: true, force: true });
const store = new FileStore(DIR);

const TOKEN = "vts";
console.log(`fetching real payload: greenhouse/${TOKEN}\n`);
const live = await greenhouse.fetchBoard(TOKEN);
if (!live.ok || live.postings.length === 0) {
  console.error(`could not fetch a live payload to replay: ${live.error}`);
  process.exit(1);
}
const REAL: RawPosting[] = live.postings;
console.log(`replaying ${REAL.length} real postings\n`);

// Controlled replay driver. Everything except the HTTP layer is the real code path.
let scenario: { postings: RawPosting[]; ok: boolean; status: number | null; error: string | null } = {
  postings: REAL, ok: true, status: 200, error: null,
};

const replay: AtsProvider = {
  name: "GREENHOUSE",
  normalizerVersion: greenhouse.normalizerVersion,
  fetcherVersion: greenhouse.fetcherVersion,
  boardUrl: (t) => greenhouse.boardUrl(t),
  normalize: (p) => greenhouse.normalize(p),
  async fetchBoard(token): Promise<FetchResult> {
    const body = JSON.stringify({ jobs: scenario.postings.map((p) => p.raw) });
    return {
      ok: scenario.ok, httpStatus: scenario.status,
      endpointUrl: greenhouse.boardUrl(token), durationMs: 1,
      responseBytes: Buffer.byteLength(body), responseHash: sha256(body),
      rawBody: body, postings: scenario.ok ? scenario.postings : [],
      error: scenario.error,
    };
  },
};
registerProvider("GREENHOUSE", replay);

const company: CompanyRow = await store.upsertCompany({
  name: "VTS (replay)", domain: "vts.com", ats_provider: "GREENHOUSE", ats_token: TOKEN,
  lifecycle: "VERIFIED", priority_score: 50, industries: ["proptech"],
  discovery_method: "SEED_LIST", discovery_source: "verify-pipeline",
});
await store.markCompanyVerified(company.id, REAL.length);

const results: Array<[string, string]> = [];
let step = 0;

async function pass(label: string): Promise<void> {
  step++;
  const fresh = (await store.listCompaniesToCheck(10)).find((c) => c.id === company.id)!;
  const out = await runIngest(store, { companies: [fresh] });
  const c = out.companies[0]!;
  const line =
    `new=${c.jobsNew} changed=${c.jobsChanged} unchanged=${c.jobsUnchanged} ` +
    `possiblyClosed=${c.possiblyClosed} closedOrRemoved=${c.closedOrRemoved} ` +
    `dupes=${c.duplicatesFound} ok=${c.ok}`;
  console.log(`[${step}] ${label}\n    ${line}`);
  if (c.warnings.length) for (const w of c.warnings) console.log(`    warning: ${w}`);
  results.push([label, line]);
}

function statusCounts(): Record<string, number> {
  const db = store.raw();
  const out: Record<string, number> = {};
  for (const j of db.jobs) {
    const s = j["status"] as string;
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

function versionCount(): number { return store.raw().job_versions.length; }
function payloadCount(): number { return store.raw().job_raw_payloads.length; }

// 1. Cold.
await pass("cold ingest of the real payload");
console.log(`    versions=${versionCount()} rawPayloads=${payloadCount()} statuses=${JSON.stringify(statusCounts())}\n`);

// 2. Byte-identical replay.
await pass("identical payload replayed (change detection must find nothing)");
console.log(`    versions=${versionCount()} rawPayloads=${payloadCount()}\n`);

// 3. Three controlled edits.
const edited = REAL.map((p) => ({ ...p, raw: structuredClone(p.raw) as Record<string, unknown> }));

// The salary edit has to land on a posting that does not already state
// one. Several of these are New York roles and carry a pay band in the
// body under the city's transparency law, so SALARY_ADDED could never
// fire on them: the value was there from version 1.
const salaryIdx = edited.findIndex((p) => greenhouse.normalize(p).salaryMin === null);
if (salaryIdx === -1) {
  console.error("every replayed posting already states a salary; pick a different board");
  process.exit(1);
}
const locIdx = edited.findIndex((_, i) => i !== salaryIdx);
const titleIdx = edited.findIndex((_, i) => i !== salaryIdx && i !== locIdx);

const e0 = edited[salaryIdx]!.raw as { content?: string; title?: string };
e0.content =
  (e0.content ?? "") +
  "<p>The base salary range for this role is $150,000 - $185,000 per year.</p>";
const e1 = edited[locIdx]!.raw as { location?: { name?: string } };
e1.location = { name: "Remote - United States" };
const e2 = edited[titleIdx]!.raw as { title?: string };
const originalTitle = e2.title;
e2.title = `Staff ${e2.title}`;
console.log(
  `    edits: [${salaryIdx}] "${e0.title}" salary text added (had none), ` +
  `[${locIdx}] location -> "Remote - United States", [${titleIdx}] title -> "Staff ${originalTitle}"`,
);
scenario = { ...scenario, postings: edited };
await pass("three postings edited (salary added, location changed, title changed)");
console.log(`    versions=${versionCount()} rawPayloads=${payloadCount()}`);
for (const ch of store.raw().job_changes) {
  console.log(
    `      ${String(ch["kind"]).padEnd(24)} material=${String(ch["is_material"]).padEnd(5)} ` +
    `${String(ch["old_value"] ?? "-").slice(0, 42)}  ->  ${String(ch["new_value"] ?? "-").slice(0, 42)}`,
  );
}
console.log();

// 4-6. Staged closed detection.
const dropped = edited.slice(4);
const removedIds = edited.slice(0, 4).map((p) => p.sourceJobId);
console.log(`    withholding 4 postings: ${removedIds.join(", ")}`);
scenario = { ...scenario, postings: dropped };
await pass("4 postings withheld (miss 1)");
console.log(`    statuses=${JSON.stringify(statusCounts())}\n`);
await pass("same 4 withheld (miss 2)");
console.log(`    statuses=${JSON.stringify(statusCounts())}\n`);
await pass("same 4 withheld (miss 3, threshold)");
console.log(`    statuses=${JSON.stringify(statusCounts())}\n`);

// 7. Reappearance.
scenario = { ...scenario, postings: edited };
await pass("withheld postings reappear");
console.log(`    statuses=${JSON.stringify(statusCounts())}\n`);

// 8. Fetch failure must never close a job.
scenario = { postings: [], ok: false, status: 503, error: "HTTP 503" };
await pass("board returns HTTP 503");
console.log(`    statuses=${JSON.stringify(statusCounts())}\n`);

// 9. Successful but empty board: the classic broken-API signature.
scenario = { postings: [], ok: true, status: 200, error: null };
await pass("board returns 200 with zero postings");
console.log(`    statuses=${JSON.stringify(statusCounts())}\n`);

await store.close();

// Assertions.
const db = store.raw();
const statuses = statusCounts();
const checks: Array<[string, boolean, string]> = [
  ["cold run created one version per job", versionCount() >= REAL.length, `versions=${versionCount()}`],
  ["identical replay created no extra version", results[1]![1].includes(`changed=0`), results[1]![1]],
  ["identical replay created no extra raw payload", payloadCount() === REAL.length + 3, `payloads=${payloadCount()}`],
  ["three edits produced exactly three changed jobs", results[2]![1].includes("changed=3"), results[2]![1]],
  ["SALARY_ADDED recorded and material", db.job_changes.some((c) => c["kind"] === "SALARY_ADDED" && c["is_material"] === true), ""],
  ["REMOTE_POLICY_CHANGED recorded and material", db.job_changes.some((c) => c["kind"] === "REMOTE_POLICY_CHANGED" && c["is_material"] === true), ""],
  ["TITLE_CHANGED recorded", db.job_changes.some((c) => c["kind"] === "TITLE_CHANGED"), ""],
  ["miss 1 staged as POSSIBLY_CLOSED", results[3]![1].includes("possiblyClosed=4"), results[3]![1]],
  ["miss 3 escalated to CLOSED_OR_REMOVED", results[5]![1].includes("closedOrRemoved=4"), results[5]![1]],
  ["nothing ever reached CONFIRMED_CLOSED automatically", !("CONFIRMED_CLOSED" in statuses), JSON.stringify(statuses)],
  ["reappearance restored jobs to OPEN", statuses["OPEN"] === REAL.length, JSON.stringify(statuses)],
  ["HTTP 503 closed nothing", results[7]![1].includes("possiblyClosed=0 closedOrRemoved=0"), results[7]![1]],
  ["empty 200 closed nothing", results[8]![1].includes("possiblyClosed=0 closedOrRemoved=0"), results[8]![1]],
  ["zero LLM calls throughout", db.ingest_runs.every((r) => (r["llm_calls"] ?? 0) === 0), ""],
];

console.log("assertions");
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
