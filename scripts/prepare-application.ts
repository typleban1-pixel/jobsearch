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
import { liveSnapshot } from "../lib/browser/prepareSnapshot.ts";
import { prepareApplication } from "../lib/applications/prepare.ts";
import { AnthropicProvider } from "../lib/llm/anthropic.ts";

const jobId = process.argv[2];
if (!jobId) { console.error("usage: node scripts/prepare-application.ts <job_id> [--write] [--no-llm] [--application <id>]"); process.exit(2); }
const write = process.argv.includes("--write");
// Re-prepare an application that already exists for this job (a new form
// snapshot, a new mapping) instead of refusing because one is live. The
// same path the portal's re-prepare and reprepare-stale.ts take; approval
// does not survive it, by design.
const existingArg = process.argv.indexOf("--application");
const existingApplicationId = existingArg >= 0 ? process.argv[existingArg + 1] ?? null : null;
const useLlm = !process.argv.includes("--no-llm") && Boolean(optional("ANTHROPIC_API_KEY"));

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const llm = useLlm ? new AnthropicProvider() : null;

// Lever and Ashby publish no form, so preparation opens a browser. The
// dispatcher is passed in rather than imported by prepare.ts, which must
// stay free of Playwright because the portal calls into the same module.
const result = await prepareApplication(db, jobId, llm, {
  ...(existingApplicationId ? { existingApplicationId } : {}),
  liveSnapshot: async (job) => {
    if (job.applyUrl && (job.source === "LEVER" || job.source === "ASHBY")) {
      console.log(`  opening the live ${job.source} form to snapshot it: ${job.applyUrl}`);
    }
    return liveSnapshot(job);
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
