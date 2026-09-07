/**
 * Portal performance baseline: what each route's data path actually costs.
 *
 *   node --env-file=.env.local --conditions=react-server scripts/perf-baseline.ts
 *
 * Drives the exact loader each page calls, against the real database, and
 * counts every PostgREST round trip at the HTTP layer (a custom fetch handed
 * to supabase-js), so nothing a builder chain does can hide a request. Reports
 * wall time (parallel requests overlap, so this is what a visitor waits for),
 * request count, rows returned and bytes on the wire, cold then warm.
 *
 * --conditions=react-server makes the `server-only` guard resolve to its empty
 * export so these server modules load under plain node. Service role is used
 * for measurement only: the owner's RLS client returns the same rows, and the
 * round-trip count is the invariant this exists to measure.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadJobCards, loadUniverseCounts } from "../lib/portal/db.ts";
import { loadBlockerBoard } from "../lib/portal/blockerBoard.ts";
import { loadApplications, loadApplication } from "../lib/portal/applications.ts";
import { loadReview } from "../lib/portal/reviewData.ts";
import { loadApplyBoard } from "../lib/portal/applyBoard.ts";
import { loadCounters } from "../lib/portal/operations.ts";

const stats = { calls: 0, rows: 0, bytes: 0 };
const reset = () => { stats.calls = 0; stats.rows = 0; stats.bytes = 0; };

const counting: typeof fetch = async (input, init) => {
  stats.calls++;
  const res = await fetch(input, init);
  const text = await res.clone().text();
  stats.bytes += text.length;
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) stats.rows += j.length;
    else if (j && typeof j === "object") stats.rows += 1;
  } catch { /* head-only counts have no body */ }
  return res;
};

const db: SupabaseClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false }, global: { fetch: counting },
});

const kb = (n: number) => `${(n / 1024).toFixed(0)}KB`;
interface Row { route: string; pass: string; ms: number; calls: number; rows: number; bytes: number; note: string }
const table: Row[] = [];

async function measure(route: string, note: string, fn: () => Promise<unknown>) {
  for (const pass of ["cold", "warm"]) {
    reset();
    const t = performance.now();
    await fn();
    table.push({ route, pass, ms: Math.round(performance.now() - t), calls: stats.calls, rows: stats.rows, bytes: stats.bytes, note });
  }
}

// Sample ids for the detail routes: a real recent application and its job.
const { data: sampleApp } = await db.from("applications").select("id,job_id").eq("is_test", false)
  .order("created_at", { ascending: false }).limit(1).maybeSingle();
const appId = sampleApp?.id as string; const jobId = sampleApp?.job_id as string;

let universe = 0;
await measure("/jobs", "loadJobCards + loadUniverseCounts; renders 50", async () => {
  const cards = await loadJobCards(db); universe = cards.length;
  await loadUniverseCounts(db, cards.length);
});
await measure("/job/[id]", "loadJobCards (ALL) + openings + description + applications", async () => {
  await loadJobCards(db);
  await db.from("openings").select("*").eq("id", jobId).maybeSingle();
  await db.from("job_descriptions").select("description_text").eq("job_id", jobId).maybeSingle();
  await db.from("applications").select("id,status").eq("job_id", jobId);
});
await measure("/applications", "loadBlockerBoard (loadApplications + revalidate per app)", () => loadBlockerBoard(db));
await measure("/applications/[id]", "loadApplication -> loadApplications(ALL).find", () => loadApplication(db, appId));
await measure("/applications/[id]/review", "loadReview", () => loadReview(db, appId));
await measure("/apply", "loadApplyBoard", () => loadApplyBoard(db));
await measure("/ (home)", "loadCounters (pages ALL jobs + companies)", () => loadCounters(db));

console.log(`\nranked universe loadJobCards returns: ${universe} cards (page renders 50)\n`);
console.log("route".padEnd(26), "pass", "wall ms".padStart(8), "reqs".padStart(5), "rows".padStart(7), "bytes".padStart(8), " note");
for (const r of table) console.log(r.route.padEnd(26), r.pass.padEnd(4), String(r.ms).padStart(8), String(r.calls).padStart(5), String(r.rows).padStart(7), kb(r.bytes).padStart(8), " " + r.note);

// Table volumes, for context on what "all rows" means.
console.log("\ntable volumes:");
const vol = async (t: string, refine: (q: any) => any = (q) => q) => {
  const { count } = await refine(db.from(t).select("id", { count: "exact", head: true })); return count ?? 0;
};
console.log("  job_scores is_current:", await vol("job_scores", (q) => q.eq("is_current", true)));
console.log("  score_reasons (all):", await vol("score_reasons"));
console.log("  jobs OPEN:", await vol("jobs", (q) => q.eq("status", "OPEN")), "| jobs total:", await vol("jobs"));
console.log("  job_candidacy:", await vol("job_candidacy"));
console.log("  job_locations:", await vol("job_locations"));
console.log("  companies:", await vol("companies"));
console.log("  applications:", await vol("applications"));
