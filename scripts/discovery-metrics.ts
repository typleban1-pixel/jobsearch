/**
 * The discovery funnel and its cost, so we measure cost per legitimate
 * candidate rather than cost per job processed.
 *
 *   node scripts/discovery-metrics.ts [--days 14]
 *
 * Read-only. Everything comes from persisted state: pipeline_runs for the
 * intake and spend, job_extractions for calls and unique descriptions,
 * job_candidacy for candidates, applications for attempts and confirmed
 * submissions.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const daysIdx = process.argv.indexOf("--days");
const days = daysIdx > -1 ? Number(process.argv[daysIdx + 1]) : 14;
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const sinceISO = new Date(Date.now() - days * 86400_000).toISOString();

async function page<T>(t: string, sel: string, filt: (q: any) => any = (q) => q): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await filt(db.from(t).select(sel)).range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`); if (!data?.length) break;
    out.push(...data); if (data.length < 1000) break;
  }
  return out;
}
const num = (n: number) => n.toLocaleString();

// Intake + spend from pipeline runs in the window.
const runs = await page<any>("pipeline_runs", "kind,jobs_added,jobs_closed,pending_extraction_cost_cents,started_at",
  (q) => q.gte("started_at", sinceISO));
const jobsAdded = runs.reduce((a, r) => a + (r.jobs_added ?? 0), 0);

// Extraction calls + unique descriptions in the window.
const ext = await page<any>("job_extractions", "input_hash,succeeded,created_at",
  (q) => q.gte("created_at", sinceISO));
const calls = ext.filter((e) => e.succeeded).length;
const uniqueHashes = new Set(ext.filter((e) => e.succeeded).map((e) => e.input_hash)).size;

// Actual model spend in the window, if llm_calls records a cost.
let spendCents = 0; let spendKnown = false;
try {
  const calls2 = await page<any>("llm_calls", "cost_cents,created_at", (q) => q.gte("created_at", sinceISO));
  if (calls2.length && "cost_cents" in (calls2[0] ?? {})) { spendCents = calls2.reduce((a, c) => a + (c.cost_cents ?? 0), 0); spendKnown = true; }
} catch { /* llm_calls may not expose a cost column */ }

// Current candidate stock (verdict-latest across OPEN+ELIGIBLE done elsewhere;
// here: candidacy rows created in the window, by newest verdict per job).
const cand = await page<any>("job_candidacy", "job_id,verdict,created_at", (q) => q.order("created_at", { ascending: false }));
const latest = new Map<string, string>();
for (const c of cand) if (!latest.has(c.job_id)) latest.set(c.job_id, c.verdict);
const vdist: Record<string, number> = {};
for (const v of latest.values()) vdist[v] = (vdist[v] ?? 0) + 1;
const candidates = (vdist["APPLICATION_CANDIDATE"] ?? 0) + (vdist["STRETCH"] ?? 0);

// Applications and confirmed submissions in the window.
const apps = await page<any>("applications", "id,status,submitted_at,submit_outcome,created_at", (q) => q.gte("created_at", sinceISO));
const attempted = apps.length;
const submitted = apps.filter((a) => a.submitted_at).length;
const confirmed = apps.filter((a) => a.submit_outcome === "CONFIRMED").length;

console.log(`Discovery funnel, last ${days} day(s) (since ${sinceISO.slice(0, 10)})\n`);
console.log(`  pipeline runs               ${num(runs.length)}`);
console.log(`  new postings discovered     ${num(jobsAdded)}`);
console.log(`  LLM extraction calls        ${num(calls)}   (unique descriptions ${num(uniqueHashes)}; ${num(calls - uniqueHashes)} de-duplicated)`);
console.log(`  model spend                 ${spendKnown ? "$" + (spendCents / 100).toFixed(2) : "(llm_calls has no cost column; see pipeline_runs estimates)"}`);
console.log(`  applications attempted      ${num(attempted)}`);
console.log(`  submitted / confirmed       ${num(submitted)} / ${num(confirmed)}`);
console.log(`\nCurrent candidate stock (latest verdict, all jobs):`);
console.log(`  APPLICATION_CANDIDATE ${num(vdist["APPLICATION_CANDIDATE"] ?? 0)}  |  STRETCH ${num(vdist["STRETCH"] ?? 0)}  |  MANUAL_REVIEW ${num(vdist["MANUAL_REVIEW"] ?? 0)}  |  REJECT ${num(vdist["REJECT"] ?? 0)}`);
if (spendKnown && candidates > 0) console.log(`\n  cost per candidate (window spend / current candidate stock)  ~$${(spendCents / 100 / candidates).toFixed(3)}`);
console.log("");
