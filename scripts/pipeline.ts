/**
 * The scheduled pipeline: every step that is free and deterministic.
 *
 * Model extraction is NOT here and is not triggered from here. Newly
 * eligible jobs accumulate, the run reports how many are waiting and what
 * they would cost, and a person decides. Automating a spend because it is
 * small is how a small spend stops being noticed.
 *
 *   node scripts/pipeline.ts daily
 *   node scripts/pipeline.ts weekly
 *
 * Safe to miss. Every step is idempotent: ingest upserts by (source,
 * external_id), location backfill rebuilds from location_raw, eligibility
 * recomputes from current state, and scoring replaces the row for its own
 * (profile, weights, formula, corpus) tuple. A machine asleep for three
 * days catches up on one run rather than doing three runs' work.
 *
 * Safe to overlap. A lock file with the pid means a long run that spills
 * past the next trigger is not joined by a second copy writing the same
 * rows.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { planExtraction } from "../lib/llm/extractionDedup.ts";
import { estimateExtraction, formatEstimate } from "../lib/llm/extractionCost.ts";

const kind = process.argv[2] === "weekly" ? "weekly" : "daily";
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const LOCK = `${ROOT}/.pipeline.lock`;
// Cost is computed from measured token behaviour and the live price
// table, not carried as a constant. The old COST_PER_JOB_CENTS = 1.13
// was measured once and then the workload moved: across 4,118 real calls
// it is 1.29 cents per CALL and 2.08 per extracted job, so every figure
// this gate printed was 84% low. A number whose only purpose is to let a
// person decide whether to spend must never round down.
const HAIKU_PRICE = { in: 1.0, out: 5.0 };

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

// ---- lock ---------------------------------------------------------
if (existsSync(LOCK)) {
  const pid = Number(readFileSync(LOCK, "utf8").trim());
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (alive) {
    console.log(`another pipeline run is active (pid ${pid}); exiting without doing anything`);
    process.exit(0);
  }
  console.log(`stale lock from pid ${pid}, taking over`);
}
writeFileSync(LOCK, String(process.pid));
const release = () => { try { unlinkSync(LOCK); } catch { /* already gone */ } };
process.on("exit", release);
process.on("SIGINT", () => { release(); process.exit(130); });
process.on("SIGTERM", () => { release(); process.exit(143); });

// ---- helpers ------------------------------------------------------
const page = async (t: string, c: string) => {
  const o: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from(t).select(c).order("id").range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break;
  } return o;
};

async function snapshot() {
  const jobs = (await page("jobs", "id,status,eligibility,extracted_at,first_seen_at")).filter((j: any) => j.status === "OPEN");
  const companies = await page("companies", "id,lifecycle");
  const eligible = jobs.filter((j: any) => j.eligibility === "ELIGIBLE");
  // UNCERTAIN jobs are counted separately and never included in the
  // pending figure. They are not approved for extraction and must not be
  // able to drift into a batch by being adjacent to one.
  const pendingJobs = eligible.filter((j: any) => j.extracted_at === null);
  const ages = pendingJobs
    .map((j: any) => Math.floor((Date.now() - new Date(j.first_seen_at).getTime()) / 86_400_000))
    .sort((a: number, b: number) => b - a);
  return {
    openJobs: jobs.length,
    eligible: eligible.length,
    pending: pendingJobs.length,
    pendingOldestDays: ages[0] ?? 0,
    pendingMedianDays: ages.length ? ages[Math.floor(ages.length / 2)] : 0,
    uncertainPending: jobs.filter((j: any) => j.eligibility === "UNCERTAIN" && j.extracted_at === null).length,
    active: companies.filter((c: any) => c.lifecycle === "ACTIVE").length,
    discovered: companies.filter((c: any) => c.lifecycle === "DISCOVERED").length,
  };
}

interface StepResult { step: string; ok: boolean; ms: number; tail: string }

function run(step: string, args: string[], timeoutMs = 45 * 60_000): Promise<StepResult> {
  return new Promise((resolveStep) => {
    const started = Date.now();
    const child = // process.execPath, not "node": launchd runs with a minimal PATH
    // that does not include /usr/local/bin, so a bare "node" is ENOENT
    // under the scheduler while working perfectly in a terminal.
    spawn(process.execPath, args, { cwd: ROOT, env: process.env });
    let out = "";
    const cap = (d: Buffer) => { out += d.toString(); if (out.length > 40_000) out = out.slice(-40_000); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = out.trim().split("\n").slice(-6).join(" | ").slice(0, 600);
      const r = { step, ok: code === 0, ms: Date.now() - started, tail };
      console.log(`  ${r.ok ? "ok  " : "FAIL"} ${step.padEnd(22)} ${(r.ms / 1000).toFixed(1)}s`);
      if (!r.ok) console.log(`       ${tail.slice(0, 300)}`);
      resolveStep(r);
    });
  });
}

// ---- the run ------------------------------------------------------
const startedAt = new Date().toISOString();
console.log(`pipeline ${kind} run at ${startedAt}`);
const before = await snapshot();
console.log(`before: ${before.openJobs} open jobs, ${before.eligible} eligible, ${before.active} active companies\n`);

const steps: StepResult[] = [];

// Weekly only: sweep for new companies, then try to resolve a slice of
// the backlog. Resolution is rate-limited by --limit rather than by time,
// so a big backlog drains over weeks instead of hammering boards.
if (kind === "weekly") {
  steps.push(await run("discover", ["scripts/discover.ts", "--from=100", "--pages=40", "--commit"]));
}

