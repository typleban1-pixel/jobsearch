/**
 * The unattended application worker.
 *
 *   node scripts/application-worker.ts                 dry run, decides only
 *   node scripts/application-worker.ts --commit
 *   node scripts/application-worker.ts --commit --limit 5
 *
 * Selects work by candidacy, decides each job against the automation
 * policy, and does one of three things: submit it without a person
 * looking, prepare it and route it to review, or skip it.
 *
 * Two properties are the whole point:
 *
 * FAILURE ISOLATION. Every application runs in a child process. A crash,
 * a hang, a browser that dies mid-fill: none of them can take down the
 * queue, because the queue is a loop over spawns and a dead child is
 * just a non-zero exit code recorded against one application.
 *
 * THE SWITCHES ARE READ TWICE. Once when the batch starts, and again in
 * the seconds before each submission. A switch turned off while a
 * browser is open has to stop THAT application, not the one after it.
 *
 * What this worker cannot do: weaken anything. It chooses which
 * applications to attempt. Every evidence, confidence, verification and
 * confirmation gate lives downstream in prepare and submit, and a policy
 * that authorized something those gates refuse still stops.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { readSwitches, readPolicy, decide, type Candidate } from "../lib/automation/policy.ts";
import { authoritativeCandidacy, authoritativeCandidacyRows, productionApplications } from "../lib/applications/authoritativeCandidacy.ts";
import { FIT_FORMULA_VERSION } from "../lib/scoring/fit.ts";
import { TAXONOMY_VERSION } from "../lib/scoring/requirementClass.ts";
import { CANDIDACY_MODEL_VERSION } from "../lib/scoring/candidacy.ts";

const commit = process.argv.includes("--commit");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : 25;

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const LOCK = `${ROOT}/.worker.lock`;
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

// ---- one at a time ----------------------------------------------------
if (existsSync(LOCK)) {
  const pid = Number(readFileSync(LOCK, "utf8").trim());
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (alive) { console.log(`another worker is running (pid ${pid}); exiting`); process.exit(0); }
  console.log(`stale lock from pid ${pid}, taking over`);
}
if (commit) writeFileSync(LOCK, String(process.pid));
const release = () => { try { unlinkSync(LOCK); } catch { /* gone */ } };
process.on("exit", release);
process.on("SIGINT", () => { release(); process.exit(130); });
process.on("SIGTERM", () => { release(); process.exit(143); });

const paged = async <T,>(t: string, c: string, f: (q: any) => any = (q) => q): Promise<T[]> => {
  const o: T[] = [];
  for (let x = 0; ; x += 1000) {
    const { data, error } = await f(db.from(t).select(c)).order("id").range(x, x + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    o.push(...((data ?? []) as T[])); if ((data ?? []).length < 1000) break;
  }
  return o;
};

/** Runs one step for one application, isolated. Never throws. */
function isolated(label: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; tail: string }> {
  return new Promise((done) => {
    const child = // process.execPath, not "node": launchd runs with a minimal PATH
    // that does not include /usr/local/bin, so a bare "node" is ENOENT
    // under the scheduler while working perfectly in a terminal.
    spawn(process.execPath, args, { cwd: ROOT, env: process.env });
    let out = "";
    const cap = (d: Buffer) => { out += d.toString(); if (out.length > 20_000) out = out.slice(-20_000); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, tail: out.trim().split("\n").slice(-4).join(" | ").slice(0, 400) });
    });
    child.on("error", (e) => { clearTimeout(timer); done({ ok: false, tail: `spawn failed: ${e.message}` }); });
  });
}

// ---- what the switches say at the start -------------------------------
const switches = await readSwitches(db);
const policy = await readPolicy(db);
console.log(`global auto-submit: ${switches.globalAutoSubmit ? "ON" : "OFF"}`);
for (const [p, v] of Object.entries(switches.byProvider)) {
  console.log(`  ${p.padEnd(12)} ${v.paused ? "paused" : "running"}  ${v.capability}`);
}
console.log(`policy: auto-submit ${JSON.stringify(policy.autoSubmitCandidacy)}, review ${JSON.stringify(policy.reviewCandidacy)}, `
  + `floor ${policy.baseSalaryFloor}, unknown salary ${policy.allowUnknownSalary ? "allowed" : "refused"}, `
  + `cap ${policy.maxApplicationsPerDay ?? "none"}\n`);

// ---- select ------------------------------------------------------------
const [jobs, candidacy, allApps, companies, profileRow] = await Promise.all([
  paged<any>("jobs", "id,title,company_id,source,status,eligibility,salary_min,canonical_opening_id"),
  paged<any>("job_candidacy",
    "id,job_id,verdict,reason_codes,hard_met,hard_total,profile_version,formula_version,taxonomy_version,model_version"),
  paged<any>("applications", "id,job_id,status,submitted_at,human_approved,authorization_mode,all_fields_confident,resume_id,submit_requested_at,submit_started_at,is_test"),
  paged<any>("companies", "id,name"),
  db.from("profile").select("profile_version").single(),
]);
const companyName = new Map(companies.map((c) => [c.id, c.name]));

