/**
 * Derives job_locations for every job from its location_raw.
 *
 * Rebuildable by design: location_raw is untouched, so a parser change is
 * a delete-and-rerun rather than a migration.
 *
 *   node scripts/backfill-locations.ts [--write]
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { parseLocationSet, LOCATION_SET_VERSION } from "../lib/ingest/normalize/locationSet.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const page = async (t: string, c: string) => {
  const o: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from(t).select(c).order("id").range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break;
  } return o;
};

const jobs = await page("jobs", "id,location_raw,city,metro,status");
console.log(`jobs: ${jobs.length}`);

const rows: any[] = [];
let noLocation = 0, placeholderOnly = 0, multi = 0, withMetro = 0;
const warnCounts: Record<string, number> = {};
for (const j of jobs) {
  const { locations, warnings } = parseLocationSet(j.location_raw);
  for (const w of warnings) {
    const k = w.replace(/\(.*\)/, "(...)");
    warnCounts[k] = (warnCounts[k] ?? 0) + 1;
  }
  if (!j.location_raw) { noLocation++; continue; }
  if (locations.length === 0) { placeholderOnly++; continue; }
  if (locations.length > 1) multi++;
  if (locations.some((l) => l.metro)) withMetro++;
  for (const l of locations) {
    rows.push({
      job_id: j.id, position: l.position,
      city: l.city, state: l.state, region: l.region, country: l.country, metro: l.metro,
      is_remote: l.isRemote, remote_scope: l.remoteScope,
      provenance: l.provenance, confidence: l.confidence,
      raw_segment: l.rawSegment.slice(0, 500), parser_version: LOCATION_SET_VERSION,
    });
  }
}

console.log(`  normalized location rows to write: ${rows.length}`);
console.log(`  jobs with more than one location:  ${multi}`);
console.log(`  jobs with at least one metro:      ${withMetro}`);
console.log(`  jobs with no location_raw:         ${noLocation}`);
console.log(`  jobs whose location parsed to nothing (placeholders): ${placeholderOnly}`);
console.log("  parser warnings:");
for (const [w, n] of Object.entries(warnCounts).sort((a, b) => b[1] - a[1]).slice(0, 6))
  console.log(`    ${String(n).padStart(5)}  ${w}`);

const byConfidence: Record<string, number> = {};
for (const r of rows) byConfidence[r.confidence] = (byConfidence[r.confidence] ?? 0) + 1;
console.log(`  confidence: ${JSON.stringify(byConfidence)}`);

if (!process.argv.includes("--write")) { console.log("\ndry run. pass --write to persist."); process.exit(0); }

// Full rebuild rather than an upsert: the parser is the source of truth
// and a stale row from an older version is worse than a slower write.
const { error: delErr } = await db.from("job_locations").delete().neq("position", -1);
if (delErr) throw new Error(delErr.message);

for (let i = 0; i < rows.length; i += 500) {
  const { error } = await db.from("job_locations").insert(rows.slice(i, i + 500));
  if (error) throw new Error(`insert at ${i}: ${error.message}`);
  if (i % 5000 === 0) console.log(`  ${i}/${rows.length}`);
}
const { count } = await db.from("job_locations").select("*", { count: "exact", head: true });
console.log(`\nwrote ${count} job_locations rows`);