// Daily, bounded. 2,666 companies were discovered and none had ever been
// checked, because resolution only ran weekly at 80 a week: a 33-week
// drain on a backlog that is where the employer universe actually grows.
// 150 a day is roughly eight minutes at the measured 3.3s per company,
// with the existing 120ms spacing between board calls, and it keeps pace
// with discovery instead of falling further behind it.
steps.push(await run("resolve-ats", ["scripts/resolve-ats.ts", "--limit=150", "--min-size=25", "--commit"]));

steps.push(await run("ingest", ["scripts/ingest.ts", "--commit"]));
steps.push(await run("locations", ["scripts/backfill-locations.ts", "--write"]));
// Derived from job_locations, so it has to follow the location backfill.
// Cheap, and it is what any geographic prioritization reads.
steps.push(await run("company-geo", ["scripts/backfill-company-geo.ts", "--commit"]));
steps.push(await run("eligibility", ["scripts/eligibility.ts", "--commit"]));
steps.push(await run("eligibility-refresh", ["scripts/eligibility-refresh.ts", "--commit"]));
// Free and deterministic. Jobs without requirements score as unscorable
// rather than being skipped, which is the honest representation.
steps.push(await run("score", ["scripts/score.ts", "--commit"]));
// Candidacy has never been in the scheduled pipeline, so job_candidacy
// was empty: 679 eligible jobs and not one of them classified. Anything
// that selects work by candidacy silently selects nothing until this
// runs, which is exactly the failure an automation policy would hide.
steps.push(await run("candidacy", ["scripts/score-candidacy.ts", "--write"]));
steps.push(await run("churn", ["scripts/churn.ts", "--commit"]));

// The application worker runs last and only on the daily pass: it needs
// candidacy from the step above, and it is the only step that can act
// outside this machine. Bounded, and every application is isolated in
// its own process so one failure cannot end the queue.
if (kind === "daily") {
  // Reconcile before the worker looks at anything: a stale
  // BLOCKED_NEEDS_INPUT hides an application that is actually ready.
  steps.push(await run("repair-status", ["scripts/repair-application-status.ts", "--write"]));
  // Opt-out, so validating discovery and scoring does not have to spend
  // model budget preparing applications as a side effect. The default is
  // unchanged: the scheduled run still prepares.
  // A pause file stops preparation without touching the schedule.
  //
  // Preparation composes resumes from the frozen truth profile, so while
  // a known-wrong fact is still in that profile every application it
  // prepares would carry the error. Discovery, scoring and eligibility
  // stay on: they do not make employer-facing claims.
  //
  // Remove .pause-preparation to resume.
  const pausedFor = existsSync(".pause-preparation")
    ? readFileSync(".pause-preparation", "utf8").trim() : null;

  if (pausedFor) {
    console.log(`  --  applications             PAUSED: ${pausedFor.split("\n")[0]}`);
  } else if (process.argv.includes("--no-applications")) {
    console.log("  --  applications             skipped by flag");
  } else {
    steps.push(await run("applications", ["scripts/application-worker.ts", "--commit", "--limit", "10"], 60 * 60_000));
  }
}

const after = await snapshot();
const succeeded = steps.every((s) => s.ok);
// Deduplication is planned, not assumed: the gate is told how many
// CALLS the pending jobs actually require, and still shows what it would
// cost if none of them deduplicated.
const pendingJobs = (await page("jobs", "id,status,eligibility,extracted_at,description_hash"))
  .filter((j: any) => j.status === "OPEN" && j.eligibility === "ELIGIBLE" && j.extracted_at === null);
const plan = planExtraction(pendingJobs.map((j: any) => ({ id: j.id, descriptionHash: j.description_hash })));
const estimate = estimateExtraction({ jobs: after.pending, calls: plan.uniqueInputs, price: HAIKU_PRICE });
const costCents = estimate.ceilingCents;

console.log(`\nafter:  ${after.openJobs} open jobs, ${after.eligible} eligible, ${after.active} active companies`);
console.log(`jobs added ${after.openJobs - before.openJobs}, eligibility ${before.eligible} -> ${after.eligible}`);
console.log(`companies resolved this run: ${after.active - before.active}`);
console.log(`\nAWAITING APPROVAL: ${after.pending} eligible jobs not yet extracted`);
console.log(`  ${formatEstimate(estimate)}`);
console.log(`  ${plan.reused} of them reuse an identical description and need no call of their own`);
console.log(`  waiting: oldest ${after.pendingOldestDays}d, median ${after.pendingMedianDays}d`);
console.log(`  UNCERTAIN jobs also unextracted: ${after.uncertainPending} — separate, NOT in the batch above`);
console.log(`  nothing was sent to a model by this run.`);

const { error } = await db.from("pipeline_runs").insert({
  kind, started_at: startedAt, finished_at: new Date().toISOString(), succeeded,
  steps: steps.map((s) => ({ step: s.step, ok: s.ok, ms: s.ms, tail: s.tail })),
  companies_checked: after.active,
  companies_resolved: after.active - before.active,
  jobs_added: after.openJobs - before.openJobs,
  jobs_closed: Math.max(0, before.openJobs - after.openJobs),
  eligible_before: before.eligible, eligible_after: after.eligible,
  pending_extraction: after.pending, pending_extraction_cost_cents: costCents,
  error: succeeded ? null : steps.filter((s) => !s.ok).map((s) => `${s.step}: ${s.tail.slice(0, 200)}`).join(" ;; "),
});
if (error) console.log(`could not write pipeline_runs: ${error.message}`);

console.log(`\n${succeeded ? "all steps succeeded" : "SOME STEPS FAILED"}`);
process.exit(succeeded ? 0 : 1);
