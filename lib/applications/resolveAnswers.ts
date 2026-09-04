/**
 * Resolving one blocked application answer, and the shared rules that
 * apply however it is submitted -- one at a time from the queue, or all
 * at once from the consolidated questions form. Both routes call this, so
 * there is a SINGLE implementation of what "answer a blocked field" means:
 * the write, the option check against the application's own frozen
 * snapshot, deliberate reuse, and the unblock transition. Re-evaluation
 * (which enqueues a newly ready application) is deliberately NOT done here;
 * the caller collects every touched application and evaluates each exactly
 * once, so a bulk save cannot reevaluate or enqueue the same one twice.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AnswerResolution {
  answerId: string;
  /** Trimmed answer text; ignored when leaveBlank is true. */
  answer: string;
  leaveBlank: boolean;
  promote: boolean;
  /** Other blocked rows the reader explicitly chose to reuse this answer for. */
  reuseAnswerIds: string[];
}

export type ResolutionStatus =
  | "SAVED" | "ALREADY_RESOLVED" | "EMPTY" | "NOT_FOUND" | "OPTION_NOT_OFFERED" | "ERROR";

export interface ResolutionResult {
  answerId: string;
  ok: boolean;
  status: ResolutionStatus;
  message?: string;
  /** Application ids actually written this call (primary + successful reuse). */
  touched: string[];
  /** Application ids skipped because the option was not on their own form. */
  reuseSkipped: string[];
}

/** The exact options THIS application's frozen snapshot offers, or null for free text. */
async function offeredBy(db: SupabaseClient, applicationId: string, fieldKey: string): Promise<string[] | null> {
  const { data: app } = await db.from("applications").select("form_snapshot").eq("id", applicationId).single();
  const spec = ((app?.form_snapshot as any)?.fields ?? []).find((f: any) => f.key === fieldKey);
  return Array.isArray(spec?.options) && spec.options.length ? spec.options : null;
}

/** BLOCKED_NEEDS_INPUT -> AWAITING_REVIEW once an application has no blocked rows left. */
async function unblockIfClear(db: SupabaseClient, applicationId: string): Promise<void> {
  const { data: still } = await db.from("application_answers")
    .select("id").eq("application_id", applicationId).eq("confidence_state", "BLOCKED").limit(1);
  if (still?.length) return;
  const { data: app } = await db.from("applications").select("status").eq("id", applicationId).single();
  if (app?.status === "BLOCKED_NEEDS_INPUT") {
    await db.from("applications").update({ status: "AWAITING_REVIEW" }).eq("id", applicationId);
  }
}

/**
 * Apply one resolution. Never throws: a failure is returned as a result so
 * a bulk caller keeps every other successful write. The answer is written
 * as HUMAN_CONFIRMED / USER_RESPONSE -- it is what the person supplied, so
 * it is never presented as derived or inferred. A row that is no longer
 * blocked (a retry after a partial save) is reported ALREADY_RESOLVED, not
 * overwritten.
 */
export async function resolveOneAnswer(db: SupabaseClient, r: AnswerResolution): Promise<ResolutionResult> {
  const base = { answerId: r.answerId, touched: [] as string[], reuseSkipped: [] as string[] };
  try {
    if (!r.answerId) return { ...base, ok: false, status: "NOT_FOUND", message: "no answer id" };
    if (!r.leaveBlank && !r.answer) {
      return { ...base, ok: false, status: "EMPTY", message: "give an answer or choose to leave the field blank" };
    }
    const { data: row } = await db.from("application_answers")
      .select("id,application_id,field_key,confidence_state").eq("id", r.answerId).single();
    if (!row) return { ...base, ok: false, status: "NOT_FOUND", message: "no such field" };
    // Idempotent on retry: a field already answered in an earlier partial
    // save is left exactly as it is, and reported rather than rewritten.
    if (row.confidence_state !== "BLOCKED") {
      return { ...base, ok: true, status: "ALREADY_RESOLVED", message: "already answered" };
    }

    if (!r.leaveBlank) {
      const options = await offeredBy(db, row.application_id, row.field_key);
      if (options && !options.includes(r.answer)) {
        return { ...base, ok: false, status: "OPTION_NOT_OFFERED",
          message: "that choice is not one this employer offers for this question; nothing was written and it is still open" };
      }
    }

    const write = {
      answer_text: r.leaveBlank ? null : r.answer,
      confidence_state: "HUMAN_CONFIRMED" as const,
      provenance: "USER_RESPONSE" as const,
      block_kind: null, blocked_reason: null,
      resolved_at: new Date().toISOString(),
      promote_to_bank: r.promote ? true : null,
    };
    const { error } = await db.from("application_answers").update(write).eq("id", r.answerId);
    if (error) return { ...base, ok: false, status: "ERROR", message: error.message };
    const touched = [row.application_id];
    await unblockIfClear(db, row.application_id);

    // Deliberate reuse only. Each application keeps its own row; the record
    // says the answer was reused on purpose. A target that is not blocked is
    // skipped, never overwritten, and one whose own form does not offer this
    // exact string is left blocked rather than given the nearest fit.
    const reuseSkipped: string[] = [];
    for (const reuseId of r.reuseAnswerIds) {
      if (!reuseId || reuseId === r.answerId) continue;
      const { data: target } = await db.from("application_answers")
        .select("id,application_id,field_key,confidence_state").eq("id", reuseId).single();
      if (!target || target.confidence_state !== "BLOCKED") continue;
      if (!r.leaveBlank) {
        const opts = await offeredBy(db, target.application_id, target.field_key);
        if (opts && !opts.includes(r.answer)) { reuseSkipped.push(target.application_id); continue; }
      }
      const { error: reuseErr } = await db.from("application_answers").update({
        ...write,
        considered_evidence: [{
          kind: "DELIBERATE_REUSE", reusedFromAnswerId: r.answerId,
          reusedFromApplicationId: row.application_id, chosenAt: new Date().toISOString(),
          note: "You chose to use one answer for this application as well.",
        }],
      }).eq("id", reuseId);
      if (reuseErr) { reuseSkipped.push(target.application_id); continue; }
      touched.push(target.application_id);
      await unblockIfClear(db, target.application_id);
    }
    return { ...base, ok: true, status: "SAVED", touched, reuseSkipped };
  } catch (e) {
    return { ...base, ok: false, status: "ERROR", message: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
