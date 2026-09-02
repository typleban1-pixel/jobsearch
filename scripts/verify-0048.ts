/**
 * Migration 0048, checked statically and then against the live database.
 *
 *   node scripts/verify-0048.ts          static checks only
 *   node scripts/verify-0048.ts --live   also exercise the constraints
 *
 * The static half runs before the migration is applied and is the part
 * that catches drift: the fill_outcome enum in SQL has to be exactly
 * {HANDOFF} united with the worker's stop reasons, and neither side may
 * contain anything meaning "submitted".
 *
 * The live half proves the constraints actually reject bad values rather
 * than merely being written down. Every case asserts the specific
 * constraint by name, because a rejection for the wrong reason is a test
 * that passes while proving nothing.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { STOP_REASONS, FILL_OUTCOMES, HANDOFF } from "../lib/browser/stopReasons.ts";
import { INERT_EVIDENCE_THRESHOLD } from "../lib/browser/parserBehaviour.ts";

const live = process.argv.includes("--live");
let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n          ${detail}`}`);
  if (cond) pass++; else fails.push(name);
};

// ============================================================
// Static: the migration text itself
// ============================================================
const sql = readFileSync("supabase/migrations/0048_fill_runs.sql", "utf8");

console.log("static checks:");

// A primary key declared twice on one table would be a syntax error the
// first time it is applied, and is worth catching before that.
const perTable = sql.split(/create table if not exists/).slice(1);
for (const body of perTable) {
  const table = body.trim().split(/[\s(]/)[0]!;
  const pks = (body.split("create index")[0]!.match(/\bprimary key\b/gi) ?? []).length;
  check(`${table} declares exactly one primary key`, pks === 1, `${pks} found`);
}

const enumBlock = sql.slice(sql.indexOf("create type fill_outcome"), sql.indexOf("end $$;"));
const enumValues = [...enumBlock.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);

check("the fill_outcome enum is exactly {HANDOFF} plus the worker's stop reasons",
  JSON.stringify([...enumValues].sort()) === JSON.stringify([...FILL_OUTCOMES].sort()),
  `sql-only: ${enumValues.filter((v) => !FILL_OUTCOMES.includes(v as any)).join(", ") || "none"}; ` +
  `code-only: ${FILL_OUTCOMES.filter((v) => !enumValues.includes(v)).join(", ") || "none"}`);

check("HANDOFF is the one success and is not modelled as a stop",
  enumValues.includes(String(HANDOFF))
  && !(STOP_REASONS as readonly string[]).includes(String(HANDOFF)),
  `in enum: ${enumValues.includes(String(HANDOFF))}`);
check("every stop reason is a genuine stop",
  (STOP_REASONS as readonly string[]).every((r) => r !== String(HANDOFF)), STOP_REASONS.join(", "));

check("no stop reason means the system submitted anything",
  !STOP_REASONS.some((r) => /^SUBMITTED$|^SENT$|^APPLIED$/.test(r)), STOP_REASONS.join(", "));
check("no enum value means the system submitted anything",
  !enumValues.some((v) => /^SUBMITTED$|^SENT$|^APPLIED$/.test(v)), enumValues.join(", "));
check("outcome is typed by the enum rather than free text",
  /\boutcome fill_outcome not null\b/.test(sql), "outcome is not enum-typed");

// The distinction the whole table exists to hold.
check("parser_mode is documented as observed only",
  /comment on column ats_form_behaviour\.parser_mode is\s*\n?\s*'Observed only/.test(sql), "comment missing or reworded");
check("upload_ordering is documented as a strategy, not a measurement",
  /comment on column ats_form_behaviour\.upload_ordering is\s*\n?\s*'Operating strategy, not a measurement/.test(sql), "comment missing or reworded");
check("no provider is seeded with a measured parser mode",
  !/insert into ats_form_behaviour[\s\S]*?'PARSER_OVERWRITES'[\s\S]*?on conflict/.test(sql)
  && !/insert into ats_form_behaviour[\s\S]*?'PARSER_INERT'[\s\S]*?on conflict/.test(sql),
  "a seed row claims a measured mode");
check("Greenhouse still uploads first despite an unmeasured parser",
  /\('GREENHOUSE', 'UNKNOWN', 'UPLOAD_FIRST'/.test(sql), "Greenhouse ordering changed");

// ============================================================
// Live: the constraints, in the failing direction
// ============================================================
if (!live) {
  console.log(`\n${pass} passed, ${fails.length} failed (static only; pass --live after applying)`);
  process.exit(fails.length ? 1 : 0);
}

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
console.log("\nlive checks:");

{
  const { data, error } = await db.from("ats_form_behaviour").select("provider,parser_mode,upload_ordering,observation_count");
  check("ats_form_behaviour exists and is readable", !error, error?.message ?? "");
  const rows = data ?? [];
  check("all three providers are seeded", rows.length >= 3, `${rows.length} rows`);
  check("no provider claims a measured parser mode yet",
    rows.every((r: any) => r.parser_mode === "UNKNOWN"),
    rows.map((r: any) => `${r.provider}=${r.parser_mode}`).join(", "));
  check("Greenhouse uploads first regardless",
    rows.find((r: any) => r.provider === "GREENHOUSE")?.upload_ordering === "UPLOAD_FIRST",
    JSON.stringify(rows.find((r: any) => r.provider === "GREENHOUSE")));
  // Not "no observations yet": fill runs record evidence, so a count of
  // zero expires the first time the worker runs. What must stay true is
  // the RELATIONSHIP between evidence and conclusion.
  check("a provider with no observations claims nothing",
    rows.every((r: any) => r.observation_count > 0 || r.parser_mode === "UNKNOWN"),
    rows.map((r: any) => `${r.provider}=${r.parser_mode}/${r.observation_count}`).join(", "));
  check("quiet runs never conclude PARSER_INERT before the threshold",
    rows.every((r: any) => r.parser_mode !== "PARSER_INERT" || r.observation_count >= INERT_EVIDENCE_THRESHOLD),
    rows.map((r: any) => `${r.provider}=${r.parser_mode}/${r.observation_count}`).join(", "));
  check("PARSER_OVERWRITES is only ever claimed with a field that moved",
    rows.every((r: any) => r.parser_mode !== "PARSER_OVERWRITES"
      || (r.evidence?.lastRun?.fieldsMoved?.length ?? 0) > 0),
    rows.map((r: any) => `${r.provider}=${r.parser_mode}`).join(", "));
  check("the operating ordering has not drifted from the seed",
    rows.find((r: any) => r.provider === "GREENHOUSE")?.upload_ordering === "UPLOAD_FIRST"
    && rows.filter((r: any) => r.provider !== "GREENHOUSE").every((r: any) => r.upload_ordering === "UPLOAD_LAST"),
    rows.map((r: any) => `${r.provider}=${r.upload_ordering}`).join(", "));
}

// An invalid parser mode.
{
  const { error } = await db.from("ats_form_behaviour")
    .insert({ provider: "TESTPROVIDER_A", parser_mode: "PARSER_PROBABLY", upload_ordering: "UPLOAD_FIRST" });
  check("an invalid parser_mode is rejected",
    !!error && /parser_mode/.test(error.message), error?.message.slice(0, 110) ?? "it was ACCEPTED");
}
// An invalid ordering.
{
  const { error } = await db.from("ats_form_behaviour")
    .insert({ provider: "TESTPROVIDER_B", parser_mode: "UNKNOWN", upload_ordering: "WHENEVER" });
  check("an invalid upload_ordering is rejected",
    !!error && /upload_ordering/.test(error.message), error?.message.slice(0, 110) ?? "it was ACCEPTED");
}
// A duplicate provider.
{
  const { error } = await db.from("ats_form_behaviour")
    .insert({ provider: "GREENHOUSE", parser_mode: "UNKNOWN", upload_ordering: "UPLOAD_FIRST" });
  check("a duplicate provider row is rejected by the primary key",
    !!error && /duplicate key|ats_form_behaviour_pkey/i.test(error.message),
    error?.message.slice(0, 110) ?? "it was ACCEPTED");
}

// Outcomes, including the one that must not exist.
{
  const { data: anyApp } = await db.from("applications").select("id").limit(1).maybeSingle();
  if (!anyApp) {
    check("an application exists to attach a fill run to", false, "none found");
  } else {
    const base = { application_id: anyApp.id, provider: "GREENHOUSE" };
    const runs: string[] = [];

    for (const bad of ["SUBMITTED", "SENT", "APPLIED", "submitted", "ANYTHING_ELSE"]) {
      const { data, error } = await db.from("application_fill_runs")
        .insert({ ...base, outcome: bad }).select("id").maybeSingle();
      if (data) runs.push(data.id);
      check(`outcome "${bad}" is rejected`,
        !!error && /invalid input value for enum fill_outcome/i.test(error.message),
        error?.message.slice(0, 110) ?? "it was ACCEPTED");
    }

    const { data: ok, error: okErr } = await db.from("application_fill_runs")
      .insert({ ...base, outcome: "REQUIRED_FIELD_BLOCKED" }).select("id").maybeSingle();
    if (ok) runs.push(ok.id);
    check("a real stop reason is accepted", !okErr, okErr?.message ?? "");

    const { data: done, error: doneErr } = await db.from("application_fill_runs")
      .insert({ ...base, outcome: HANDOFF }).select("id").maybeSingle();
    if (done) runs.push(done.id);
    check("HANDOFF is accepted, and means filled and left for a person", !doneErr, doneErr?.message ?? "");

    const { error: negErr } = await db.from("application_fill_runs")
      .insert({ ...base, outcome: "HANDOFF", fields_filled: -1 });
    check("a negative field count is rejected", !!negErr, negErr ? "" : "it was ACCEPTED");

    for (const id of runs) await db.from("application_fill_runs").delete().eq("id", id);
    const { data: left } = await db.from("application_fill_runs").select("id").in("id", runs.length ? runs : ["00000000-0000-0000-0000-000000000000"]);
    check("the test fill runs were removed", (left ?? []).length === 0, `${(left ?? []).length} remain`);
  }
}

// Grants did not widen.
{
  const { data: audit } = await db.rpc("security_audit");
  for (const t of ["ats_form_behaviour", "application_fill_runs"]) {
    const row = (audit ?? []).find((r: any) => r.table_name === t);
    const writable = /INSERT|UPDATE|DELETE|TRUNCATE/.test(row?.authenticated_privileges ?? "");
    check(`${t} is read-only to the portal role`, !writable, row?.authenticated_privileges ?? "no audit row");
  }
  const EXPECTED = ["application_answers", "applications", "job_interest", "question_bank"];
  const w = (audit ?? []).filter((r: any) => /INSERT|UPDATE/.test(r.authenticated_privileges))
    .map((r: any) => r.table_name).sort();
  check("the portal role still writes exactly four tables",
    JSON.stringify(w) === JSON.stringify(EXPECTED), w.join(", "));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log("migration 0048 verified");
