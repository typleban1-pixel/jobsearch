/**
 * Does the view agree with the rule?
 *
 * Run after 0054 is applied. The SQL in the migration and
 * lib/metrics/fillState.ts implement the same rule twice, in two
 * languages, which is the only way the view could be written and also
 * tested offline. This is what stops them drifting: it recomputes the
 * numbers from the raw rows and demands the view match, run for run.
 *
 * Read-only throughout.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { applicationStateMetrics, pickLatestRun,
         type ApplicationRow, type FillRunRow } from "../lib/metrics/fillState.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}\n         ${detail}`); }
};

const { data: apps } = await db.from("applications").select("id,status,is_test");
const { data: runs } = await db.from("application_fill_runs")
  .select("id,application_id,started_at,finished_at,outcome,fields_attempted,fields_filled,fields_left_blank");
const expected = applicationStateMetrics((apps ?? []) as ApplicationRow[], (runs ?? []) as FillRunRow[]);

const { data: latest, error: latestErr } = await db.from("latest_fill_run_per_application").select("*");
check("latest_fill_run_per_application exists and is readable", !latestErr, latestErr?.message ?? "");
if (latestErr) { console.log(`\n${pass + fails.length} checks, ${pass} passed`); process.exit(1); }

check("it holds exactly one row per non-test application that has a run",
  (latest ?? []).length === expected.applications_measured,
  `${(latest ?? []).length} rows, expected ${expected.applications_measured}`);
check("no application appears twice",
  new Set((latest ?? []).map((r) => r.application_id)).size === (latest ?? []).length, "");

// The row the view chose must be the row the rule chooses.
const byApp = new Map<string, FillRunRow[]>();
for (const r of (runs ?? []) as FillRunRow[]) byApp.set(r.application_id, [...(byApp.get(r.application_id) ?? []), r]);
for (const row of latest ?? []) {
  const mine = pickLatestRun(byApp.get(row.application_id) ?? []);
  check(`the view and the rule pick the same run for ${row.application_id.slice(0, 8)}`,
    mine?.id === row.id, `view chose ${String(row.id).slice(0, 8)}, the rule chose ${mine?.id?.slice(0, 8)}`);
  check(`  and it reports that run's own field counts`,
    row.fields_attempted === mine?.fields_attempted && row.fields_filled === mine?.fields_filled
    && row.fields_left_blank === mine?.fields_left_blank,
    `${row.fields_attempted}/${row.fields_filled}/${row.fields_left_blank} vs ${mine?.fields_attempted}/${mine?.fields_filled}/${mine?.fields_left_blank}`);
}

const { data: m, error: mErr } = await db.from("feedback_learning_metrics").select("*").single();
check("feedback_learning_metrics is readable", !mErr, mErr?.message ?? "");
if (m) {
  for (const [k, v] of Object.entries(expected)) {
    check(`${k} matches the rule`, m[k] === v, `view says ${m[k]}, the rule says ${v}`);
  }
  check("retries are still visible, as their own figure",
    typeof m.fill_runs_including_retries === "number"
    && m.fill_runs_including_retries >= m.applications_measured,
    `${m.fill_runs_including_retries} runs across ${m.applications_measured} applications`);
  check("field totals are no longer the sum of every run",
    m.fields_encountered <= (runs ?? []).reduce((n, r) => n + r.fields_attempted, 0),
    `${m.fields_encountered} vs ${(runs ?? []).reduce((n, r) => n + r.fields_attempted, 0)} summed`);

  // History must not have been deduplicated to fix state.
  const { count: events } = await db.from("answer_feedback_events").select("*", { count: "exact", head: true });
  check("every feedback event is still counted individually",
    m.interventions === events, `view says ${m.interventions}, the table holds ${events}`);
  const { count: conflicts } = await db.from("feedback_conflicts").select("*", { count: "exact", head: true });
  check("conflicts are counted from their own table",
    m.conflicts_all_time === conflicts, `view says ${m.conflicts_all_time}, the table holds ${conflicts}`);
}

// Nothing about the runs themselves may have changed.
check("every historical run is still present",
  (runs ?? []).length >= 6, `${(runs ?? []).length} runs`);
const spothero = ((runs ?? []) as FillRunRow[]).filter((r) => r.application_id === "9af26bee-dd8d-4e8d-b037-a224a5be24aa");
check("SpotHero's six runs are all still there, unmodified",
  spothero.length === 6 && spothero.some((r) => r.outcome === "NO_FORM_FOUND")
  && spothero.some((r) => r.outcome === "HANDOFF"), `${spothero.length} runs`);
check("and SpotHero now counts once, with the fourteen fields its form has",
  m?.applications_measured === 1 && m?.fields_encountered === 14 && m?.fields_answered_automatically === 13,
  JSON.stringify({ measured: m?.applications_measured, encountered: m?.fields_encountered, auto: m?.fields_answered_automatically }));

console.log(`\n${pass + fails.length} checks, ${pass} passed`);
if (fails.length) { console.log(`${fails.length} FAILED`); process.exit(1); }
console.log("0054 is live and the view agrees with the rule");
