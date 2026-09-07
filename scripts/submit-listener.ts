/**
 * Watches for submission requests you make in the portal.
 *
 *   node scripts/submit-listener.ts            run in the foreground
 *   node scripts/submit-listener.ts --once     one poll, for testing
 *
 * The portal cannot submit anything: it has no browser, no Playwright and
 * no credentials, and it is deliberately going to stay that way. What it
 * can do is write a row. This process, on your Mac, watches for that row
 * and does the work. Supabase is the only thing between them, so nothing
 * inbound is ever exposed on this machine and Vercel never reaches it.
 *
 * Deliberately narrow. It polls one indexed predicate on one table,
 * every few seconds. It does not discover jobs, ingest, score, or decide
 * anything: the 06:30 pipeline still owns all of that, unchanged.
 *
 * Claiming is atomic. Two listeners running by accident cannot both
 * submit the same application, because the claim is a single UPDATE
 * whose WHERE clause includes "nobody has claimed this yet", and the
 * database decides who won.
 */
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { parseStopDetail, resolveStopRecord, formatStopDetail, assertStopRecorded, STOP_EVENT }
  from "../lib/applications/stopReason.ts";
import { readSwitches } from "../lib/automation/policy.ts";
import { classifyOutcome } from "../lib/applications/submitOutcome.ts";

const once = process.argv.includes("--once");
const POLL_MS = 5_000;
/** A claim older than this was left by a process that died. */
const STALE_CLAIM_MS = 30 * 60_000;
/** The least time between two submit clicks from this machine. */
const MIN_GAP_BETWEEN_SUBMITS_MS = 4 * 60_000;

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);

/** Runs the real submitter, isolated. A crash here must not end the loop. */
function runSubmitter(applicationId: string): Promise<{ ok: boolean; tail: string; timedOut: boolean }> {
  return new Promise((done) => {
    const child = // process.execPath, not "node": launchd runs with a minimal PATH
    // that does not include /usr/local/bin, so a bare "node" is ENOENT
    // under the scheduler while working perfectly in a terminal.
    spawn(process.execPath, ["scripts/submit-application.ts", applicationId], { cwd: ROOT, env: process.env });
    let out = "";
    const cap = (d: Buffer) => { out += d.toString(); if (out.length > 20_000) out = out.slice(-20_000); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    // Remembered rather than inferred: a SIGKILL at the wall clock and a
    // clean non-zero exit both arrive here as "close", and only this flag
    // separates "we ran out of time" from "it decided to stop".
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 20 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, tail: out.trim().split("\n").slice(-3).join(" | ").slice(0, 300), timedOut });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ ok: false, tail: `could not start: ${e.message}`, timedOut: false });
    });
  });
}

