/**
 * At Review, the answer table is brought into line with the form.
 *
 *   node --env-file=.env.local scripts/workday-reconcile-review.ts <application_id> [--commit]
 *
 * A Workday form is filled by three hands: the runner (single controls),
 * the experience fill (Work Experience and Education blocks, from the
 * approved résumé) and the person (sign-in, consent). The answer table
 * only ever heard from the runner, so at Review it still says BLOCKED for
 * rows the other two settled -- "Job Title" and "Company", filled six
 * times over from the résumé -- and for controls discovery recorded while
 * a dropdown list happened to be open. The portal's approval gate counts
 * every BLOCKED row, so the application could never be approved.
 *
 * What this does, and only at Review, when the form is what the employer
 * will receive:
 *  - a required row for a repeated-block control (job title, company,
 *    location, role description) is answered with what the experience
 *    fill entered, read from the résumé content it entered it from:
 *    DERIVED, provenance PROFILE;
 *  - an optional BLOCKED row is not a question at Review: it is a control
 *    the experience fill owns (a block's Month, Year, Role Description) or
 *    an option label discovery recorded while a list was open. It is
 *    removed; the form holds the truth and discovery recreates any real
 *    control on the next pass;
 *  - a required BLOCKED row of any other kind stays BLOCKED and is
 *    reported: that is a real gap a person has to see.
 * Then, if nothing is blocked, the application is AWAITING_REVIEW with
 * prepared_at set, exactly as workday-signin-and-discover.ts does.
 *
 * Approval is untouched: human_approved and the approved hashes are never
 * written here.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const id = process.argv[2];
if (!id) { console.error("usage: node scripts/workday-reconcile-review.ts <application_id> [--commit]"); process.exit(2); }
const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: app } = await db.from("applications").select("id,status,resume_id,human_approved,submitted_at").eq("id", id).single();
if (!app) { console.error("no such application"); process.exit(1); }
if (app.submitted_at) { console.error("refusing: submitted"); process.exit(1); }
const { data: resume } = app.resume_id
  ? await db.from("resumes").select("content").eq("id", app.resume_id).single()
  : { data: null };
const roles: any[] = (resume as any)?.content?.roles ?? [];
// What grounds a résumé-derived answer: the frozen employment records the
// résumé was composed from (grounded_states_cite_evidence requires it).
const { data: master } = await db.from("resumes").select("label").eq("is_master", true).single();
const version = Number(String(master?.label ?? "").match(/profile version (\d+)/)?.[1] ?? 0);
const { data: empRows } = await db.from("profile_version_rows").select("row_id").eq("profile_version", version).eq("source_table", "employment_records");
const employmentEvidence = (empRows ?? []).map((r: any) => r.row_id as string);
const fromResume: Record<string, string | null> = {
  jobTitle: roles.map((r) => r.title).filter(Boolean).join("; ") || null,
  companyName: roles.map((r) => r.employer).filter(Boolean).join("; ") || null,
  location: roles.map((r) => r.location).filter(Boolean).join("; ") || null,
  roleDescription: roles.map((r) => (r.lines ?? []).map((l: any) => (typeof l === "string" ? l : l.text)).join(" ")).filter(Boolean).join(" || ") || null,
};

const { data: rows } = await db.from("application_answers")
  .select("id,field_key,question_text,is_required,confidence_state,answer_text").eq("application_id", id).eq("confidence_state", "BLOCKED");
const plan: Array<{ id: string; label: string; patch: Record<string, unknown>; why: string }> = [];
const remove: Array<{ id: string; label: string }> = [];
const gaps: string[] = [];
for (const r of rows ?? []) {
  const key = String(r.field_key);
  const block = /\[name="(jobTitle|companyName|location|roleDescription)"\]|--(jobTitle|companyName|location|roleDescription)\b/.exec(key);
  const name = block?.[1] ?? block?.[2] ?? null;
  if (r.is_required && name && fromResume[name] && employmentEvidence.length) {
    plan.push({ id: r.id, label: r.question_text, why: `${roles.length} entries entered from the approved résumé`,
      patch: { answer_text: fromResume[name], confidence_state: "DERIVED", provenance: "PROFILE", block_kind: null,
        blocked_reason: null, evidence_ids: employmentEvidence, resolved_at: new Date().toISOString() } });
  } else if (!r.is_required) {
    remove.push({ id: r.id, label: r.question_text });
  } else {
    gaps.push(`${r.question_text} (${key})`);
  }
}
console.log(`${(rows ?? []).length} blocked row(s): ${plan.length} answered from the résumé, `
  + `${remove.length} optional discovery artefact(s) to remove, ${gaps.length} required gap(s)`);
for (const p of plan) console.log(`  answer   ${p.label.slice(0, 40).padEnd(42)} ${String(p.patch.answer_text).slice(0, 70)}`);
for (const g of gaps) console.log(`  GAP      ${g.slice(0, 100)}`);
if (!commit) { console.log("\ndry run; pass --commit to write"); process.exit(0); }

for (const p of plan) {
  const { error } = await db.from("application_answers").update(p.patch).eq("id", p.id);
  if (error) throw new Error(`update ${p.label}: ${error.message}`);
}
for (let i = 0; i < remove.length; i += 100) {
  const { error } = await db.from("application_answers").delete().in("id", remove.slice(i, i + 100).map((r) => r.id));
  if (error) throw new Error(`remove: ${error.message}`);
}
const { data: still } = await db.from("application_answers").select("id").eq("application_id", id).eq("confidence_state", "BLOCKED");
const blocked = (still ?? []).length;
const status = blocked > 0 ? "BLOCKED_NEEDS_INPUT" : (app.human_approved ? app.status : "AWAITING_REVIEW");
const { error } = await db.from("applications").update({
  status, prepared_at: new Date().toISOString(),
  blocked_reason: blocked > 0 ? `${blocked} field(s) on the employer's form need your answer` : null,
}).eq("id", id);
if (error) throw new Error(error.message);
await db.from("application_events").insert({
  application_id: id, event: "REVIEW_REACHED", actor: "worker",
  detail: `Workday Review page reached; ${plan.length} required row(s) answered from the résumé, ${remove.length} optional discovery artefact(s) removed. `
    + `${blocked ? `${blocked} still need a person.` : "Nothing blocked; awaiting review."}`,
});
console.log(`\napplication is ${status}${blocked ? ` (${blocked} blocked)` : ""}`);
