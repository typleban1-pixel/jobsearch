/**
 * Recording a submission a person made by hand.
 *
 * Distinct from every automated path. The system did not drive this
 * browser, did not click submit, and captured no confirmation: it handed
 * off because the employer's form required a human, and a person
 * finished it. The record has to say that plainly, because "submitted"
 * on its own would later read as though the automation had done it.
 *
 * What it will not do: invent automated evidence. No fill run is
 * referenced, no page text is quoted, and confirmation provenance is
 * recorded as HUMAN_CONFIRMED.
 *
 *   node scripts/record-manual-submission.ts <application_id> <iso-time> "<what you saw>" [reason]
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const [applicationId, submittedAt, sawText, reason] = process.argv.slice(2);
if (!applicationId || !submittedAt || !sawText) {
  console.error('usage: record-manual-submission.ts <application_id> <iso-time> "<what you saw>" [reason]');
  process.exit(2);
}
if (Number.isNaN(Date.parse(submittedAt))) { console.error("unparseable time"); process.exit(2); }

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const { data: app } = await db.from("applications")
  .select("id,job_id,status,submitted_at,human_approved,human_approved_at,approved_artifact_sha256,approved_answers_sha256,submit_click_attempted_at")
  .eq("id", applicationId).maybeSingle();
if (!app) { console.error("no such application"); process.exit(1); }
if (app.submitted_at) { console.error(`already submitted at ${app.submitted_at}`); process.exit(1); }

// A manual submission still has to be one a person approved. This is not
// a way to record a submission of something never reviewed.
if (!app.human_approved) { console.error("this application was never approved; refusing"); process.exit(1); }

// The automation must not have clicked. If it had, this would be the
// ambiguous case and belongs in the resolve-ambiguous workflow instead.
if (app.submit_click_attempted_at) {
  console.error("the automation attempted a submit click on this application; use the ambiguity workflow, not this");
  process.exit(1);
}

const { data: job } = await db.from("jobs")
  .select("title,source,canonical_opening_id,company_id").eq("id", app.job_id).single();
const { data: company } = await db.from("companies").select("name").eq("id", job!.company_id).single();

// Duplicate protection applies to a hand submission exactly as it does
// to an automated one.
const { data: submitted } = await db.from("applications")
  .select("id,job_id").not("submitted_at", "is", null);
const otherIds = (submitted ?? []).filter((s: any) => s.id !== applicationId).map((s: any) => s.job_id);
if (otherIds.length) {
  const { data: otherJobs } = await db.from("jobs").select("canonical_opening_id").in("id", otherIds);
  if ((otherJobs ?? []).some((j: any) => j.canonical_opening_id === job!.canonical_opening_id)) {
    console.error("another application on this opening is already submitted; refusing");
    process.exit(1);
  }
}

const { error } = await db.from("applications").update({
  status: "SUBMITTED",
  submitted_at: new Date(submittedAt).toISOString(),
  // MANUAL, not ASSISTED: the system opened no browser for this.
  submission_mode: "MANUAL",
  // No automated artifact exists, and none is invented. The event below
  // carries what the person actually saw.
  confirmation_reference: `human-confirmed:${new Date(submittedAt).toISOString()}`,
  confirmation_email_received: false,
  submit_outcome: "CONFIRMED",
  submit_outcome_at: new Date().toISOString(),
}).eq("id", applicationId).is("submitted_at", null);
if (error) { console.error(`update failed: ${error.message}`); process.exit(1); }

await db.from("application_events").insert({
  application_id: applicationId, event: "SUBMISSION_CONFIRMED_BY_USER", actor: "user:plebantyler@gmail.com",
  detail: [
    `Submitted by hand on ${new Date(submittedAt).toISOString()} and confirmed by the person who did it.`,
    "",
    `Confirmation seen: ${JSON.stringify(sawText)}`,
    "",
    `Why it was manual: ${reason ?? "the employer's form required a human-presence check the system will not attempt"}.`,
    "",
    "Provenance: HUMAN_CONFIRMED. This was NOT an automated submission. No browser was driven,",
    "no submit click was made by the system, no fill run exists, and no page text was captured",
    "programmatically. The confirmation above is the person's own account of what the employer",
    "displayed, and is deliberately not presented as machine-verified evidence.",
    "",
    `The approved package is unchanged and still binds this submission: artifact `
      + `${app.approved_artifact_sha256}, answers ${app.approved_answers_sha256}, approved `
      + `${app.human_approved_at}.`,
  ].join("\n"),
});

const { data: after } = await db.from("applications")
  .select("status,submitted_at,submission_mode,confirmation_reference,confirmation_email_received,submit_outcome,human_approved")
  .eq("id", applicationId).single();
console.log(`${company?.name} — ${job?.title} (${job?.source})`);
console.log(JSON.stringify(after, null, 1));
