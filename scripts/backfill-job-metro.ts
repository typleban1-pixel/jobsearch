/**
 * Re-resolves jobs.metro for open jobs from their stored city and state.
 *
 *   node --env-file=.env.local scripts/backfill-job-metro.ts [--commit]
 *
 * The eligibility gate reads jobs.metro. Ingest sets it when a posting is
 * first normalised, so a resolver fix (new suburbs, site-code prefixes)
 * reaches existing rows only through this pass. Only rows whose resolved
 * metro differs from the stored one are written; nothing else on the row
 * is touched.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { resolveMetro } from "../lib/ingest/normalize/location.ts";

const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const rows: any[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("jobs").select("id,city,state,metro,location_raw").eq("status", "OPEN").order("id").range(from, from + 999);
  if (error) throw new Error(error.message);
  rows.push(...data); if (data.length < 1000) break;
}
const changes = rows
  .map((j) => ({ id: j.id, city: j.city, state: j.state, from: j.metro ?? null, to: resolveMetro(j.city, j.state) }))
  .filter((c) => c.from !== c.to);
console.log(`${rows.length} open jobs; ${changes.length} metro change(s)`);
const byCity = new Map<string, number>();
for (const c of changes) byCity.set(`${c.city}, ${c.state} : ${c.from ?? "—"} -> ${c.to ?? "—"}`, (byCity.get(`${c.city}, ${c.state} : ${c.from ?? "—"} -> ${c.to ?? "—"}`) ?? 0) + 1);
for (const [k, n] of [...byCity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${String(n).padStart(3)}  ${k}`);
if (!commit) { console.log("\ndry run; pass --commit to write"); process.exit(0); }
let written = 0;
for (const c of changes) {
  const { error } = await db.from("jobs").update({ metro: c.to }).eq("id", c.id);
  if (error) throw new Error(`${c.id}: ${error.message}`);
  written++;
}
console.log(`wrote ${written}`);
