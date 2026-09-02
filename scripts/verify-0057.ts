/**
 * Is 0057 live, and did it change only what it said it would?
 *
 * Column defaults, nullability and check constraints are not visible
 * through the API, so each one is established by a write that must
 * succeed or a write that must be refused. The refused ones leave
 * nothing behind; the accepted ones are cleaned up by the uniqueness of
 * their own identity, and are marked as verifier rows.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}\n         ${detail}`); }
};

const { data: master } = await db.from("resumes").select("id").eq("is_master", true).single();
const hash = (n: number) => n.toString(16).padStart(64, "0");
const label = `verify-0057-${new Date().toISOString().slice(0, 19)}`;
const row = (over: Record<string, unknown> = {}) => ({
  resume_id: master!.id, content_sha256: hash(1), iteration: 0,
  evaluator_version: 1, model: label, score: 50,
  findings: [], requirement_coverage: [], assessment: { score: 50, summary: "verifier" },
  ...over,
});

// ---- the columns exist and behave ----------------------------------
const { error: colErr } = await db.from("resume_screening_evaluations")
  .select("attempts,first_attempt_failure").limit(1);
check("attempts and first_attempt_failure are present", !colErr, colErr?.message ?? "");

const { data: defaulted, error: e1 } = await db.from("resume_screening_evaluations")
  .insert(row()).select("attempts,first_attempt_failure").single();
check("a row written without them defaults attempts to 1 and the failure to null",
  !e1 && defaulted?.attempts === 1 && defaulted?.first_attempt_failure === null,
  e1?.message ?? JSON.stringify(defaulted));

const { data: two, error: e2 } = await db.from("resume_screening_evaluations")
  .insert(row({ content_sha256: hash(2), attempts: 2, first_attempt_failure: "unusable score (undefined)" }))
  .select("attempts,first_attempt_failure").single();
check("attempts 2 with a failure reason is accepted and stored as written",
  !e2 && two?.attempts === 2 && two?.first_attempt_failure === "unusable score (undefined)",
  e2?.message ?? JSON.stringify(two));

const { error: nullErr } = await db.from("resume_screening_evaluations")
  .insert(row({ content_sha256: hash(3), attempts: null }));
check("attempts cannot be null", Boolean(nullErr) && /null/i.test(nullErr!.message),
  nullErr?.message ?? "IT WAS ACCEPTED");

for (const [n, why] of [[0, "below the range"], [3, "above the range"], [-1, "negative"]] as const) {
  const { error } = await db.from("resume_screening_evaluations")
    .insert(row({ content_sha256: hash(10 + n), attempts: n }));
  check(`attempts ${n} is refused, being ${why}`,
    Boolean(error) && /attempts_check/.test(error!.message), error?.message ?? "IT WAS ACCEPTED");
}

const { data: text, error: e4 } = await db.from("resume_screening_evaluations")
  .insert(row({ content_sha256: hash(4), first_attempt_failure: "a".repeat(400) }))
  .select("first_attempt_failure").single();
check("first_attempt_failure is unbounded text, not a constrained type",
  !e4 && text?.first_attempt_failure?.length === 400, e4?.message ?? String(text?.first_attempt_failure?.length));

// ---- rows written before 0057 -------------------------------------
// "Historical" means written before the migration, by timestamp. An
// earlier version of this check said "every model except this run",
// which was wrong the moment the persistence test started deliberately
// writing retried rows of its own.
const MIGRATED_AT = "2026-08-31T16:20:00Z";
const { data: historical } = await db.from("resume_screening_evaluations")
  .select("id,model,attempts,first_attempt_failure,created_at")
  .lt("created_at", MIGRATED_AT).order("created_at");
check("rows that predate the migration all read as one attempt with no failure",
  (historical ?? []).length > 0
  && (historical ?? []).every((r) => r.attempts === 1 && r.first_attempt_failure === null),
  JSON.stringify((historical ?? []).map((r) => [r.model, r.attempts])));
console.log(`         ${(historical ?? []).length} row(s) predate the migration, all attempts=1`);

// ---- the view ------------------------------------------------------
const ORIGINAL_TEN = ["model", "evaluator_version", "evaluations", "resumes_read", "input_tokens",
  "output_tokens", "estimated_cost_cents", "avg_latency_ms", "avg_score", "deepest_revision_pass"];
const { data: view, error: viewErr } = await db.from("screening_cost_by_model").select("*");
check("the view reads successfully", !viewErr, viewErr?.message ?? "");
const cols = Object.keys(view?.[0] ?? {});
check("its first ten columns are the original ones, unchanged and in order",
  ORIGINAL_TEN.every((c, i) => cols[i] === c), JSON.stringify(cols.slice(0, 10)));
check("followed by exactly the two new diagnostics, and nothing else",
  cols.length === 12 && cols[10] === "needed_a_retry" && cols[11] === "retry_rate_pct",
  JSON.stringify(cols.slice(10)));

const mine = (view ?? []).find((r) => r.model === label);
check("the view counts the verifier's retried row",
  mine?.needed_a_retry === 1, JSON.stringify(mine));
check("and reports the retry rate over its evaluations",
  Number(mine?.retry_rate_pct) === Math.round((1 / Number(mine?.evaluations)) * 1000) / 10,
  `${mine?.retry_rate_pct}% of ${mine?.evaluations}`);
// Checked against the rows themselves rather than against an assumption
// about which models retried: for every model the view reports, its
// retry count is the number of its rows with attempts = 2.
const { data: everyRow } = await db.from("resume_screening_evaluations").select("model,attempts");
const retriesByModel = new Map<string, number>();
const rowsByModel = new Map<string, number>();
for (const r of everyRow ?? []) {
  rowsByModel.set(r.model, (rowsByModel.get(r.model) ?? 0) + 1);
  if (r.attempts === 2) retriesByModel.set(r.model, (retriesByModel.get(r.model) ?? 0) + 1);
}
const mismatched = (view ?? []).filter((r) => Number(r.needed_a_retry) !== (retriesByModel.get(r.model) ?? 0));
check("every model's retry count matches its rows",
  mismatched.length === 0, JSON.stringify(mismatched.map((r) => [r.model, r.needed_a_retry])));
const rateWrong = (view ?? []).filter((r) => {
  const expected = Math.round(1000 * (retriesByModel.get(r.model) ?? 0) / (rowsByModel.get(r.model) ?? 1)) / 10;
  return Math.abs(Number(r.retry_rate_pct) - expected) > 0.05;
});
check("and every retry rate is that count over that model's evaluations",
  rateWrong.length === 0, JSON.stringify(rateWrong.map((r) => [r.model, r.retry_rate_pct])));
check("a model that never retried reports zero rather than null",
  (view ?? []).filter((r) => !retriesByModel.has(r.model))
    .every((r) => Number(r.needed_a_retry) === 0 && Number(r.retry_rate_pct) === 0),
  JSON.stringify((view ?? []).map((r) => [r.model, r.needed_a_retry, r.retry_rate_pct])));

// ---- nothing else moved --------------------------------------------
const untouched = ["applications", "resumes", "employment_records", "employment_relationships",
  "profile", "profile_versions", "answer_feedback_events", "application_fill_runs",
  "feedback_learning_metrics", "latest_fill_run_per_application"];
for (const t of untouched) {
  const { error } = await db.from(t).select("*").limit(1);
  check(`${t} still reads`, !error, error?.message ?? "");
}
const { data: v8 } = await db.from("profile_versions").select("row_count,truth_hash").eq("version", 8).single();
check("profile version 8 is untouched",
  v8?.row_count === 256 && String(v8?.truth_hash).startsWith("cdbfa51e886b"), JSON.stringify(v8));
const { data: app } = await db.from("applications")
  .select("status,submitted_at,approved_artifact_sha256").eq("id", "9af26bee-dd8d-4e8d-b037-a224a5be24aa").single();
check("the SpotHero application is untouched",
  app?.status === "READY_TO_SUBMIT" && app?.submitted_at === null
  && app?.approved_artifact_sha256 === "c4ba2ccedfead2f85959cac862df3744c91978ead53a4da76a46bc9948a0e9d1",
  JSON.stringify(app));

// ---- re-running would change nothing --------------------------------
//
// Not by running it again, which is not mine to do, but by checking that
// every statement in the file is one that can be repeated.
const { readFileSync } = await import("node:fs");
const sql = readFileSync("supabase/migrations/0057_screening_attempt_diagnostics.sql", "utf8");
const statements = sql.split(";").map((s) => s.trim()).filter((s) => s && !s.startsWith("--"));
const repeatable = statements.every((s) =>
  /add column if not exists|drop constraint if exists|add constraint|create or replace view|comment on|grant select/i.test(s));
check("every statement in the migration is one that can be run twice",
  repeatable, statements.filter((s) => !/add column if not exists|drop constraint if exists|add constraint|create or replace view|comment on|grant select/i.test(s)).join(" | ").slice(0, 200));
check("and it neither drops nor alters the existing view",
  !/drop view|alter view/i.test(sql), "");

console.log(`\n${pass + fails.length} checks, ${pass} passed`);
if (fails.length) { console.log(`${fails.length} FAILED`); process.exit(1); }
console.log("0057 is live");
