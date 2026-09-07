/**
 * Portal performance, after: what each route's NEW data path costs.
 *
 *   node --env-file=.env.local --conditions=react-server scripts/perf-after.ts
 *
 * The exact counterpart of scripts/perf-baseline.ts -- same HTTP-level
 * round-trip counting, same routes, same cold/warm passes -- driving the
 * loaders the pages call now. Read the two tables side by side.
 *
 * /jobs and /job/[id] read job_card_summary. Until migration 0096 has been
 * applied and scripts/materialize-job-cards.ts has run, those two report
 * "not built yet" rather than failing the run, so the other routes can be
 * measured meanwhile.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadJobCardPage, loadJobCardById } from "../lib/portal/db.ts";
import { loadBlockerBoard } from "../lib/portal/blockerBoard.ts";
import { loadApplication } from "../lib/portal/applications.ts";
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
  try { const j = JSON.parse(text); if (Array.isArray(j)) stats.rows += j.length; else if (j && typeof j === "object") stats.rows += 1; } catch { /* head-only */ }
  return res;
};
const db: SupabaseClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false }, global: { fetch: counting },
});

const kb = (n: number) => `${(n / 1024).toFixed(0)}KB`;
interface Row { route: string; pass: string; ms: number; calls: number; rows: number; bytes: number; note: string }
const table: Row[] = [];
const notBuilt = (e: unknown) => /job_card_summary/.test(String(e)) && /does not exist|relation|schema cache/i.test(String(e));

async function measure(route: string, note: string, fn: () => Promise<unknown>) {
  for (const pass of ["cold", "warm"]) {
    reset();
    const t = performance.now();
    try {
      await fn();
      table.push({ route, pass, ms: Math.round(performance.now() - t), calls: stats.calls, rows: stats.rows, bytes: stats.bytes, note });
    } catch (e) {
      if (notBuilt(e)) { table.push({ route, pass, ms: -1, calls: stats.calls, rows: 0, bytes: 0, note: "job_card_summary not built yet (apply 0096, run materialize-job-cards --commit)" }); return; }
      throw e;
    }
  }
}

const { data: sampleApp } = await db.from("applications").select("id,job_id").eq("is_test", false)
  .order("created_at", { ascending: false }).limit(1).maybeSingle();
const appId = sampleApp?.id as string; const jobId = sampleApp?.job_id as string;

await measure("/jobs", "loadJobCardPage (page 1, active tab); renders 50", () => loadJobCardPage(db, { interest: "active", q: "", page: 1 }));
await measure("/job/[id]", "loadJobCardById + description + opening + live application", async () => {
  const [d] = await Promise.all([loadJobCardById(db, jobId), db.from("job_descriptions").select("description_text").eq("job_id", jobId).maybeSingle()]);
  if (d) await Promise.all([
    db.from("openings").select("identity_method,provider_opening_key").eq("id", d.card.openingId).maybeSingle(),
    db.from("applications").select("id,status").eq("canonical_opening_id", d.card.openingId).not("status", "in", "(REJECTED,WITHDRAWN,ABANDONED)").limit(1),
  ]);
});
await measure("/applications", "loadBlockerBoard (two waves)", () => loadBlockerBoard(db));
await measure("/applications/[id]", "loadApplication (direct by id, two waves)", () => loadApplication(db, appId));
await measure("/applications/[id]/review", "loadReview (unchanged)", () => loadReview(db, appId));
await measure("/apply", "loadApplyBoard (companies embedded)", () => loadApplyBoard(db));
await measure("/ (home)", "loadCounters (head-only counts)", () => loadCounters(db));

console.log("\nroute".padEnd(27), "pass", "wall ms".padStart(8), "reqs".padStart(5), "rows".padStart(7), "bytes".padStart(8), " note");
for (const r of table) console.log(r.route.padEnd(26), r.pass.padEnd(4), (r.ms < 0 ? "n/a" : String(r.ms)).padStart(8), String(r.calls).padStart(5), String(r.rows).padStart(7), kb(r.bytes).padStart(8), " " + r.note);
