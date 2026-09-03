/**
 * What a run cost and what it bought.
 *
 *   node scripts/run-economics.ts --since=2026-09-03T00:00:00Z
 *
 * Distinguishes the one-time universe build from steady state: the build
 * pays for thousands of never-seen descriptions once; a routine day pays
 * only for new or changed ones, and this report is where that claim is
 * checked rather than assumed.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const since = process.argv.find((a) => a.startsWith("--since="))?.split("=")[1]
  ?? new Date(Date.now() - 24 * 3600_000).toISOString();

async function allRows(t: string, c: string, f: (q: any) => any = (q) => q): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(db.from(t).select(c)).order("id").range(from, from + 999);
    if (error) { console.error(`${t}: ${error.message}`); process.exit(1); }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}
const cohortOf = (src: string | null): string => {
  const s = String(src ?? "");
  if (/Y Combinator/i.test(s)) return "YC directory";
  if (/Wikidata.*Chicago/i.test(s)) return "Wikidata Chicago";
  if (/Wikidata.*large/i.test(s)) return "Wikidata large US";
  return "seed/other";
};

console.log(`window: since ${since}\n`);

// ---- ingest ----------------------------------------------------------
const jobs = await allRows("jobs", "id,company_id,created_at,eligibility,status");
const newJobs = jobs.filter((j: any) => j.created_at >= since);
console.log(`jobs ingested in window:      ${newJobs.length}`);

// ---- extraction spend ------------------------------------------------
const batches = await allRows("extraction_batches", "id,status,request_count,actual_cost_cents,created_at",
  (q) => q.gte("created_at", since));
const paidCalls = batches.reduce((n: number, b: any) => n + (b.request_count ?? 0), 0);
const cost = batches.reduce((n: number, b: any) => n + (b.actual_cost_cents ?? 0), 0) / 100;
console.log(`batches in window:            ${batches.length} (${batches.map((b: any) => b.status).join(", ") || "none"})`);
console.log(`paid extraction calls:        ${paidCalls}`);
console.log(`actual extraction cost:       $${cost.toFixed(2)}`);

const extractions = await allRows("job_requirement_extractions", "id,job_id,created_at,succeeded",
  (q) => q.gte("created_at", since)).catch(() => []);
const reusedRows = await allRows("jobs", "id,extraction_reuse_hash,created_at",
  (q) => q.not("extraction_reuse_hash", "is", null).gte("updated_at", since)).catch(() => []);
console.log(`new extractions recorded:     ${extractions.length}`);
console.log(`jobs served by reuse:         ${reusedRows.length}`);

// ---- what it bought --------------------------------------------------
const verdicts = await allRows("job_candidacy", "id,job_id,verdict,created_at", (q) => q.gte("created_at", since));
const newest = new Map<string, { v: string; at: string }>();
for (const v of verdicts) {
  const prev = newest.get(v.job_id);
  if (!prev || v.created_at > prev.at) newest.set(v.job_id, { v: v.verdict, at: v.created_at });
}
const tally = { APPLICATION_CANDIDATE: 0, STRETCH: 0, MANUAL_REVIEW: 0, REJECT: 0 } as Record<string, number>;
for (const { v } of newest.values()) if (v in tally) tally[v]++;
console.log(`\nnew verdicts in window:       ${newest.size}`);
for (const [k, n] of Object.entries(tally)) console.log(`  ${k.padEnd(22)} ${n}`);
const cand = tally.APPLICATION_CANDIDATE, cs = cand + tally.STRETCH;
if (newest.size) console.log(`\ncost per newly evaluated job: $${(cost / newest.size).toFixed(3)}`);
if (cand) console.log(`cost per APPLICATION_CANDIDATE: $${(cost / cand).toFixed(2)}`);
if (cs) console.log(`cost per CANDIDATE+STRETCH:   $${(cost / cs).toFixed(2)}`);

// ---- marginal yield per cohort ---------------------------------------
const companies = await allRows("companies", "id,discovery_source");
const co = new Map(companies.map((c: any) => [c.id, cohortOf(c.discovery_source)]));
const jobCo = new Map(jobs.map((j: any) => [j.id, co.get(j.company_id) ?? "seed/other"]));
const byCohort = new Map<string, { evaluated: number; cand: number; stretch: number }>();
for (const [jobId, { v }] of newest) {
  const k = jobCo.get(jobId) ?? "seed/other";
  const e = byCohort.get(k) ?? { evaluated: 0, cand: 0, stretch: 0 };
  e.evaluated++;
  if (v === "APPLICATION_CANDIDATE") e.cand++;
  if (v === "STRETCH") e.stretch++;
  byCohort.set(k, e);
}
console.log(`\nmarginal yield by cohort (this window):`);
for (const [k, e] of [...byCohort.entries()].sort((a, b) => b[1].evaluated - a[1].evaluated)) {
  console.log(`  ${k.padEnd(18)} ${String(e.evaluated).padStart(5)} evaluated  ${e.cand} candidate  ${e.stretch} stretch`
    + (e.evaluated ? `  (${(100 * (e.cand + e.stretch) / e.evaluated).toFixed(1)}% cand+stretch)` : ""));
}
