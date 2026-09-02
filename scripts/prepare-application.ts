/**
 * Prepare one application, for a job id given on the command line.
 *
 * Dry by default: without --write it runs the whole preparation and
 * prints what it would produce, without touching the database. This is
 * the difference between inspecting the mapping and creating a record
 * that then has to be withdrawn.
 */
import { createClient } from "@supabase/supabase-js";
import { required, optional } from "../lib/env.ts";
import { snapshotLeverLive } from "../lib/browser/leverPrepare.ts";
import { prepareApplication } from "../lib/applications/prepare.ts";
import { AnthropicProvider } from "../lib/llm/anthropic.ts";

const jobId = process.argv[2];
if (!jobId) { console.error("usage: node scripts/prepare-application.ts <job_id> [--write] [--no-llm]"); process.exit(2); }
const write = process.argv.includes("--write");
const useLlm = !process.argv.includes("--no-llm") && Boolean(optional("ANTHROPIC_API_KEY"));

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const llm = useLlm ? new AnthropicProvider() : null;

// Lever has no published form, so preparation opens a browser. Passed
// in rather than imported by prepare.ts, which must stay free of
// Playwright because the portal calls into the same module.
const result = await prepareApplication(db, jobId, llm, {
  liveSnapshot: async (job) => {
    if (job.source !== "LEVER" || !job.applyUrl) {
      return { ok: false, reason: `no live snapshot path for ${job.source}` };
    }
    console.log(`  opening the live Lever form to snapshot it: ${job.applyUrl}`);
    return snapshotLeverLive({ applyUrl: job.applyUrl, reviewedOffice: job.reviewedOffice });
  },
});
if (result.refusedReason) { console.log(`not prepared: ${result.refusedReason}`); process.exit(0); }

console.log(`application ${result.applicationId}  status ${result.status}`);
console.log(`  resume ${result.resumeId ?? "none"}: ${result.tailoring.accepted} lines accepted, ${result.tailoring.rejected} rejected, ${result.tailoring.fellBack} fell back to master wording`);
console.log(`  fields: ${result.answered} answered, ${result.blocked} blocked, ${result.skipped} skipped\n`);
for (const f of result.fields) {
  const mark = f.refused ? "REFUSED" : f.confidence;
  console.log(`  [${mark.padEnd(15)}] ${f.field.required ? "*" : " "} ${f.field.label.slice(0, 70)}`);
  if (f.answer) console.log(`      -> ${f.answer}`);
  if (f.blockedReason) console.log(`      x  ${f.blockedReason}`);
}
if (!write && result.applicationId) {
  await db.from("application_answers").delete().eq("application_id", result.applicationId);
  await db.from("applications").update({ status: "ABANDONED", outcome_note: "dry run" }).eq("id", result.applicationId);
  console.log("\ndry run: the application was abandoned rather than left live. pass --write to keep it.");
}
