/**
 * Re-prepares unsubmitted applications against the current master.
 *
 *   node scripts/reprepare-stale.ts            list what is stale
 *   node scripts/reprepare-stale.ts --commit   re-prepare it
 *   node scripts/reprepare-stale.ts <id> --commit
 *
 * The truth profile advanced to v15 and the master resume was recomposed
 * with it. Every unsubmitted application still carries an artifact
 * rendered from an older profile, which now contains statements the user
 * has confirmed are wrong: Genius One as a continuous contract
 * relationship, and the superseded ~100,000 email figure.
 *
 * WHAT IS AND IS NOT TOUCHED
 *
 * Submitted applications are never re-prepared. Their artifacts are the
 * documents an employer actually received and they stay exactly as they
 * are, whatever the profile says now. Correcting the record going
 * forward is not the same as rewriting what was sent, and only the first
 * is honest.
 *
 * APPROVAL DOES NOT SURVIVE A NEW DOCUMENT
 *
 * An approval is consent to send a SPECIFIC document. Re-preparing
 * produces different bytes, so the approval no longer refers to anything
 * that exists and is cleared rather than carried across. An application
 * that was READY_TO_SUBMIT goes back to review, which is the honest
 * state: nobody has read the new version yet.
 */
import { createClient } from "@supabase/supabase-js";
import { required, optional } from "../lib/env.ts";
import { prepareApplication } from "../lib/applications/prepare.ts";
import { AnthropicProvider } from "../lib/llm/anthropic.ts";

const commit = process.argv.includes("--commit");
const only = process.argv.slice(2).find((a) => !a.startsWith("--"));

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });
const llm = optional("ANTHROPIC_API_KEY") ? new AnthropicProvider() : null;

const CLOSED = ["ABANDONED", "REJECTED", "WITHDRAWN", "CLOSED"];

const { data: master } = await db.from("resumes").select("id,label").eq("is_master", true).single();
const version = Number(String(master?.label ?? "").match(/profile version (\d+)/)?.[1] ?? 0);
console.log(`current master: ${master?.label}`);
console.log(`composing against profile version ${version}\n`);

const { data: all } = await db.from("applications")
  .select("id,job_id,status,submitted_at,resume_id,is_test,human_approved,approved_artifact_sha256,form_snapshot_hash,blocked_reason")
  .is("submitted_at", null);

const stale = (all ?? []).filter((a: any) =>
  !a.is_test && !CLOSED.includes(a.status) && (!only || a.id === only));

console.log(`stale unsubmitted applications: ${stale.length}\n`);

let done = 0;
const failures: Array<{ id: string; label: string; reason: string }> = [];

for (const app of stale) {
  const { data: job } = await db.from("jobs")
    .select("id,title,source,company_id,status,eligibility").eq("id", app.job_id).single();
  const { data: company } = await db.from("companies").select("name").eq("id", job!.company_id).single();
  const label = `${company?.name} / ${String(job!.title).slice(0, 42)}`;
  console.log(`${app.id.slice(0, 8)}  ${label}  [${job!.source}]`);

  if (!commit) { console.log("   would re-prepare\n"); continue; }

  // Clear the approval FIRST. If preparation then fails, the record is
  // still honest: an approval that pointed at a document about to be
  // replaced is worse than no approval.
  if (app.human_approved || app.approved_artifact_sha256) {
    await db.from("applications").update({
      human_approved: false, human_approved_at: null,
      approved_artifact_sha256: null, approved_content_sha256: null, approved_answers_sha256: null,
    }).eq("id", app.id);
    if (app.status === "READY_TO_SUBMIT") {
      await db.from("applications").update({ status: "AWAITING_REVIEW" }).eq("id", app.id);
    }
    await db.from("application_events").insert({
      application_id: app.id, event: "APPROVAL_CLEARED_FOR_REPREPARATION",
      detail: "The approved artifact was rendered from a superseded profile version and is being replaced. "
        + "An approval is consent to send one specific document, so it does not carry across to different bytes. "
        + "Re-read the new version before approving it.",
      actor: "system",
    });
    console.log("   approval cleared: the approved document is being replaced");
  }

  try {
    const r = await prepareApplication(db, app.job_id, llm, { existingApplicationId: app.id });
    if (r.refusedReason) {
      console.log(`   REFUSED: ${r.refusedReason}\n`);
      failures.push({ id: app.id, label, reason: r.refusedReason });
      continue;
    }
    console.log(`   re-prepared: status ${r.status}, resume ${String(r.resumeId).slice(0, 8)}, `
      + `${r.answered} answered, ${r.blocked} blocked\n`);
    done++;
  } catch (e) {
    const reason = (e as Error).message;
    console.log(`   FAILED: ${reason}\n`);
    failures.push({ id: app.id, label, reason });
  }
}

console.log(`\n${commit ? `${done} re-prepared, ${failures.length} could not be` : "listing only"}`);
for (const f of failures) console.log(`  ${f.id.slice(0, 8)}  ${f.label}\n      ${f.reason}`);
