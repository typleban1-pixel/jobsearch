/**
 * Runs today's resolver over every question still waiting on a person.
 *
 *   node --env-file=.env.local scripts/re-resolve-blocked.ts            (dry run)
 *   node --env-file=.env.local scripts/re-resolve-blocked.ts --commit
 *
 * The resolver learns rules over time (a salary expectation weighed from
 * the posting's range; a referrer question left blank; a self-ID question
 * declined). Applications prepared before a rule existed still carry the
 * question as BLOCKED. This asks the current resolver again, with each
 * application's own posting facts, and writes only what it can now answer
 * with the same confidence rules preparation uses. A question it still
 * cannot answer is left exactly as it was. Applications that end up with
 * nothing blocked move on to review through the ordinary transition.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { loadContext, applicationScope, categoryOf, provenanceOf } from "../lib/applications/prepare.ts";
import { resolveField, type FormField } from "../lib/applications/answer.ts";
import { unblockIfClear } from "../lib/applications/resolveAnswers.ts";

const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: apps, error } = await db.from("applications")
  .select("id,job_id,status,form_snapshot,jobs(title,companies(name))")
  .is("submitted_at", null).not("status", "in", "(ABANDONED,WITHDRAWN,REJECTED)").or("is_test.is.null,is_test.eq.false");
if (error) throw new Error(error.message);
const base = await loadContext(db);

let answered = 0, stillBlocked = 0, touchedApps = 0;
for (const app of (apps ?? []) as any[]) {
  const fields = ((app.form_snapshot?.fields ?? []) as FormField[]);
  const { data: rows } = await db.from("application_answers")
    .select("id,field_key,question_text,confidence_state").eq("application_id", app.id).eq("confidence_state", "BLOCKED");
  if (!rows?.length) continue;
  const ctx = { ...base, application: await applicationScope(db, app.job_id).catch(() => undefined) };
  const label = `${(app.jobs as any)?.companies?.name ?? "?"} — ${(app.jobs as any)?.title ?? "?"}`;
  let touched = 0;
  for (const row of rows as any[]) {
    const field = fields.find((f) => f.key === row.field_key);
    if (!field) continue;
    const r = resolveField(field, ctx);
    if (r.confidence === "BLOCKED") { stillBlocked++; continue; }
    answered++; touched++;
    console.log(`  ${r.confidence.padEnd(17)} ${label.slice(0, 44).padEnd(46)} | ${field.label.slice(0, 50).padEnd(52)} -> ${JSON.stringify(r.answer)?.slice(0, 40)}`);
    if (commit) {
      const { error: uErr } = await db.from("application_answers").update({
        answer_text: r.answer, confidence_state: r.confidence, category: categoryOf(r), provenance: provenanceOf(r),
        block_kind: null, blocked_reason: null, evidence_ids: r.evidenceIds, considered_evidence: r.considered as any,
        resolved_at: new Date().toISOString(),
      }).eq("id", row.id);
      if (uErr) throw new Error(`${label}: ${uErr.message}`);
    }
  }
  if (touched) { touchedApps++; if (commit) await unblockIfClear(db, app.id); }
}
console.log(`\n${commit ? "applied" : "dry run"}: ${answered} question(s) now answered across ${touchedApps} application(s); ${stillBlocked} still need a person`);
