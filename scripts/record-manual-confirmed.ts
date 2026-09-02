/**
 * Records a submission a person completed on the employer's site.
 *
 * The database function of the same name holds every guard it can check
 * itself. This adds the one it cannot: that the confirmation evidence
 * actually exists on disk. A reference to a directory that is not there
 * is not evidence.
 *
 *   node scripts/record-manual-confirmed.ts <application_id> <iso-time> <fill-run:dir> "<what you saw>"
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const [applicationId, submittedAt, reference, sawText] = process.argv.slice(2);
if (!applicationId || !submittedAt || !reference || !sawText) {
  console.error('usage: record-manual-confirmed.ts <application_id> <iso-time> <fill-run:dir> "<what you saw>"');
  process.exit(2);
}
if (Number.isNaN(Date.parse(submittedAt))) { console.error("unparseable time"); process.exit(2); }

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

// The guard the database cannot perform.
const dir = `.fill-runs/${reference.replace(/^fill-run:/, "")}`;
if (!existsSync(dir)) { console.error(`evidence does not resolve: ${dir}`); process.exit(1); }
const files = readdirSync(dir);
const shots = files.filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
if (shots.length === 0) { console.error(`no confirmation image in ${dir}`); process.exit(1); }
console.log(`evidence resolves: ${dir}`);
for (const f of shots) {
  const h = createHash("sha256").update(readFileSync(`${dir}/${f}`)).digest("hex");
  console.log(`  ${f}  ${statSync(`${dir}/${f}`).size} bytes  sha256 ${h}`);
}

const { data: before } = await db.from("applications")
  .select("status,submission_mode,submitted_at,resume_id,all_fields_confident,human_approved,approved_artifact_sha256")
  .eq("id", applicationId).single();
if (!before) { console.error("no such application"); process.exit(1); }
console.log(`\nbefore: ${JSON.stringify(before)}`);

// Artifact integrity, where an artifact was used.
if (before.resume_id) {
  const { data: r } = await db.from("resumes").select("artifact_sha256").eq("id", before.resume_id).maybeSingle();
  if (before.approved_artifact_sha256 && r?.artifact_sha256 !== before.approved_artifact_sha256) {
    console.error(`REFUSING: the bound artifact ${r?.artifact_sha256} is not the approved ${before.approved_artifact_sha256}`);
    process.exit(1);
  }
  console.log(`artifact integrity: ${r?.artifact_sha256?.slice(0, 20)}... matches approval`);
}

// submission_mode must already say MANUAL; the function refuses otherwise.
if (before.submission_mode !== "MANUAL") {
  const { error } = await db.from("applications").update({ submission_mode: "MANUAL" }).eq("id", applicationId);
  if (error) { console.error(error.message); process.exit(1); }
  console.log("submission_mode set to MANUAL (the final submit was made by a person)");
}

const detail = [
  `Submitted by hand on ${new Date(submittedAt).toISOString()} and confirmed by the person who did it.`,
  "",
  `Confirmation seen: ${JSON.stringify(sawText)}`,
  "",
  "Provenance: HUMAN_CONFIRMED. The final submit click was made by a person, not by this system.",
  "No submit click was made by the automation and no confirmation was captured programmatically;",
  "the text above is the applicant's own account, evidenced by the screenshot below.",
  "",
  `Evidence: ${dir}`,
  ...shots.map((f) => `  ${f} sha256 ${createHash("sha256").update(readFileSync(`${dir}/${f}`)).digest("hex")}`),
  "",
  "Recorded through the manual-confirmation path: this application never reached",
  "READY_TO_SUBMIT, all_fields_confident is untouched, and it was never eligible for the",
  "automated worker.",
].join("\n");

const { error } = await db.rpc("record_manual_submission", {
  p_application_id: applicationId,
  p_submitted_at: new Date(submittedAt).toISOString(),
  p_confirmation_reference: reference,
  p_detail: detail,
});
if (error) { console.error(`refused: ${error.message}`); process.exit(1); }

const { data: after } = await db.from("applications")
  .select("status,submitted_at,submission_mode,confirmation_reference,confirmation_email_received,submit_outcome,all_fields_confident")
  .eq("id", applicationId).single();
if (!after) { console.error("could not re-read the application"); process.exit(1); }
console.log(`after:  ${JSON.stringify(after)}`);
console.log(`all_fields_confident unchanged: ${before.all_fields_confident === after.all_fields_confident}`);
