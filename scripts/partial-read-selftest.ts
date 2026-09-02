/**
 * A partial read is not evidence about what it did not return.
 *
 *   node scripts/partial-read-selftest.ts
 *
 * The invariant, stated once:
 *
 *   Only a COMPLETE authoritative traversal of a board may provide
 *   negative evidence that a previously known posting is gone. A PARTIAL
 *   traversal provides positive evidence about what it saw, and no
 *   evidence whatsoever about what it did not see.
 *
 * This existed as an assumption and then stopped being true. Backfill
 * resumption made a fetch return the tail of a board rather than the
 * board, the absence check read a 34-posting tail as a board that had
 * shrunk from 600, and 1,217 live jobs were aged out in a single run.
 *
 * Everything here runs against an in-memory store and a fake board. No
 * network, no database.
 */
import { runIngest } from "../lib/ingest/run.ts";
import { registerProvider } from "../lib/ingest/providers/index.ts";
import type { AtsProvider, FetchResult, RawPosting } from "../lib/ingest/providers/types.ts";
import type { Store } from "../lib/db/store.ts";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};

/** A board of 634 postings that pages 20 at a time, like Workday. */
const BOARD = Array.from({ length: 634 }, (_, i) => `job-${i + 1}`);
let servedFrom = 0;
let servedCount = 0;

const fake: AtsProvider = {
  name: "WORKDAY" as any, normalizerVersion: 1, fetcherVersion: 1,
  boardUrl: (t) => `https://example.test/${t}`,
  async fetchBoard(_token, opts = {}) {
    const start = opts.startOffset ?? 0;
    const budget = (opts.maxPages ?? 30) * 20;
    const slice = BOARD.slice(start, start + budget);
    servedFrom = start; servedCount = slice.length;
    const reachedEnd = start + slice.length >= BOARD.length;
    return {
      ok: true, httpStatus: 200, endpointUrl: "https://example.test/b",
      durationMs: 1, responseBytes: 1, responseHash: "h", rawBody: null,
      postings: slice.map((id) => ({ sourceJobId: id, raw: { id } } as RawPosting)),
      error: null,
      nextOffset: reachedEnd ? -1 : start + slice.length,
    } as FetchResult & { nextOffset: number };
  },
  normalize(p) {
    return {
      sourceJobId: p.sourceJobId, providerOpeningKey: null,
      url: null, applyUrl: null, title: `Role ${p.sourceJobId}`,
      normalizedTitle: "role", department: null,
      locationRaw: "Chicago, IL", city: "Chicago", state: "IL", country: "US", metro: "Chicagoland",
      remotePolicy: "ONSITE" as any, remoteRestriction: null, onsiteDaysPerWeek: null,
      employmentArrangement: "FULL_TIME" as any, seniority: "MID" as any,
      salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null,
      salaryIsEstimated: false, salarySource: null,
      isIndividualContributor: null, managesPeople: null, travelRequirementPct: null,
      hasQuotaOrCommission: null, mentionsEquity: null,
      postedAt: null, descriptionText: "text", normalizationWarnings: [],
    };
  },
};
registerProvider("WORKDAY" as any, fake);

