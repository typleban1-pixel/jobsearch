/**
 * Writes out the exact approved PDF for one application.
 *
 * Read from the stored artifact and hash-checked against the approval,
 * so what leaves here is provably the document that was reviewed, not a
 * fresh render of the current profile.
 *
 *   node scripts/export-approved-resume.ts <application_id> [outPath]
 */
import { writeFileSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const applicationId = process.argv[2];
if (!applicationId) { console.error("usage: export-approved-resume.ts <application_id> [outPath]"); process.exit(2); }

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const { data: app } = await db.from("applications")
  .select("resume_id,approved_artifact_sha256").eq("id", applicationId).maybeSingle();
if (!app?.resume_id) { console.error("no resume bound to this application"); process.exit(1); }

const { data: resume } = await db.from("resumes")
  .select("artifact_pdf,artifact_sha256,artifact_bytes").eq("id", app.resume_id).maybeSingle();
if (!resume?.artifact_pdf) { console.error("no stored artifact"); process.exit(1); }

const out = process.argv[3] ?? `/Users/plebant/Desktop/approved-resume-${applicationId.slice(0, 8)}.pdf`;
writeFileSync(out, Buffer.from(String(resume.artifact_pdf), "base64"));

const written = createHash("sha256").update(readFileSync(out)).digest("hex");
// Two different questions, previously conflated. "Is this the stored
// artifact" is always answerable. "Is this what was approved" only has
// an answer once someone has approved something, and reporting a
// missing approval as a hash mismatch made a correct export look
// corrupt.
const matchesStored = written === resume.artifact_sha256;
console.log(`exported: ${out}`);
console.log(`bytes:    ${statSync(out).size} (stored ${resume.artifact_bytes})`);
console.log(`sha256:   ${written}`);
console.log(`matches the stored artifact: ${matchesStored}`);
if (!matchesStored) {
  console.error("REFUSING to vouch for this file: it is not the stored artifact");
  process.exit(1);
}
if (!app.approved_artifact_sha256) {
  console.log("approval:  none yet; this is the prepared artifact, not an approved one");
} else if (written === app.approved_artifact_sha256) {
  console.log("approval:  matches the approved artifact");
} else {
  console.error("REFUSING to vouch for this file: it differs from the approved artifact");
  process.exit(1);
}