async function poll(): Promise<void> {
  // Release claims left behind by a process that died mid-run, so a
  // crashed listener does not strand a request forever.
  const stale = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  await db.from("applications")
    .update({ submit_started_at: null })
    .not("submit_requested_at", "is", null)
    .is("submitted_at", null)
    .lt("submit_started_at", stale);

  // Only requests whose hold has passed. A person's approval is batched
  // for the next scheduled run (submit_not_before); "Apply now" in the
  // portal moves that to the present; a null hold runs at once.
  const { data: waiting, error } = await db.from("applications")
    .select("id,job_id,human_approved,authorization_mode,all_fields_confident,status")
    .not("submit_requested_at", "is", null)
    .is("submit_started_at", null)
    .is("submitted_at", null)
    .or(`submit_not_before.is.null,submit_not_before.lte.${new Date().toISOString()}`)
    .order("submit_not_before", { ascending: true, nullsFirst: true })
    .limit(5);
  if (error) { log(`query failed: ${error.message}`); return; }
  if (!waiting?.length) return;

  // Applications are sent one per poll, and never within a few minutes of
  // the last one. Four submissions from one browser inside ten minutes is
  // a pattern an ATS spam filter reads as a bot; spacing them is what a
  // person's afternoon of applying looks like, and the queue loses
  // nothing -- the next request goes on the next poll after the gap.
  const { data: last } = await db.from("applications").select("submit_click_attempted_at")
    .not("submit_click_attempted_at", "is", null).order("submit_click_attempted_at", { ascending: false }).limit(1);
  const lastClick = last?.[0]?.submit_click_attempted_at ? Date.parse(last[0].submit_click_attempted_at) : 0;
  if (Date.now() - lastClick < MIN_GAP_BETWEEN_SUBMITS_MS) {
    return;                                        // not yet; the request stays queued
  }

  for (const app of waiting.slice(0, 1)) {
    try {
      // The switches are read per request, not per process, so pausing in
      // the portal takes effect on the next request rather than on the
      // next restart.
      const { data: job } = await db.from("jobs").select("source,title").eq("id", app.job_id).single();
      const switches = await readSwitches(db);
      const provider = switches.byProvider[job?.source ?? ""];
      if (!provider || provider.capability !== "PRODUCTION" || provider.paused) {
        log(`${job?.title?.slice(0, 40)}: ${job?.source} is ${provider?.paused ? "paused" : "not PRODUCTION"}; clearing the request`);
        await db.from("applications")
          .update({
            submit_requested_at: null, submit_started_at: null,
            submit_outcome: "DECLINED", submit_outcome_at: new Date().toISOString(),
          }).eq("id", app.id);
        await db.from("application_events").insert({
          application_id: app.id, event: "SUBMIT_REQUEST_DECLINED",
          detail: `The request was not run because ${job?.source} is `
            + `${provider?.paused ? "paused" : `capability ${provider?.capability ?? "unknown"}`}. `
            + `Nothing was attempted. Unpause it and ask again.`,
          actor: "worker",
        });
        continue;
      }

      // Atomic claim. The WHERE clause carries "still unclaimed", so if a
      // second listener is running, exactly one of them gets a row back.
      const { data: claimed } = await db.from("applications")
        .update({ submit_started_at: new Date().toISOString() })
        .eq("id", app.id)
        .not("submit_requested_at", "is", null)
        .is("submit_started_at", null)
        .select("id");
      if (!claimed?.length) continue;              // somebody else has it
      // Anything stamped before this belongs to an earlier run.
      const claimedAt = new Date().toISOString();

      log(`claimed ${job?.title?.slice(0, 50)} (${app.human_approved ? "HUMAN_APPROVED" : app.authorization_mode ?? "unauthorized"})`);
      const r = await runSubmitter(app.id);

      const { data: after } = await db.from("applications")
        .select("submitted_at,status,submit_click_attempted_at").eq("id", app.id).single();

      // What happened, judged on whether the irreversible click may have
      // occurred rather than on how the run ended. runSubmitter resolves
      // the same way for a clean exit and for a SIGKILL at the timeout,
      // so the click marker is the only thing that separates them.
      const { outcome, reason } = classifyOutcome({
        submittedAt: after?.submitted_at ?? null,
        clickAttemptedAt: after?.submit_click_attempted_at ?? null,
        claimedAt,
      });

      // ---- the reason goes on the record BEFORE the request is cleared ----
      //
      // Ordering is the whole point. Clearing submit_requested_at is what
      // makes the run irretrievable: the next tick will not pick it up and
      // nothing else remembers what happened. If the reason were written
      // after, a crash in between would leave exactly the state that
      // started this work — an outcome with no cause, and no way to learn
      // one except by going back to the employer.
      if (outcome === "SAFE_STOP") {
        // The runner records its own stop, from the code standing at the
        // failure. Only stops from THIS claim count; an event from an
        // earlier run describes an earlier run.
        const { data: stops } = await db.from("application_events")
          .select("detail,occurred_at").eq("application_id", app.id).eq("event", STOP_EVENT)
          .gte("occurred_at", claimedAt).order("occurred_at", { ascending: false }).limit(1);
        const recorded = parseStopDetail(stops?.[0]?.detail ?? null);
        const record = resolveStopRecord({ recorded, ok: r.ok, tail: r.tail, timedOut: r.timedOut });
        assertStopRecorded(outcome, record);
        // Written only when the runner could not: otherwise its own event
        // already stands and a second one would just be an echo.
        if (!recorded) {
          await db.from("application_events").insert({
            application_id: app.id, event: STOP_EVENT, actor: "worker",
            detail: formatStopDetail(record),
          });
        }
        log(`  stop: ${record.code} @ ${record.stage}${record.pageReached ? ` (${record.url})` : " (no page)"}`);
      }

      // Cleared either way: a request that has been acted on must not be
      // picked up again on the next tick. The outcome is written in the
      // same statement, so the portal never sees a cleared request with
      // a stale outcome beside it.
      await db.from("applications")
        .update({
          submit_requested_at: null, submit_started_at: null,
          submit_outcome: outcome, submit_outcome_at: new Date().toISOString(),
        }).eq("id", app.id);

      if (outcome === "AMBIGUOUS") {
        await db.from("application_events").insert({
          application_id: app.id, event: "SUBMIT_OUTCOME_AMBIGUOUS", actor: "worker",
          detail: `${reason}. The run ended without a recorded confirmation after the submit `
            + `click at ${after?.submit_click_attempted_at}. Nothing has been marked submitted `
            + `and no retry is offered: a person has to establish whether the employer received `
            + `this. Worker tail: ${r.tail.slice(0, 200)}`,
        });
      }
      log(`${outcome}: ${job?.title?.slice(0, 50)} - ${reason}`);
    } catch (err) {
      // One bad request must never end the listener.
      log(`request ${app.id} failed: ${(err as Error).message}`);
      // The listener itself failed, so it cannot say whether the click
      // happened. Re-read the marker and classify honestly rather than
      // assuming the safe answer.
      const { data: post } = await db.from("applications")
        .select("submitted_at,submit_click_attempted_at").eq("id", app.id).single();
      const { outcome } = classifyOutcome({
        submittedAt: post?.submitted_at ?? null,
        clickAttemptedAt: post?.submit_click_attempted_at ?? null,
        claimedAt: new Date(Date.now() - 25 * 60_000).toISOString(),
      });
      // The listener itself is the thing that broke, so it writes the
      // reason before clearing here too. Same ordering, same invariant.
      if (outcome === "SAFE_STOP") {
        const { data: stops } = await db.from("application_events")
          .select("detail").eq("application_id", app.id).eq("event", STOP_EVENT)
          .order("occurred_at", { ascending: false }).limit(1);
        if (!parseStopDetail(stops?.[0]?.detail ?? null)) {
          await db.from("application_events").insert({
            application_id: app.id, event: STOP_EVENT, actor: "worker",
            detail: formatStopDetail({
              code: "RUNNER_CRASHED", stage: "launch", pageReached: false,
              detail: `The listener failed while running this request: ${(err as Error).message}`,
            }),
          }).then(() => undefined, () => undefined);
        }
      }
      await db.from("applications")
        .update({
          submit_requested_at: null, submit_started_at: null,
          submit_outcome: outcome, submit_outcome_at: new Date().toISOString(),
        }).eq("id", app.id)
        .then(() => undefined, () => undefined);
    }
  }
}

log(`listening for submission requests every ${POLL_MS / 1000}s`);
log(`the 06:30 pipeline is unaffected; this watches one predicate on one table`);
if (once) { await poll(); process.exit(0); }

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { stopping = true; log("stopping"); process.exit(0); });
}
for (;;) {
  try { await poll(); } catch (e) { log(`poll failed: ${(e as Error).message}`); }
  if (stopping) break;
  await new Promise((r) => setTimeout(r, POLL_MS));
}