/** Enough of a store to observe what ingest decides. */
function memoryStore() {
  const known = new Map<string, { status: string }>();
  let cursor = { nextOffset: 0, backfillComplete: false, postingsSeen: 0 };
  const agedOut: string[] = [];
  const store = {
    kind: "file" as const,
    async startRun() { return "run"; },
    async finishRun() {},
    async listCompaniesToCheck() { return []; },
    async upsertCompany() {},
    async recordFetch() { return "fetch"; },
    async recordDuplicate() {},
    async readBoardCursor() { return cursor; },
    async writeBoardCursor(i: any) {
      cursor = { nextOffset: i.backfillComplete ? 0 : i.nextOffset, backfillComplete: i.backfillComplete, postingsSeen: i.postingsSeen };
    },
    async listJobsForCompany() {
      return [...known].map(([external_id, v], i) => ({
        id: `id-${i}`, external_id, content_hash: "c", status: v.status, consecutive_missing_checks: 0,
      })) as any;
    },
    async writeJobs(inputs: any[]) {
      return inputs.map((i, k) => {
        const ext = i.normalized.sourceJobId;
        const isNew = !known.has(ext);
        known.set(ext, { status: "OPEN" });
        return { jobId: `id-${ext}`, isNew, versionCreated: isNew, versionNumber: 1,
                 changes: [], duplicateOfJobId: null } as any;
      });
    },
    async recordCompanyCheck() {},
    async healthReport() { return {}; },
    async flush() {},
    async markMissing(input: any) {
      const seen: Set<string> = input.seenExternalIds;
      for (const k of known.keys()) if (!seen.has(k)) agedOut.push(k);
      return { possiblyClosed: agedOut.length, closedOrRemoved: 0 };
    },
    async updateCompanyAfterCheck() {},
    async findDuplicates() { return []; },
  } as unknown as Store;
  return { store, known, agedOut, cursorOf: () => cursor };
}

const company = {
  id: "c1", name: "Testco", domain: "testco.test",
  ats_provider: "WORKDAY", ats_token: "testco.wd1.myworkdayjobs.com/careers",
  lifecycle: "ACTIVE", priority_score: 90, consecutive_check_failures: 0, open_job_count: 0,
} as any;

// ---- run one: the first 600, which is a PARTIAL read -------------------
console.log("a resumed backfill gives no negative evidence");
const a = memoryStore();
for (let i = 1; i <= 600; i++) a.known.set(`job-${i}`, { status: "OPEN" });
await runIngest(a.store, { companies: [company], concurrency: 1 });
check("the first pass reads 600 and stops short of the end", servedCount === 600 && servedFrom === 0, `${servedFrom}+${servedCount}`);
check("and the cursor is left partial", a.cursorOf().backfillComplete === false && a.cursorOf().nextOffset === 600,
  JSON.stringify(a.cursorOf()));
check("nothing was aged out", a.agedOut.length === 0, `${a.agedOut.length} aged`);

// ---- run two: resumes at 600 and returns only 601-634 ------------------
await runIngest(a.store, { companies: [company], concurrency: 1 });
check("the second pass resumes at 600", servedFrom === 600, String(servedFrom));
check("and returns only the 34 remaining", servedCount === 34, String(servedCount));
check("postings 1-600 are STILL NOT aged out", a.agedOut.length === 0,
  `${a.agedOut.length} aged, e.g. ${a.agedOut.slice(0, 3).join(", ")}`);
check("reaching the end marks the backfill complete", a.cursorOf().backfillComplete === true,
  JSON.stringify(a.cursorOf()));

// ---- the complementary case: a complete read MAY age a job out --------
console.log("\na complete traversal may age a posting out");
const b = memoryStore();
// Pretend a previous run knew a posting this board no longer lists.
b.known.set("job-does-not-exist-any-more", { status: "OPEN" });
// A board small enough to be read completely in one pass.
const small = BOARD.slice(0, 10);
registerProvider("WORKDAY" as any, {
  ...fake,
  async fetchBoard() {
    servedFrom = 0; servedCount = small.length;
    return {
      ok: true, httpStatus: 200, endpointUrl: "u", durationMs: 1, responseBytes: 1,
      responseHash: "h", rawBody: null, error: null,
      postings: small.map((id) => ({ sourceJobId: id, raw: { id } })),
      nextOffset: -1,
    } as FetchResult & { nextOffset: number };
  },
} as AtsProvider);
await runIngest(b.store, { companies: [company], concurrency: 1 });
check("the absent posting IS aged out", b.agedOut.includes("job-does-not-exist-any-more"),
  JSON.stringify(b.agedOut));
check("and only that one", b.agedOut.length === 1, JSON.stringify(b.agedOut));

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
