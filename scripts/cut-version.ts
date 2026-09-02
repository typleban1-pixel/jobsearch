/**
 * Cuts a profile version and nothing else. No scoring code, no weights,
 * no classifier: this exists so a version boundary can be an evidence
 * change and only an evidence change.
 *
 *   node scripts/cut-version.ts "reason"
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const reason = process.argv[2];
if (!reason) { console.error('usage: node scripts/cut-version.ts "reason"'); process.exit(1); }

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: before } = await db.from("profile").select("profile_version").eq("singleton", true).single();
console.log(`current version: ${before?.profile_version}`);

// Unapproved metrics are excluded by bump_profile_version itself. Listed
// here so the exclusion is visible in the run output rather than assumed.
const { data: unapproved } = await db.from("metrics").select("label,approved_for_use").eq("approved_for_use", false);
console.log(`unapproved metrics (will NOT be frozen): ${(unapproved ?? []).length}`);
for (const m of unapproved ?? []) console.log(`   ${m.label}`);

const { data: v, error } = await db.rpc("bump_profile_version", { p_reason: reason });
if (error) throw new Error(error.message);
console.log(`\ncut version ${v}`);

const { data: pv } = await db.from("profile_versions").select("*").eq("version", v).single();
console.log(`  rows ${pv.row_count}, hash ${pv.truth_hash?.slice(0, 12)}`);
console.log(`  reason: ${pv.reason}`);

const { data: rows } = await db.from("profile_version_rows").select("source_table").eq("profile_version", v);
const by: Record<string, number> = {};
for (const r of rows ?? []) by[r.source_table] = (by[r.source_table] ?? 0) + 1;
console.log("  composition:", Object.entries(by).sort().map(([k, n]) => `${k}=${n}`).join(" "));

for (const old of [3, 4]) {
  const { data: o } = await db.from("profile_versions").select("version,row_count,truth_hash").eq("version", old).single();
  console.log(`  version ${old} unchanged: ${o?.row_count} rows, hash ${o?.truth_hash?.slice(0, 12)}`);
}
