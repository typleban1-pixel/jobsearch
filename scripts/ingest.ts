/**
 * One ingest run across every ACTIVE company.
 *
 *   node scripts/ingest.ts
 *   node scripts/ingest.ts --limit 10 --concurrency 4
 */
import { getStore } from "../lib/db/index.ts";
import { runIngest } from "../lib/ingest/run.ts";
import { describeEnv } from "../lib/env.ts";

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};

const store = getStore();
console.log(`store: ${store.kind}`);
console.log(describeEnv(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]));
console.log();

/**
 * How many boards this run will actually read.
 *
 * The default of 100 quietly left 107 of 207 active boards unread during
 * what was meant to be a full reconciliation, and a reconciliation that
 * silently skips half the population is worse than one that refuses to
 * start: the numbers look complete and are not. --all reads every active
 * board; anything short of that says so, loudly.
 */
const activeBoards = await store.countActiveBoards?.() ?? null;
const wantAll = process.argv.includes("--all");
const limit = wantAll ? (activeBoards ?? 10_000) : arg("limit", 100);
if (activeBoards !== null) {
  console.log(`active boards: ${activeBoards}, this run reads ${Math.min(limit, activeBoards)}`);
  if (limit < activeBoards) {
    console.log(`  NOT a complete reconciliation: ${activeBoards - limit} boards will not be read.`);
    console.log("  Pass --all when the intent is to reconcile every board.");
  }
}

let out;
try {
  out = await runIngest(store, {
    limit,
    concurrency: arg("concurrency", 4),
    log: (s) => console.log(s),
  });
} finally {
  await store.close();
}

console.log(`\nrun ${out.runId}`);
console.log(`duration ${(out.durationMs / 1000).toFixed(1)}s`);
console.table(out.totals);

const withWarnings = out.companies.filter((c) => c.warnings.length);
if (withWarnings.length) {
  console.log("\nwarnings:");
  for (const c of withWarnings) for (const w of c.warnings) console.log(`  ${c.company}: ${w}`);
}
const failed = out.companies.filter((c) => !c.ok);
if (failed.length) {
  console.log("\nfailures:");
  for (const c of failed) console.log(`  ${c.company} (${c.provider}/${c.token}): ${c.error}`);
}
