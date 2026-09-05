/**
 * Re-resolves the answers of an EXISTING prepared application against the
 * current answer engine, reusing its frozen form snapshot and its already
 * bound tailored resume. Deterministic: no model call, no re-tailoring, no
 * new application row.
 *
 *   node scripts/reresolve-answers.ts <application_id>            dry
 *   node scripts/reresolve-answers.ts <application_id> --write    persist
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { loadContext, applicationScope } from "../lib/applications/prepare.ts";
import { resolveField, shouldSkip, type ResolvedField } from "../lib/applications/answer.ts";
import { matchIntent, isResumeUploadField, ASHBY_RESUME_KEY } from "../lib/applications/intents.ts";

const appId = process.argv[2];
const write = process.argv.includes("--write");
if (!appId) { console.error("usage: reresolve-answers.ts <application_id> [--write]"); process.exit(2); }
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: app, error } = await db.from("applications").select("id,job_id,status,form_snapshot,resume_id").eq("id", appId).single();
if (error || !app) { console.error(`no such application: ${error?.message}`); process.exit(1); }
const fields = (app.form_snapshot?.fields ?? []) as any[];
if (!fields.length) { console.error("this application has no form snapshot"); process.exit(1); }

const ctx = await loadContext(db);
ctx.application = await applicationScope(db, app.job_id).catch(() => undefined);

const categoryOf = (r: ResolvedField): string =>
  r.confidence === "LOW_STAKES_SURVEY" ? "F_LOW_STAKES_SURVEY"
    : (r.intentKey ? matchIntent(r.field.label).intent?.category : null) ?? "E_UNKNOWN";
const provenanceOf = (r: ResolvedField): string =>
  (({ VERIFIED: "PROFILE", DERIVED: "CALCULATED", HUMAN_CONFIRMED: "USER_RESPONSE", LOW_STAKES_SURVEY: "GENERIC_SURVEY" } as any)[r.confidence]) ?? "USER_RESPONSE";

const resolved: ResolvedField[] = [];
for (const field of fields) {
  if (shouldSkip(field)) continue;
  if (isResumeUploadField(field)) {
    resolved.push({ field, intentKey: "resume_upload",
      matchedBy: field.key === ASHBY_RESUME_KEY ? "key:_systemfield_resume" : "pattern:resume_upload",
      answer: app.resume_id ? "the tailored resume prepared for this application" : null,
      confidence: app.resume_id ? "DERIVED" : "BLOCKED", blockKind: app.resume_id ? null : "UNKNOWN",
      blockedReason: app.resume_id ? null : "no tailored resume was produced",
      evidenceIds: app.resume_id ? [app.resume_id] : [], considered: [], refused: false });
    continue;
  }
  resolved.push(resolveField(field, ctx));
}

for (const r of resolved) {
  console.log(`[${r.confidence.padEnd(17)}] ${r.field.required ? "*" : " "} ${String(r.field.label).slice(0, 58)}`);
  if (r.answer) console.log(`      -> ${String(r.answer).slice(0, 60)}   (${r.matchedBy})`);
  if (r.blockedReason) console.log(`      x  ${String(r.blockedReason).slice(0, 100)}`);
}
const blocked = resolved.filter((r) => r.confidence === "BLOCKED").length;
console.log(`\n${resolved.length} fields, ${blocked} blocked`);

if (write) {
  const rows = resolved.map((r) => ({
    application_id: app.id, question_text: r.field.label, answer_text: r.answer,
    category: categoryOf(r), provenance: provenanceOf(r), field_key: r.field.key, field_label: r.field.label,
    is_required: r.field.required, confidence_state: r.confidence, block_kind: r.blockKind,
    blocked_reason: r.blockedReason, evidence_ids: r.evidenceIds, considered_evidence: r.considered as any,
    resolved_at: r.confidence === "BLOCKED" ? null : new Date().toISOString(),
  }));
  await db.from("application_answers").delete().eq("application_id", app.id);
  const { error: ie } = await db.from("application_answers").insert(rows);
  if (ie) { console.error("insert failed:", ie.message); process.exit(1); }
  const status = blocked > 0 ? "BLOCKED_NEEDS_INPUT" : "AWAITING_REVIEW";
  await db.from("applications").update({ status }).eq("id", app.id);
  console.log(`wrote ${rows.length} answers; status -> ${status}`);
}
