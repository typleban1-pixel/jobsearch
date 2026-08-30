/**
 * Board verification.
 *
 * Reads candidate tokens, proves each one against the live board, and
 * only then lets a company become ACTIVE. Guessing a slug is cheap and
 * usually wrong; a company with a plausible-but-wrong token looks checked
 * every day and contributes no coverage, which is worse than not having
 * it at all.
 *
 *   node scripts/verify-boards.ts data/company-candidates.json
 *   node scripts/verify-boards.ts data/company-candidates.json --commit
 */
import { readFileSync } from "node:fs";
import { verifyBoard } from "../lib/ingest/run.ts";
import { getStore } from "../lib/db/index.ts";

interface Candidate {
  name: string;
  domain?: string | null;
  provider: "GREENHOUSE" | "LEVER";
  token: string;
  industries?: string[];
  priority?: number;
  source?: string;
}

const path = process.argv[2] ?? "data/company-candidates.json";
const commit = process.argv.includes("--commit");
const candidates: Candidate[] = JSON.parse(readFileSync(path, "utf8"));

const store = commit ? getStore() : null;
if (store) console.log(`store: ${store.kind}\n`);
console.log(`verifying ${candidates.length} candidate board tokens\n`);

let verified = 0, rejected = 0;
const results: Array<Candidate & { ok: boolean; jobCount: number; error: string | null; ms: number }> = [];

const CONCURRENCY = 6;
let cursor = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= candidates.length) return;
      const c = candidates[i]!;
      const r = await verifyBoard(c.provider, c.token);
      results.push({ ...c, ok: r.ok, jobCount: r.jobCount, error: r.error, ms: r.durationMs });
      if (r.ok) verified++; else rejected++;
      console.log(
        `${r.ok ? "OK  " : "MISS"} ${c.provider.padEnd(10)} ${c.token.padEnd(24)} ` +
        `${String(r.jobCount).padStart(4)} jobs  ${String(r.durationMs).padStart(5)}ms` +
        (r.error ? `  ${r.error}` : ""),
      );
    }
  }),
);

console.log(`\nverified ${verified}, rejected ${rejected}`);

if (store) {
  for (const r of results.filter((x) => x.ok)) {
    const company = await store.upsertCompany({
      name: r.name, domain: r.domain ?? null,
      ats_provider: r.provider, ats_token: r.token,
      lifecycle: "VERIFIED", priority_score: r.priority ?? 50,
      industries: r.industries ?? [],
      discovery_method: "SEED_LIST", discovery_source: r.source ?? path,
    });
    await store.markCompanyVerified(company.id, r.jobCount);
  }
  await store.close();
  console.log(`committed ${verified} verified companies to the ${store.kind} store`);
} else {
  console.log("dry run: nothing written. Pass --commit to persist verified companies.");
}
