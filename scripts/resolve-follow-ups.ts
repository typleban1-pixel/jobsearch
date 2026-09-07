/**
 * Apply the conditional follow-up rule to applications already waiting on
 * a person.
 *
 *   node --env-file=.env.local scripts/resolve-follow-ups.ts            (dry run)
 *   node --env-file=.env.local scripts/resolve-follow-ups.ts --commit
 *
 * New preparations get this in prepare.ts. Applications prepared before the
 * rule existed still carry "If yes, ..." rows as BLOCKED under a parent that
 * is answered "No"; this resolves those the same way (a derived blank, with
 * the parent named), annotates the follow-ups that remain open with their
 * parent question and answer, and moves an application to AWAITING_REVIEW
 * when nothing blocked is left. Only BLOCKED rows are ever touched.
 */
import { createClient } from "@supabase/supabase-js";
import { resolveFollowUps } from "../lib/applications/followUp.ts";
import { unblockIfClear } from "../lib/applications/resolveAnswers.ts";
import type { FormField, ResolvedField } from "../lib/applications/answer.ts";

const commit = process.argv.includes("--commit");
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const { data: apps, error } = await db.from("applications")
  .select("id,status,form_snapshot,jobs(title,companies(name))")
  .eq("status", "BLOCKED_NEEDS_INPUT").or("is_test.is.null,is_test.eq.false");
if (error) throw new Error(error.message);

let blankedTotal = 0, annotatedTotal = 0;
for (const app of (apps ?? []) as any[]) {
  const fields = ((app.form_snapshot?.fields ?? []) as FormField[]);
  if (!fields.length) continue;
  const { data: rows } = await db.from("application_answers")
    .select("id,field_key,field_label,answer_text,confidence_state,blocked_reason,evidence_ids")
    .eq("application_id", app.id);
  const byKey = new Map((rows ?? []).map((r: any) => [r.field_key, r]));
  const resolved: ResolvedField[] = fields.filter((f) => byKey.has(f.key)).map((f) => {
    const r = byKey.get(f.key)!;
    return { field: f, intentKey: null, matchedBy: "stored", answer: r.answer_text, confidence: r.confidence_state,
      blockKind: null, blockedReason: r.blocked_reason, evidenceIds: r.evidence_ids ?? [], considered: [], refused: false };
  });
  const out = resolveFollowUps(fields, resolved);
  const label = `${app.jobs?.companies?.name ?? "?"} — ${app.jobs?.title ?? "?"}`;
  let touched = 0;
  for (const r of out.resolved) {
    const before = byKey.get(r.field.key)!;
    if (before.confidence_state !== "BLOCKED") continue;
    if (r.confidence === "DERIVED") {
      touched++; blankedTotal++;
      console.log(`  blank    ${label} | ${r.field.label.slice(0, 70)} | ${r.matchedBy}`);
      if (commit) await db.from("application_answers").update({
        answer_text: null, confidence_state: "DERIVED", provenance: "CALCULATED",
        block_kind: null, blocked_reason: null, resolved_at: new Date().toISOString(),
        evidence_ids: r.evidenceIds,
      }).eq("id", before.id);
    } else if (r.blockedReason !== before.blocked_reason && /^This follows /.test(r.blockedReason ?? "")) {
      touched++; annotatedTotal++;
      console.log(`  annotate ${label} | ${r.field.label.slice(0, 70)} | ${r.blockedReason?.slice(0, 110)}`);
      if (commit) await db.from("application_answers").update({ blocked_reason: r.blockedReason }).eq("id", before.id);
    }
  }
  if (commit && touched) await unblockIfClear(db, app.id);
}
console.log(`\n${commit ? "applied" : "dry run"}: ${blankedTotal} follow-up(s) blanked as not applicable, ${annotatedTotal} annotated with their parent question${commit ? "" : " (re-run with --commit to write)"}`);
