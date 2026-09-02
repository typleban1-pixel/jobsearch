/**
 * Removes a false evidence row from the live truth profile and records
 * the retraction durably.
 *
 * The retraction is NOT written as a negative-polarity evidence row.
 * Negative evidence participates in matching, and a row saying "did not
 * create a program" would read as a broad capability absence. The fact
 * is narrower than that: one specific claim, inherited from the source
 * resume, is false. That is a claim prohibition, so it lives in the
 * append-only change log and in the claim guards, neither of which
 * scores anything.
 *
 * Frozen profile versions are deliberately untouched. A version is a
 * record of what the profile contained when it was cut, and editing one
 * to make the past look correct would destroy the only evidence that the
 * claim was ever present.
 *
 *   node scripts/retract-evidence.ts --confirm
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const EVIDENCE_ID = "eaba2beb-3d29-4689-8006-3e1490e4974a";

const RETRACTION = {
  retracted_row_id: EVIDENCE_ID,
  source_table: "evidence",
  retracted_by: "user (Ty Pleban), explicit instruction",
  retracted_on: "2026-08-30",
  claim_as_stored: "Created the program from the ground up and developed real-world student production opportunities.",
  prohibited_claim:
    "That he created, built, founded, established or launched the LCCC Video Program internship program, " +
    "or the LCCC Video Program itself.",
  scope_limit:
    "This is a source correction and a claim prohibition. It is NOT evidence that he lacks program-creation " +
    "capability, and it must never be read as a general absence. It constrains one specific historical claim " +
    "about LCCC and nothing else.",
  origin_of_error:
    "The claim came from his existing resume, which states it inaccurately. The row was created during resume " +
    "parsing and survived the retraction because only the employment_records accomplishment was cleaned.",
  capability_impact:
    "None. The row backed no skill, no metric and no resume claim, so removing it removes a false statement " +
    "and no supporting evidence.",
  enforcement: "lib/render/claimGuards.ts, subjects 'LCCC internship program' and 'LCCC program creation'.",
};

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: row, error: readErr } = await db.from("evidence").select("*").eq("id", EVIDENCE_ID).maybeSingle();
if (readErr) throw new Error(readErr.message);
if (!row) { console.log("evidence row is already absent, nothing to do"); process.exit(0); }

console.log("row to delete:");
for (const [k, v] of Object.entries(row)) console.log(`  ${k}: ${typeof v === "string" ? v.slice(0, 160) : v}`);

// Nothing may reference it, or the deletion would silently remove support
// for something else. Re-checked here rather than trusted from the audit.
for (const [table, col] of [["skill_evidence", "evidence_id"], ["metrics", "evidence_id"]] as const) {
  const { count } = await db.from(table).select("*", { count: "exact", head: true }).eq(col, EVIDENCE_ID);
  if ((count ?? 0) > 0) throw new Error(`${table} still references ${EVIDENCE_ID} (${count} rows); resolve before deleting`);
}

if (!process.argv.includes("--confirm")) { console.log("\ndry run. pass --confirm to delete."); process.exit(0); }

const { data: pv } = await db.from("profile").select("profile_version").eq("singleton", true).single();

// Written BEFORE the delete, so the rationale exists in the log even if
// the delete fails. The delete produces its own log row carrying old_data.
const { error: logErr } = await db.from("truth_change_log").insert({
  source_table: "evidence",
  row_id: EVIDENCE_ID,
  operation: "RETRACTION",
  changed_fields: ["summary", "detail", "polarity"],
  old_data: row,
  new_data: RETRACTION,
  profile_version_at_time: pv?.profile_version ?? null,
  actor: "user:ty-pleban",
});
if (logErr) throw new Error(`retraction record failed, nothing deleted: ${logErr.message}`);
console.log("\nretraction recorded in truth_change_log");

const { error: delErr } = await db.from("evidence").delete().eq("id", EVIDENCE_ID);
if (delErr) throw new Error(`delete failed (retraction record stands): ${delErr.message}`);

const { data: gone } = await db.from("evidence").select("id").eq("id", EVIDENCE_ID).maybeSingle();
console.log(gone ? "DELETE DID NOT TAKE EFFECT" : "evidence row deleted");

const { data: log } = await db.from("truth_change_log").select("operation,actor,occurred_at")
  .eq("row_id", EVIDENCE_ID).order("occurred_at");
console.log(`change log for this row: ${(log ?? []).map((l: any) => `${l.operation}(${l.actor})`).join(", ")}`);

for (const v of [3, 4]) {
  const { count } = await db.from("profile_version_rows").select("*", { count: "exact", head: true })
    .eq("profile_version", v).eq("row_id", EVIDENCE_ID);
  console.log(`  version ${v} snapshot still contains the row: ${(count ?? 0) > 0} (intentional, history is immutable)`);
}
