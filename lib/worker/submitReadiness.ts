/**
 * Is an application safe to submit AUTOMATICALLY, right now?
 *
 * The gate the owner asked for: auto-submit only when the fill is genuinely
 * complete, otherwise hand off. It never loosens an existing safety check --
 * the real submitter still runs its own revalidation; this is the extra
 * "nothing is BLOCKED" bar in front of an UNATTENDED click, so a half-filled
 * form is never sent to a real employer without a person.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface SubmitReadiness {
  ready: boolean;
  reasons: string[];      // why NOT ready (empty when ready)
  blockedCount: number;   // required questions still needing an answer
}

export async function submitReadiness(db: SupabaseClient, applicationId: string): Promise<SubmitReadiness> {
  const reasons: string[] = [];

  const { data: app } = await db.from("applications")
    .select("human_approved,submitted_at,submit_click_attempted_at,status")
    .eq("id", applicationId).maybeSingle();
  if (!app) return { ready: false, reasons: ["no such application"], blockedCount: 0 };

  if (app.submitted_at) reasons.push("already submitted");
  if (!app.human_approved) reasons.push("not approved by a person");
  // A prior click means the employer may already hold it: never auto-click
  // again; that is the ambiguity-resolution workflow's job.
  if (app.submit_click_attempted_at) reasons.push("a submit click was already attempted (resolve the ambiguity)");

  const { data: answers } = await db.from("application_answers")
    .select("confidence_state,is_required,answer_text")
    .eq("application_id", applicationId);
  const blocked = (answers ?? []).filter(
    (a) => a.is_required && (a.confidence_state === "BLOCKED" || !a.answer_text),
  );
  if (blocked.length) {
    reasons.push(`${blocked.length} required question${blocked.length === 1 ? "" : "s"} still need an answer (answer them on /apply/questions)`);
  }

  return { ready: reasons.length === 0, reasons, blockedCount: blocked.length };
}
