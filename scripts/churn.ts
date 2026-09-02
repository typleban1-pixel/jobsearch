/**
 * Daily corpus snapshot, and the churn measurement behind it.
 *
 * The discovery cost estimate assumed 3% of jobs turn over daily. That
 * number was an assumption, not a measurement, and it drives the whole
 * extraction budget. This records what actually happens so the assumption
 * can be replaced after two weeks of daily runs.
 *
 * Churn is computed from first_seen_at and status_changed_at rather than
 * from a diff against yesterday, so a missed day leaves a gap in the
 * series instead of corrupting it.
 *
 *   node scripts/churn.ts            report only
 *   node scripts/churn.ts --commit   write today's snapshot
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const page = async (t: string, c: string) => {
  const o: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from(t).select(c).order("id").range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break;
  } return o;
};

const jobs = await page("jobs", "id,status,first_seen_at,status_changed_at,eligibility,company_id");
const companies = await page("companies", "id,lifecycle,ats_provider");
const open = jobs.filter((j: any) => j.status === "OPEN");

const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
const appeared24h = jobs.filter((j: any) => j.first_seen_at >= dayAgo).length;
const appeared7d = jobs.filter((j: any) => j.first_seen_at >= weekAgo).length;
const closed24h = jobs.filter((j: any) => j.status !== "OPEN" && (j.status_changed_at ?? "") >= dayAgo).length;

const byLifecycle: Record<string, number> = {};
for (const c of companies) byLifecycle[c.lifecycle] = (byLifecycle[c.lifecycle] ?? 0) + 1;
const boards: Record<string, number> = {};
for (const c of companies.filter((c: any) => c.lifecycle === "ACTIVE")) boards[c.ats_provider] = (boards[c.ats_provider] ?? 0) + 1;

console.log(`companies          ${companies.length}  ${JSON.stringify(byLifecycle)}`);
console.log(`active boards      ${JSON.stringify(boards)}`);
console.log(`jobs               ${jobs.length} total, ${open.length} open`);
console.log(`eligible           ${open.filter((j: any) => j.eligibility === "ELIGIBLE").length}`);
console.log(`appeared last 24h  ${appeared24h}  (${((appeared24h * 100) / Math.max(1, open.length)).toFixed(1)}% of the open corpus)`);
console.log(`appeared last 7d   ${appeared7d}`);
console.log(`closed last 24h    ${closed24h}`);
console.log(`\nthe 3% daily turnover in DISCOVERY.md is still an assumption;`);
console.log(`two weeks of these snapshots replaces it with the observed rate.`);

if (!commit) { console.log("\n(dry run: no snapshot written)"); process.exit(0); }

const byMetro: Record<string, number> = {};
const locs = await page("job_locations", "job_id,metro");
const openIds = new Set(open.map((j: any) => j.id));
for (const l of locs) {
  if (!l.metro || !openIds.has(l.job_id)) continue;
  byMetro[l.metro] = (byMetro[l.metro] ?? 0) + 1;
}

const { error } = await db.from("coverage_snapshots").upsert({
  snapshot_date: new Date().toISOString().slice(0, 10),
  companies_total: companies.length,
  companies_active: byLifecycle["ACTIVE"] ?? 0,
  companies_verified: byLifecycle["VERIFIED"] ?? 0,
  companies_unreachable: byLifecycle["INACTIVE"] ?? 0,
  companies_without_ats: byLifecycle["DISCOVERED"] ?? 0,
  boards_greenhouse: boards["GREENHOUSE"] ?? 0,
  boards_lever: boards["LEVER"] ?? 0,
  boards_ashby: boards["ASHBY"] ?? 0,
  boards_other: 0,
  live_jobs: open.length,
  by_metro: byMetro,
  by_industry: {},
  by_size_bucket: { appeared_24h: appeared24h, appeared_7d: appeared7d, closed_24h: closed24h },
}, { onConflict: "snapshot_date" });
if (error) throw new Error(`coverage_snapshots: ${error.message}`);
console.log(`\nsnapshot written for ${new Date().toISOString().slice(0, 10)}`);