// Only the verdict that describes the CURRENT scoring state.
//
// This used to be `new Map(candidacy.map(c => [c.job_id, c.verdict]))`,
// which let one row overwrite another and left the surviving verdict up
// to uuid ordering: 1,004 of 1,491 jobs were being decided on a stale
// row, 561 of them from profile v12. A job with no row at the current
// version now has no verdict at all, and decide() fails closed on that.
const versions = {
  profileVersion: (profileRow as any).data.profile_version,
  formulaVersion: FIT_FORMULA_VERSION,
  taxonomyVersion: TAXONOMY_VERSION,
  modelVersion: CANDIDACY_MODEL_VERSION,
};
const candidacyOf = authoritativeCandidacy(candidacy, versions);
const candidacyRowOf = authoritativeCandidacyRows(candidacy, versions);
console.log(`candidacy: profile v${versions.profileVersion}, formula ${versions.formulaVersion}, `
  + `taxonomy ${versions.taxonomyVersion}, model ${versions.modelVersion} `
  + `-> ${candidacyOf.size} authoritative verdicts of ${candidacy.length} rows`);

// Test fixtures are not applications. Filtered once, here, so no path
// below can reach one: not as an existing application for a real job,
// not through the requested-submission path, not through the
// already-applied opening set.
const apps = productionApplications(allApps);
if (apps.length !== allApps.length) {
  console.log(`  excluded ${allApps.length - apps.length} test application(s) from the production decision set`);
}
const appByJob = new Map(apps.map((a) => [a.job_id, a]));

// Deduplication is by underlying opening, not by job row. The same role
// reposted under a new id is the same job to the employer reading it.
const openingsApplied = new Set<string>();
for (const a of apps) {
  const j = jobs.find((x) => x.id === a.job_id);
  if (j?.canonical_opening_id) openingsApplied.add(j.canonical_opening_id);
}
const submittedToday = apps.filter((a) =>
  a.submitted_at && a.submitted_at.slice(0, 10) === new Date().toISOString().slice(0, 10)).length;

// Applications you approved and then asked the worker to run. These are
// not policy authorization: a person read this specific application, so
// they are unaffected by the unattended-submission switch, which governs
// applications nobody has read.
const requested = new Set(
  apps.filter((a: any) => a.submit_requested_at && !a.submitted_at).map((a: any) => a.id));

type Work = { job: any; disposition: ReturnType<typeof decide>; existing: any };
const work: Work[] = [];

for (const a of apps) {
  if (!requested.has(a.id) || a.submitted_at || !a.human_approved || !a.all_fields_confident) continue;
  const job = jobs.find((j) => j.id === a.job_id);
  if (!job) continue;
  const provider = switches.byProvider[job.source];
  if (!provider || provider.capability !== "PRODUCTION") {
    console.log(`  skipping requested ${job.title}: the ${job.source} adapter is not PRODUCTION`);
    continue;
  }
  work.push({ job, existing: a, disposition: { action: "SUBMIT", why: "you approved this application and asked for it to be run" } });
}

for (const job of jobs) {
  if (job.status !== "OPEN") continue;
  const existing = appByJob.get(job.id);
  if (existing?.submitted_at) continue;
  if (!existing && job.canonical_opening_id && openingsApplied.has(job.canonical_opening_id)) continue;

  const candidate: Candidate = {
    jobId: job.id, companyId: job.company_id, provider: job.source,
    candidacy: candidacyOf.get(job.id) ?? null,
    candidacyReasonCode: candidacyRowOf.get(job.id)?.reason_codes?.[0] ?? null,
    hardMet: candidacyRowOf.get(job.id)?.hard_met ?? null,
    hardTotal: candidacyRowOf.get(job.id)?.hard_total ?? null,
    eligibility: job.eligibility, fit: null,
    baseSalaryMin: job.salary_min ?? null,
    // Gates that only exist once an application does. Unprepared work is
    // optimistic here and is re-decided after preparation.
    allFieldsConfident: existing ? existing.all_fields_confident : true,
    blockedAnswers: 0, resumeClaimsAllGrounded: true, artifactValid: true,
    submittedToday,
  };
  const disposition = decide(candidate, policy, switches);
  if (disposition.action === "SKIP") continue;
  work.push({ job, disposition, existing });
}

