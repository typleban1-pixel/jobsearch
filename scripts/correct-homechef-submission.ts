/**
 * Records the Home Chef Category Manager submission that actually happened.
 *
 * The application was submitted on 2026-09-02T00:26:26.540Z and the
 * employer returned its confirmation page. The run withheld the record
 * because the confirmation page also offers "Sign in to MyGreenhouse" to
 * track the application, and the login heuristic read that as a barrier.
 * The submission itself was never in doubt; only the bookkeeping was.
 *
 * History is appended to, never rewritten: the earlier attempt events
 * stay exactly as they are.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const APP = "103bb5b5-bf4c-4b36-a21b-c274c67e6615";
const EVIDENCE = "fill-run:submit-103bb5b5-bf4c-4b36-a21b-c274c67e6615-1788308733342";
const SUBMITTED_AT = "2026-09-02T00:26:26.540Z";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const { data: before } = await db.from("applications")
  .select("status,submitted_at,confirmation_reference").eq("id", APP).single();
console.log("before:", JSON.stringify(before));

const { error } = await db.from("applications").update({
  status: "SUBMITTED",
  submitted_at: SUBMITTED_AT,
  submission_mode: "ASSISTED",
  confirmation_reference: EVIDENCE,
}).eq("id", APP);
if (error) { console.error("update failed:", error.message); process.exit(1); }

const detail = [
  "Home Chef confirmed receipt at 2026-09-02T00:26:26.540Z.",
  "",
  "Confirmation URL: https://job-boards.greenhouse.io/embed/job_app/confirmation?for=homechef&token=5286389008",
  "Form controls: 21 -> 0",
  "success_signal: true",
  "verification: NO_CHALLENGE",
  "",
  'Employer text: "Thank you for applying! We appreciate your interest and will review your application soon. In the meantime, check out our tasty meals at HomeChef.com!"',
  "",
  "The run first recorded this as unconfirmed. That was a false negative:",
  'the confirmation page carries an optional "Sign in to MyGreenhouse to keep',
  'tabs on your application" tracking card, and the login heuristic treated the',
  "words as a sign-in wall. The screenshot 11-after-submit.png shows a completed",
  "submission with no form remaining. The heuristic now only reports a sign-in",
  "problem when the page shows no success signal.",
  "",
  `Evidence: .fill-runs/submit-103bb5b5-bf4c-4b36-a21b-c274c67e6615-1788308733342`,
  "(01-loaded, 02-uploaded, 03-filled, 10-before-submit, 11-after-submit, submission-evidence.json).",
  "No email confirmation has been received; confirmation_email_received stays false.",
].join("\n");

const { error: evErr } = await db.from("application_events").insert({
  application_id: APP, event: "SUBMIT_CONFIRMED", actor: "system", detail,
});
if (evErr) { console.error("event insert failed:", evErr.message); process.exit(1); }

const { data: after } = await db.from("applications")
  .select("status,submitted_at,submission_mode,confirmation_reference,confirmation_email_received,human_approved")
  .eq("id", APP).single();
console.log("after: ", JSON.stringify(after));
