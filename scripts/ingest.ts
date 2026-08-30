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

let out;
try {
  out = await runIngest(store, {
    limit: arg("limit", 100),
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