const toSubmit = work.filter((w) => w.disposition.action === "SUBMIT");
const toReview = work.filter((w) => w.disposition.action === "REVIEW");
console.log(`${work.length} job(s) selected: ${toSubmit.length} would submit, ${toReview.length} route to review`);
console.log(`  already submitted today: ${submittedToday}`);

if (!commit) {
  for (const w of work.slice(0, 20)) {
    console.log(`  ${w.disposition.action.padEnd(6)} ${(companyName.get(w.job.company_id) ?? "?").slice(0, 24).padEnd(26)} ${w.job.title.slice(0, 48)}`);
    console.log(`         ${w.disposition.why}`);
  }
  console.log(`\n(dry run: nothing prepared, nothing submitted)`);
  process.exit(0);
}

// ---- do the work, one isolated application at a time -------------------
const results: Array<{ company: string; title: string; action: string; outcome: string }> = [];
let prepared = 0, submitted = 0, handedOff = 0, failed = 0;

for (const w of work.slice(0, limit)) {
  const company = companyName.get(w.job.company_id) ?? "unknown";
  const label = `${company} — ${w.job.title}`.slice(0, 70);
  console.log(`\n${label}`);
  console.log(`  ${w.disposition.action}: ${w.disposition.why}`);

  try {
    // 1. Make sure an application exists and is prepared.
    let app = w.existing;
    if (!app) {
      const r = await isolated("prepare", ["scripts/prepare-application.ts", w.job.id, "--write"], 10 * 60_000);
      if (!r.ok) {
        failed++; results.push({ company, title: w.job.title, action: w.disposition.action, outcome: `preparation failed: ${r.tail}` });
        console.log(`  FAILED to prepare: ${r.tail.slice(0, 200)}`);
        continue;                                   // the queue continues
      }
      prepared++;
      const { data: fresh } = await db.from("applications").select("*").eq("job_id", w.job.id).maybeSingle();
      app = fresh;
    }
    if (!app) {
      failed++; results.push({ company, title: w.job.title, action: w.disposition.action, outcome: "no application row after preparation" });
      continue;
    }

    // 2. Review-routed work stops here, on purpose. It is prepared and
    //    visible in the portal, and a person decides.
    if (w.disposition.action === "REVIEW") {
      handedOff++;
      results.push({ company, title: w.job.title, action: "REVIEW", outcome: `${app.status}, awaiting your review` });
      console.log(`  prepared and routed to review (${app.status})`);
      continue;
    }

    // 3. Re-read the switches. Not the ones from the top of this run:
    //    a switch flipped in the portal five minutes ago has to stop
    //    this application, not the next batch.
    const now = await readSwitches(db);
    const provider = now.byProvider[w.job.source];
    if (!now.globalAutoSubmit || !provider || provider.paused || provider.capability !== "PRODUCTION") {
      handedOff++;
      const why = !now.globalAutoSubmit ? "global auto-submit was switched off" : `${w.job.source} was paused`;
      results.push({ company, title: w.job.title, action: "REVIEW", outcome: `held: ${why}` });
      console.log(`  HELD: ${why} since this batch started`);
      continue;
    }

    // 3b. An application YOU approved runs on your authority, not the
    //     policy's. The automation policy decides which applications may
    //     go WITHOUT you; it has no say over one you personally reviewed.
    //     Re-deciding these against candidacy blocked a SpotHero run you
    //     had explicitly approved, on the grounds that the job scores
    //     REJECT. The safety gates still apply: they live in the
    //     submitter, which checks status, confidence and the artifact hash.
    if (app.human_approved) {
      await db.from("applications").update({ submit_started_at: new Date().toISOString() }).eq("id", app.id);
      const r = await isolated("submit", ["scripts/submit-application.ts", app.id], 20 * 60_000);
      // Cleared either way. A request that has been acted on must not be
      // picked up again on the next run.
      await db.from("applications")
        .update({ submit_requested_at: null, submit_started_at: null }).eq("id", app.id);
      const { data: after } = await db.from("applications").select("submitted_at").eq("id", app.id).single();
      if (after?.submitted_at) {
        submitted++;
        results.push({ company, title: w.job.title, action: "SUBMIT", outcome: `SUBMITTED ${after.submitted_at} (you approved it)` });
        console.log(`  SUBMITTED and confirmed, under your own approval`);
      } else {
        handedOff++;
        results.push({ company, title: w.job.title, action: "SUBMIT", outcome: `stopped: ${r.tail.slice(0, 160)}` });
        console.log(`  stopped without confirmation; left recoverable`);
      }
      continue;
    }
    // 3b. RE-DECIDE against what preparation actually produced.
    //
    // Selection ran before this application existed, so the gates that
    // only exist once there are answers and a rendered resume were
    // assumed to pass. Authorizing on that assumption would let an
    // application with blocked answers be stamped POLICY_AUTHORIZED and
    // handed to a submitter that would refuse it, leaving a false record
    // of authorization behind. So the decision is made again, now that
    // the facts exist.
    const { count: blockedNow } = await db.from("application_answers")
      .select("id", { count: "exact", head: true })
      .eq("application_id", app.id).eq("confidence_state", "BLOCKED");
    const { data: resume } = app.resume_id
      ? await db.from("resumes").select("artifact_sha256,content_sha256").eq("id", app.resume_id).maybeSingle()
      : { data: null };

    const real = decide({
      jobId: w.job.id, companyId: w.job.company_id, provider: w.job.source,
      candidacy: candidacyOf.get(w.job.id) ?? null,
      candidacyReasonCode: candidacyRowOf.get(w.job.id)?.reason_codes?.[0] ?? null,
      hardMet: candidacyRowOf.get(w.job.id)?.hard_met ?? null,
      hardTotal: candidacyRowOf.get(w.job.id)?.hard_total ?? null,
      eligibility: w.job.eligibility,
      fit: null, baseSalaryMin: w.job.salary_min ?? null,
      allFieldsConfident: Boolean(app.all_fields_confident),
      blockedAnswers: blockedNow ?? 0,
      resumeClaimsAllGrounded: true,
      artifactValid: Boolean(resume?.artifact_sha256),
      submittedToday,
    }, policy, await readSwitches(db));

    if (real.action !== "SUBMIT") {
      handedOff++;
      results.push({ company, title: w.job.title, action: "REVIEW", outcome: `held after preparation: ${real.why}` });
      console.log(`  held after preparation: ${real.why}`);
      continue;
    }

    // 4. Authorize, honestly. human_approved is never touched.
    const snapshot = { policy, switches: now, decidedAt: new Date().toISOString(), why: real.why };
    // Authorization binds to the exact document, exactly as your own
    // approval does. Without this the application would be authorized
    // while the browser uploaded whatever it happened to render later.
    if (!resume?.artifact_sha256) {
      handedOff++;
      results.push({ company, title: w.job.title, action: "REVIEW", outcome: "no rendered resume to bind" });
      console.log(`  held: there is no rendered resume artifact to bind authorization to`);
      continue;
    }
    const { error: authErr } = await db.from("applications").update({
      authorization_mode: "POLICY_AUTHORIZED",
      policy_authorized_at: new Date().toISOString(),
      policy_snapshot: snapshot,
      approved_artifact_sha256: resume.artifact_sha256,
      approved_content_sha256: resume.content_sha256 ?? null,
      // The submitter requires READY_TO_SUBMIT. Nothing else moves an
      // application there without a person, which is why the automatic
      // path stopped here before this existed.
      status: "READY_TO_SUBMIT",
    }).eq("id", app.id);
    if (authErr) {
      failed++; results.push({ company, title: w.job.title, action: "SUBMIT", outcome: `authorization failed: ${authErr.message}` });
      console.log(`  FAILED to authorize: ${authErr.message}`);
      continue;
    }
    await db.from("application_events").insert({
      application_id: app.id, event: "POLICY_AUTHORIZED",
      detail: `Authorized by automation policy, not by a person. ${w.disposition.why}. `
        + `No one reviewed this application. The policy in force is recorded in policy_snapshot.`,
      actor: "worker",
    });

    // 5. Submit. Every safety gate lives inside this script.
    const r = await isolated("submit", ["scripts/submit-application.ts", app.id], 20 * 60_000);
    const { data: after } = await db.from("applications").select("status,submitted_at").eq("id", app.id).single();
    if (after?.submitted_at) {
      submitted++;
      results.push({ company, title: w.job.title, action: "SUBMIT", outcome: `SUBMITTED ${after.submitted_at}` });
      console.log(`  SUBMITTED and confirmed`);
    } else {
      handedOff++;
      results.push({ company, title: w.job.title, action: "SUBMIT", outcome: `stopped: ${r.tail.slice(0, 160)}` });
      console.log(`  stopped without confirmation; left recoverable`);
    }
  } catch (err) {
    // The isolation of last resort. One application throwing must never
    // end the batch.
    failed++;
    results.push({ company, title: w.job.title, action: w.disposition.action, outcome: `error: ${(err as Error).message}` });
    console.log(`  ERROR: ${(err as Error).message}`);
  }
}

console.log(`\n${"-".repeat(60)}`);
console.log(`prepared ${prepared} · submitted ${submitted} · routed to review or held ${handedOff} · failed ${failed}`);
for (const r of results) console.log(`  ${r.action.padEnd(6)} ${r.company.slice(0, 22).padEnd(24)} ${r.title.slice(0, 40).padEnd(42)} ${r.outcome.slice(0, 60)}`);
