/**
 * Migration 0077, checked against the live database.
 *
 *   node scripts/verify-0077.ts
 *
 * 0077 adds fill provenance to application_fill_runs: who drove the
 * browser, which artifact was actually uploaded and its hash at upload
 * time, and whether an irreversible submit was attempted during the run.
 *
 * The properties worth proving are not "the columns exist". They are:
 *
 *   the defaults tell the truth about rows written before the migration,
 *   which were all automated and none of which clicked submit;
 *
 *   a half-written artifact record is impossible, because a hash with no
 *   file and a file with no hash are both meaningless;
 *
 *   fill_mode cannot hold a value nobody designed;
 *
 *   and the portal still cannot write this table.
 *
 * Every probe runs against a test application and is removed afterwards,
 * so no real application gains a fill run it did not have.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n          ${detail}`}`);
  if (cond) pass++; else fails.push(name);
};

const NEW_COLUMNS = ["fill_mode", "resume_id", "artifact_sha256", "artifact_path", "submit_click_attempted"];

console.log("schema:");
const { data: sample } = await db.from("application_fill_runs").select("*").limit(1);
const cols = Object.keys(sample?.[0] ?? {});
for (const c of NEW_COLUMNS) check(`${c} exists`, cols.includes(c), cols.join(", "));

// ============================================================
// The rows that existed before the migration
// ============================================================
console.log("\nexisting rows carry honest defaults:");
{
  const { data: rows } = await db.from("application_fill_runs")
    .select("id,fill_mode,submit_click_attempted,artifact_sha256,artifact_path,outcome");
  const all = rows ?? [];
  check("every pre-existing run is marked AUTOMATED",
    all.every((r: any) => r.fill_mode === "AUTOMATED"),
    all.filter((r: any) => r.fill_mode !== "AUTOMATED").map((r: any) => `${r.id}=${r.fill_mode}`).join(", "));
  // The filler has no code path that clicks submit, so this must be
  // false everywhere. A true here would mean the column was backfilled
  // with a guess.
  check("no pre-existing run claims a submit was attempted",
    all.every((r: any) => r.submit_click_attempted === false),
    all.filter((r: any) => r.submit_click_attempted).map((r: any) => r.id).join(", "));
  check("no pre-existing run invents an artifact it never recorded",
    all.every((r: any) => r.artifact_sha256 === null && r.artifact_path === null),
    all.filter((r: any) => r.artifact_sha256 || r.artifact_path).map((r: any) => r.id).join(", "));
  console.log(`        (${all.length} rows inspected)`);
}

// ============================================================
// The constraints, in the failing direction
// ============================================================
const { data: probeApp } = await db.from("applications")
  .select("id,is_test").eq("is_test", true).limit(1).maybeSingle();

if (!probeApp) {
  check("a test application exists to probe against", false, "none found");
} else {
  console.log(`\nconstraints (probing against test application ${probeApp.id.slice(0, 8)}):`);
  const base = { application_id: probeApp.id, provider: "GREENHOUSE", outcome: "NO_FORM_FOUND" };
  const written: string[] = [];

  // fill_mode is a closed set.
  {
    const { data, error } = await db.from("application_fill_runs")
      .insert({ ...base, fill_mode: "SEMI_AUTOMATED" }).select("id").maybeSingle();
    if (data) written.push(data.id);
    check("an undesigned fill_mode is rejected",
      !!error && /fill_mode/.test(error.message), error?.message.slice(0, 100) ?? "it was ACCEPTED");
  }
  // A hash with no file.
  {
    const { data, error } = await db.from("application_fill_runs")
      .insert({ ...base, artifact_sha256: "abc123" }).select("id").maybeSingle();
    if (data) written.push(data.id);
    check("a hash with no file is rejected",
      !!error && /fill_run_artifact_is_complete/.test(error.message),
      error?.message.slice(0, 100) ?? "it was ACCEPTED");
  }
  // A file with no hash.
  {
    const { data, error } = await db.from("application_fill_runs")
      .insert({ ...base, artifact_path: "/tmp/x.pdf" }).select("id").maybeSingle();
    if (data) written.push(data.id);
    check("a file with no hash is rejected",
      !!error && /fill_run_artifact_is_complete/.test(error.message),
      error?.message.slice(0, 100) ?? "it was ACCEPTED");
  }
  // Both together are fine.
  {
    const { data, error } = await db.from("application_fill_runs")
      .insert({ ...base, fill_mode: "ASSISTED_MANUAL", artifact_sha256: "a".repeat(64), artifact_path: "/tmp/x.pdf" })
      .select("id,fill_mode,submit_click_attempted").maybeSingle();
    if (data) written.push(data.id);
    check("a complete artifact record is accepted", !error, error?.message ?? "");
    check("ASSISTED_MANUAL is a legal fill mode", data?.fill_mode === "ASSISTED_MANUAL", String(data?.fill_mode));
    check("submit_click_attempted defaults to false, not null",
      data?.submit_click_attempted === false, String(data?.submit_click_attempted));
  }
  // Neither is fine too: most runs upload nothing.
  {
    const { data, error } = await db.from("application_fill_runs")
      .insert({ ...base }).select("id,fill_mode").maybeSingle();
    if (data) written.push(data.id);
    check("a run that uploaded nothing is accepted", !error, error?.message ?? "");
    check("and defaults to AUTOMATED", data?.fill_mode === "AUTOMATED", String(data?.fill_mode));
  }

  for (const id of written) await db.from("application_fill_runs").delete().eq("id", id);
  const { data: left } = await db.from("application_fill_runs").select("id")
    .in("id", written.length ? written : ["00000000-0000-0000-0000-000000000000"]);
  check("every probe row was removed", (left ?? []).length === 0, `${(left ?? []).length} remain`);
}

// ============================================================
// The portal still cannot write this table
// ============================================================
console.log("\ngrants:");
{
  const { data: audit } = await db.rpc("security_audit");
  const row = (audit ?? []).find((r: any) => r.table_name === "application_fill_runs");
  const writable = /INSERT|UPDATE|DELETE|TRUNCATE/.test(row?.authenticated_privileges ?? "");
  check("application_fill_runs is still read-only to the portal role",
    !writable, row?.authenticated_privileges ?? "no audit row");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("migration 0077 verified against the live database");
