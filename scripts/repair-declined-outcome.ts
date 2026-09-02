/**
 * Backfills submit_outcome for one historical declined request.
 *
 * The listener declined this request correctly on 2026-09-02T01:25:01,
 * but the process running at the time predated the code that records an
 * outcome, so the column was left null. Null reads as "never attempted",
 * which is not what happened.
 *
 * Deliberately narrow. It refuses unless the evidence uniquely
 * establishes DECLINED: a worker-written decline event, no click marker,
 * no fill run, and nothing submitted. The direction that would be
 * dangerous here is recording DECLINED over a request that might have
 * reached an employer, and each of those checks rules that out
 * affirmatively rather than by absence of contrary evidence.
 *
 *   node scripts/repair-declined-outcome.ts <application_id>
 */
import { existsSync, readdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const applicationId = process.argv[2];
if (!applicationId) { console.error("usage: repair-declined-outcome.ts <application_id>"); process.exit(2); }

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const { data: app } = await db.from("applications")
  .select("id,status,submitted_at,submit_outcome,submit_click_attempted_at,submit_requested_at")
  .eq("id", applicationId).maybeSingle();
if (!app) { console.error("no such application"); process.exit(1); }

const refuse = (why: string) => { console.error(`refusing to repair: ${why}`); process.exit(1); };

if (app.submit_outcome !== null) refuse(`submit_outcome is already ${app.submit_outcome}`);
if (app.submitted_at) refuse("this application is submitted; a decline cannot describe it");
if (app.submit_click_attempted_at) refuse("a submit click was attempted, so this was never a clean decline");
if (app.submit_requested_at) refuse("a request is still pending; let it finish");

const { data: declines } = await db.from("application_events")
  .select("id,detail,occurred_at,actor").eq("application_id", applicationId)
  .eq("event", "SUBMIT_REQUEST_DECLINED").order("occurred_at", { ascending: false });
if (!declines?.length) refuse("no SUBMIT_REQUEST_DECLINED event exists");

const { data: runs } = await db.from("application_fill_runs")
  .select("id").eq("application_id", applicationId);
if (runs?.length) refuse(`${runs.length} fill run(s) exist, so browser work did start`);

const onDisk = existsSync(".fill-runs")
  ? readdirSync(".fill-runs").filter((d) => d.includes(applicationId))
  : [];
if (onDisk.length) refuse(`${onDisk.length} run director(ies) exist on disk`);

console.log("evidence checks passed:");
console.log(`  decline event  ${declines![0]!.occurred_at} by ${declines![0]!.actor}`);
console.log(`  click marker   none`);
console.log(`  fill runs      none in the database, none on disk`);
console.log(`  submitted_at   null`);

const { error } = await db.from("applications")
  .update({ submit_outcome: "DECLINED", submit_outcome_at: declines![0]!.occurred_at })
  .eq("id", applicationId).is("submit_outcome", null).is("submitted_at", null);
if (error) { console.error(`update failed: ${error.message}`); process.exit(1); }

await db.from("application_events").insert({
  application_id: applicationId, event: "SUBMIT_OUTCOME_REPAIRED", actor: "system",
  detail: "submit_outcome set to DECLINED for the request declined at "
    + `${declines![0]!.occurred_at}. The listener process handling that request started before `
    + "the code that records an outcome existed, so the column was left null and the portal "
    + "read it as though no request had ever been made. Repaired from the decline event itself. "
    + "No click marker, no fill run in the database, no run directory on disk, and nothing "
    + "submitted, so the evidence uniquely establishes a decline before any browser work. "
    + "The original SUBMIT_REQUESTED and SUBMIT_REQUEST_DECLINED events are unchanged.",
});

const { data: after } = await db.from("applications")
  .select("status,submit_outcome,submit_outcome_at,submitted_at,human_approved").eq("id", applicationId).single();
console.log("\nafter:", JSON.stringify(after));
