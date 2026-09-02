/**
 * Re-runs the answer resolver over one application's blocked fields.
 *
 *   node scripts/reresolve-application.ts <application_id>
 *   node scripts/reresolve-application.ts <application_id> --write
 *
 * Answers are resolved once, at preparation. That is deliberate: an
 * application is a frozen thing, and answers must not drift under it.
 * The cost is that fixing a resolver rule does nothing for applications
 * that already exist, so a question the system can now answer keeps
 * asking. That is what this closes.
 *
 * Narrow on purpose. It only ever touches rows that are currently
 * BLOCKED, and only when the resolver now produces an answer. A
 * HUMAN_CONFIRMED answer is never revisited: once you have answered
 * something, no rule change may quietly replace it.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { loadContext, applicationScope } from "../lib/applications/prepare.ts";
import { resolveField, type FormField } from "../lib/applications/answer.ts";

const applicationId = process.argv[2];
const write = process.argv.includes("--write");
if (!applicationId) { console.error("usage: reresolve-application.ts <application_id> [--write]"); process.exit(2); }

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: app } = await db.from("applications")
  .select("id,job_id,status,form_snapshot,submitted_at,human_approved").eq("id", applicationId).single();
if (!app) { console.error("no such application"); process.exit(1); }
if (app.submitted_at) { console.error("this application is already submitted"); process.exit(1); }

const fields: FormField[] = ((app.form_snapshot as any)?.fields ?? []);
const { data: rows } = await db.from("application_answers")
  .select("id,field_key,field_label,question_text,confidence_state,blocked_reason")
  .eq("application_id", applicationId).eq("confidence_state", "BLOCKED");

if (!rows?.length) { console.log("nothing is blocked on this application"); process.exit(0); }
console.log(`${rows.length} blocked field(s)\n`);

const ctx = await loadContext(db);
// The same posting-scoped context preparation resolves with.
//
// Without it ctx.application is undefined, and every rule that reasons
// about the employer, the location or the posting's conditions sees
// nothing and blocks. Re-resolution was therefore running with strictly
// less information than the original preparation had, and reporting the
// resulting blocks as though the question were unanswerable rather than
// as though it had not been asked properly.
ctx.application = await applicationScope(db, app.job_id).catch(() => undefined);
let resolved = 0;

for (const row of rows) {
  const field = fields.find((f) => f.key === row.field_key);
  if (!field) { console.log(`  still blocked  ${row.field_label?.slice(0, 56)}\n      not in the approved snapshot`); continue; }

  const r = resolveField(field, ctx);
  if (r.confidence === "BLOCKED" || r.answer === null) {
    console.log(`  still blocked  ${String(row.field_label).slice(0, 56)}`);
    console.log(`      ${String(r.blockedReason ?? row.blocked_reason).slice(0, 90)}`);
    continue;
  }

  resolved++;
  console.log(`  NOW ANSWERS   ${String(row.field_label).slice(0, 56)}`);
  console.log(`      ${r.confidence}: ${JSON.stringify(String(r.answer).slice(0, 60))}`);
  if (!write) continue;

  const { error } = await db.from("application_answers").update({
    answer_text: r.answer,
    confidence_state: r.confidence,
    // Cleared together with the state: the table refuses a row that is
    // not blocked but still claims a block reason.
    block_kind: null,
    blocked_reason: null,
    evidence_ids: r.evidenceIds ?? [],
    resolved_at: new Date().toISOString(),
  }).eq("id", row.id);
  if (error) console.log(`      could not write: ${error.message}`);
}

if (!write) { console.log(`\n${resolved} would now resolve. Pass --write to apply.`); process.exit(0); }

const { count } = await db.from("application_answers")
  .select("id", { count: "exact", head: true })
  .eq("application_id", applicationId).eq("confidence_state", "BLOCKED");
if ((count ?? 0) === 0 && app.status === "BLOCKED_NEEDS_INPUT") {
  await db.from("applications").update({ status: "AWAITING_REVIEW" }).eq("id", applicationId);
  console.log("\nnothing is blocked any more; the application is ready for your review");
}
await db.from("application_events").insert({
  application_id: applicationId, event: "ANSWERS_RERESOLVED",
  detail: `Re-ran the resolver over ${rows.length} blocked field(s) after a rule change; ${resolved} now resolve. `
    + `No answer you had already confirmed was touched.`,
  actor: "system",
});
console.log(`\nresolved ${resolved}, still blocked ${count ?? 0}`);
