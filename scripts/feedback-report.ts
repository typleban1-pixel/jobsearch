/**
 * Is the system actually getting better?
 *
 * The number that matters is not how much was filled automatically. A
 * filler that answers everything and is corrected half the time is worse
 * than one that answers less and is never wrong. So automation and
 * correction are printed together, per application and in order, and the
 * question to ask of the output is whether intervention is falling
 * WITHOUT corrections rising.
 *
 * Two different kinds of counting appear below, and mixing them is what
 * broke this report the first time. How much of a form is filled is a
 * SNAPSHOT: SpotHero was run six times and has one answer, so state
 * comes from the latest applicable run per application. What a human
 * corrected is a STREAM: three corrections on one application are three
 * corrections, across as many retries as it took.
 *
 * State is computed here from the raw rows through the shared rule in
 * lib/metrics/fillState.ts, which is the same rule the 0054 view
 * implements in SQL. verify-0054 checks the two against each other.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { applicationStateMetrics, pickLatestRun,
         type ApplicationRow, type FillRunRow } from "../lib/metrics/fillState.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: apps } = await db.from("applications").select("id,status,is_test");
const { data: runs } = await db.from("application_fill_runs")
  .select("id,application_id,started_at,finished_at,outcome,fields_attempted,fields_filled,fields_left_blank")
  .order("started_at");
const { data: events } = await db.from("answer_feedback_events")
  .select("application_id,proposed_answer,human_answer,reuse_scope,classification,resulting_profile_field");
const real = ((apps ?? []) as ApplicationRow[]).filter((a) => !a.is_test);
const realIds = new Set(real.map((a) => a.id));

const state = applicationStateMetrics((apps ?? []) as ApplicationRow[], (runs ?? []) as FillRunRow[]);
const realEvents = (events ?? []).filter((e) => realIds.has(e.application_id));

const pct = (n: number, d: number) => (d === 0 ? "  n/a" : `${((n / d) * 100).toFixed(1).padStart(5)}%`);
const num = (n: number | undefined) => String(n ?? 0).padStart(6);

console.log("current state, one observation per application");
console.log(`  applications measured         ${num(state.applications_measured)}`);
if (state.applications_without_a_fill_run) {
  console.log(`  applications with no fill run ${num(state.applications_without_a_fill_run)}  (no fields counted for these)`);
}
console.log(`  fields encountered            ${num(state.fields_encountered)}`);
console.log(`  answered automatically        ${num(state.fields_answered_automatically)}  ${pct(state.fields_answered_automatically, state.fields_encountered)}`);
console.log(`  left for a human              ${num(state.fields_left_for_human)}  ${pct(state.fields_left_for_human, state.fields_encountered)}`);
console.log(`  fill runs including retries   ${num((runs ?? []).filter((r) => realIds.has(r.application_id)).length)}  (history, not a denominator)`);

console.log("\nhuman interventions, every one counted");
const corrections = realEvents.filter((e) => e.proposed_answer && e.proposed_answer.toLowerCase() !== e.human_answer.toLowerCase());
const confirmations = realEvents.filter((e) => e.proposed_answer && e.proposed_answer.toLowerCase() === e.human_answer.toLowerCase());
console.log(`  interventions                 ${num(realEvents.length)}`);
console.log(`    corrections to filled fields${num(corrections.length)}  ${pct(corrections.length, realEvents.length)}`);
console.log(`    confirmations of proposals  ${num(confirmations.length)}`);
console.log(`  reusable                      ${num(realEvents.filter((e) => e.reuse_scope !== "NONE").length)}`);
console.log(`  deliberately one-off          ${num(realEvents.filter((e) => e.reuse_scope === "NONE").length)}`);

const counts = await Promise.all([
  db.from("semantic_mappings").select("*", { count: "exact", head: true }).eq("status", "ACTIVE"),
  db.from("contextual_answers").select("*", { count: "exact", head: true }),
  db.from("ats_adapter_rules").select("*", { count: "exact", head: true }),
  db.from("feedback_conflicts").select("*", { count: "exact", head: true }).eq("status", "OPEN"),
]);
console.log("\nwhat was learned");
console.log(`  semantic mappings             ${num(counts[0].count ?? 0)}`);
console.log(`  profile facts                 ${num(realEvents.filter((e) => e.classification === "PROFILE_FACT" && e.resulting_profile_field).length)}`);
console.log(`  contextual answers            ${num(counts[1].count ?? 0)}`);
console.log(`  ATS adapter rules             ${num(counts[2].count ?? 0)}`);
console.log(`  conflicts awaiting a decision ${num(counts[3].count ?? 0)}`);

// Per application, oldest first: the shape of the trend matters more
// than any single figure.
const byApp = new Map<string, FillRunRow[]>();
for (const r of (runs ?? []) as FillRunRow[]) {
  if (!realIds.has(r.application_id)) continue;
  byApp.set(r.application_id, [...(byApp.get(r.application_id) ?? []), r]);
}
const rows = [...byApp.entries()]
  .map(([id, rs]) => ({ id, latest: pickLatestRun(rs)!, attempts: rs.length }))
  .sort((a, b) => a.latest.started_at.localeCompare(b.latest.started_at));

console.log("\nper application, oldest first");
console.log("  date        runs  fields  auto   blank  human  corrected  outcome");
for (const r of rows) {
  const mine = realEvents.filter((e) => e.application_id === r.id);
  const corrected = mine.filter((e) => e.proposed_answer && e.proposed_answer.toLowerCase() !== e.human_answer.toLowerCase());
  console.log(`  ${r.latest.started_at.slice(0, 10)}${String(r.attempts).padStart(6)}${String(r.latest.fields_attempted).padStart(8)}`
    + `${String(r.latest.fields_filled).padStart(6)}${String(r.latest.fields_left_blank).padStart(8)}`
    + `${String(mine.length).padStart(7)}${String(corrected.length).padStart(11)}  ${r.latest.outcome}`);
}
console.log("\nFalling intervention with flat corrections is improvement. Falling intervention with rising corrections is not.");
