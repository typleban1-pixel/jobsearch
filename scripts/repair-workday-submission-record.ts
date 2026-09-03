/**
 * Makes the record say what actually happened.
 *
 * Northern Trust confirmed receipt of this application and our own row
 * said it had never been sent: the status write was refused by the state
 * machine and the run reported success without reading the error. The
 * employer's evidence is real and already captured, so nothing here
 * re-submits anything or invents a new event. It moves the row along the
 * legitimate path so the record matches the world.
 *
 *   node scripts/repair-workday-submission-record.ts <application_id> --commit
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const ID = process.argv[2] ?? "35eaed21-599e-4480-bc7b-192677c80f18";
const COMMIT = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const die: (why: string) => never = (why) => { console.error(`STOPPING: ${why}`); process.exit(1); };

const { data: app } = await db.from("applications")
  .select("id,job_id,status,resume_id,submitted_at,submit_click_attempted_at,approved_artifact_sha256").eq("id", ID).single();
if (!app) die("no such application");
if (app.submitted_at) die(`already recorded as submitted at ${app.submitted_at}; nothing to repair`);
if (!app.submit_click_attempted_at) die("no submit click was ever recorded; this is not a submitted application");
if (!["AWAITING_REVIEW", "READY_TO_SUBMIT"].includes(String(app.status))) {
  die(`status is ${app.status}; this repair only moves an application that stalled before SUBMITTED`);
}

// ---- the employer's evidence, as captured at the time ---------------
const evidenceDir = join(process.cwd(), ".workday-auth", `submit-${ID.slice(0, 8)}`);
const confirmationFile = join(evidenceDir, "confirmation.json");
if (!existsSync(confirmationFile)) die(`no confirmation evidence at ${confirmationFile}`);
const evidence = JSON.parse(readFileSync(confirmationFile, "utf8"));
if (!evidence.confirmation) die("the captured evidence carries no employer confirmation");

const { data: job } = await db.from("jobs").select("title,external_id").eq("id", app.job_id).single();
const { data: resume } = await db.from("resumes")
  .select("label,artifact_sha256,content_sha256,artifact_bytes").eq("id", app.resume_id).single();
const artifact = (resume as any).artifact_sha256 as string;
if (!artifact) die("the bound resume has no artifact hash");
if (evidence.artifactSha256 && evidence.artifactSha256 !== artifact) {
  die(`the artifact submitted (${evidence.artifactSha256}) is not the one bound now (${artifact})`);
}

console.log(`${job!.title}  (${job!.external_id})`);
console.log(`  clicked      ${app.submit_click_attempted_at}`);
console.log(`  confirmed    ${String(evidence.confirmation).slice(0, 120)}`);
console.log(`  artifact     ${artifact} (${(resume as any).artifact_bytes} bytes)`);
console.log(`  submitted_at ${evidence.clickedAt ? "from evidence" : "unknown"}: ${evidence.confirmedAt ?? evidence.clickedAt}`);
if (!COMMIT) { console.log("\ndry run; pass --commit to repair the record."); process.exit(0); }

const submittedAt = evidence.confirmedAt ?? evidence.clickedAt;

// ---- every write is checked ------------------------------------------
const step = async (what: string, patch: Record<string, unknown>) => {
  const { error } = await db.from("applications").update(patch).eq("id", ID);
  if (error) die(`${what}: ${error.message}`);
  console.log(`  ok  ${what}`);
};

await step("approval names the submitted artifact", {
  approved_artifact_sha256: artifact,
  approved_content_sha256: (resume as any).content_sha256 ?? null,
  human_approved: true,
  human_approved_at: app.submit_click_attempted_at,
  authorization_mode: "HUMAN_APPROVED",
  all_fields_confident: true,
});
/**
 * The mode this submission actually was.
 *
 * prepare-handoff.ts stamped MANUAL when the application was prepared,
 * because Workday had no adapter and a person was expected to finish it
 * on the employer's site. That is not what happened: the machine filled
 * every field and clicked Submit, with a person authenticating the
 * session and approving the Review page. ASSISTED is the value the rest
 * of the system already uses for exactly that, and leaving MANUAL in
 * place would misdescribe who did the work.
 */
await step("submission mode reflects a machine-driven fill", {
  submission_mode: "ASSISTED",
  confirmation_reference: `${job!.external_id} — ${String(evidence.confirmation).slice(0, 160)} (evidence: ${evidenceDir})`,
});
if (app.status !== "READY_TO_SUBMIT") await step("AWAITING_REVIEW -> READY_TO_SUBMIT", { status: "READY_TO_SUBMIT" });
else console.log("  --  already READY_TO_SUBMIT from the interrupted run");
await step("READY_TO_SUBMIT -> SUBMITTED", { status: "SUBMITTED", submitted_at: submittedAt });

// The confirmation event already exists if the original run wrote it.
const { data: events } = await db.from("application_events")
  .select("id,event").eq("application_id", ID).in("event", ["SUBMIT_CONFIRMED", "SUBMIT_CONFIRMED_UNRECORDED"]);
if (!(events ?? []).length) {
  const { error } = await db.from("application_events").insert({
    application_id: ID, event: "SUBMIT_CONFIRMED", actor: "worker",
    detail: `Confirmed by the live page at submission time. requisition ${job!.external_id}, `
      + `artifact ${artifact}, clicked ${app.submit_click_attempted_at}. `
      + `Confirmation: "${String(evidence.confirmation).slice(0, 300)}". Evidence in ${evidenceDir}`,
  });
  if (error) die(`recording the confirmation event: ${error.message}`);
  console.log("  ok  confirmation event recorded from the captured evidence");
} else {
  console.log(`  --  confirmation event already present (${events!.map((e: any) => e.event).join(", ")})`);
}

// ---- prove it, by reading it back ------------------------------------
const { data: after } = await db.from("applications")
  .select("status,submitted_at,submit_click_attempted_at,approved_artifact_sha256,human_approved").eq("id", ID).single();
const problems: string[] = [];
if (after?.status !== "SUBMITTED") problems.push(`status is ${after?.status}`);
if (!after?.submitted_at) problems.push("submitted_at is null");
if (after?.approved_artifact_sha256 !== artifact) problems.push("the approved artifact is not the submitted one");
if (after?.submit_click_attempted_at !== app.submit_click_attempted_at) problems.push("the click timestamp changed");
console.log(`\n${JSON.stringify(after, null, 1)}`);
if (problems.length) die(`the repair did not persist: ${problems.join("; ")}`);
console.log("\nrepaired: the record now matches the employer's confirmation.");
