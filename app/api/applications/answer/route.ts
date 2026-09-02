import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";

/**
 * Answering one blocked question.
 *
 * The answer becomes HUMAN_CONFIRMED: you supplied it, so it is neither
 * derived from evidence nor read off a profile row, and it must not
 * claim to be. Clearing the last block lets the database's own trigger
 * recompute all_fields_confident, which is the only thing that may set
 * it.
 *
 * "Leave blank" is a real answer, not an absence. An optional
 * demographic field the user declines is answered and accounted for; a
 * field nobody looked at is not.
 */
export async function POST(request: Request): Promise<Response> {
  const store = await cookies();
  const db = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const form = await request.formData();
  const answerId = String(form.get("answerId") ?? "");
  const leaveBlank = form.get("leaveBlank") === "1";
  const promote = form.get("promote") === "1";
  const answer = String(form.get("answer") ?? "").trim();
  const returnTo = String(form.get("returnTo") ?? "/applications/queue");
  // Other blocked rows the reader explicitly chose to apply this same
  // answer to. Empty unless they ticked the box; grouping alone never
  // populates this.
  const reuseIds = String(form.get("reuseAnswerIds") ?? "")
    .split(",").map((x) => x.trim()).filter(Boolean);

  if (!answerId) return NextResponse.json({ error: "no answer id" }, { status: 400 });
  if (!leaveBlank && !answer) {
    return NextResponse.json({ error: "give an answer or choose to leave the field blank" }, { status: 400 });
  }

  const { data: row, error: readErr } = await db.from("application_answers")
    .select("id,application_id,field_key,confidence_state").eq("id", answerId).single();
  if (readErr || !row) return NextResponse.json({ error: "no such field" }, { status: 404 });
  if (row.confidence_state !== "BLOCKED") {
    return NextResponse.json({ error: "that field is not blocked" }, { status: 409 });
  }

  /**
   * The answer has to be something THIS employer actually offered.
   *
   * Questions are grouped for reading by intent, so several employers
   * asking the same thing are presented once, and the choices shown are
   * the union of what those forms offer. The union is a reading
   * convenience and nothing more: an option one posting lists and
   * another does not must never be written to the one that does not
   * list it. So every write, including the first, is checked against
   * that application's own frozen snapshot.
   *
   * Free text has no options and is unconstrained. Leaving a field blank
   * is always allowed: declining to answer is not choosing a value.
   */
  const offeredBy = async (applicationId: string, fieldKey: string): Promise<string[] | null> => {
    const { data: app } = await db.from("applications")
      .select("form_snapshot").eq("id", applicationId).single();
    const spec = ((app?.form_snapshot as any)?.fields ?? [])
      .find((f: any) => f.key === fieldKey);
    return Array.isArray(spec?.options) && spec.options.length ? spec.options : null;
  };

  if (!leaveBlank) {
    const options = await offeredBy(row.application_id, row.field_key);
    if (options && !options.includes(answer)) {
      return NextResponse.json({
        error: "that choice is not one this employer offers for this question",
        detail: "The choices shown may combine several employers' forms. This one does not list that option, "
          + "so nothing was written and the question is still open.",
      }, { status: 409 });
    }
  }

  // block_kind and blocked_reason must clear together with the state:
  // the table's own constraint refuses a non-blocked row that still
  // claims to be blocked.
  const { error } = await db.from("application_answers").update({
    answer_text: leaveBlank ? null : answer,
    confidence_state: "HUMAN_CONFIRMED",
    provenance: "USER_RESPONSE",
    block_kind: null,
    blocked_reason: null,
    resolved_at: new Date().toISOString(),
    // Null until you decide. Nothing in the system sets this on its own,
    // and reuse stays off unless this box was ticked.
    promote_to_bank: promote ? true : null,
  }).eq("id", answerId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // An application whose last block just cleared is ready to be read.
  const { data: still } = await db.from("application_answers")
    .select("id").eq("application_id", row.application_id).eq("confidence_state", "BLOCKED").limit(1);
  if (!still?.length) {
    const { data: app } = await db.from("applications")
      .select("status").eq("id", row.application_id).single();
    if (app?.status === "BLOCKED_NEEDS_INPUT") {
      await db.from("applications").update({ status: "AWAITING_REVIEW" }).eq("id", row.application_id);
    }
  }

  // Deliberate reuse. Each application keeps its own row: the answer was
  // given once and applied to several forms because the reader said so,
  // and the record says that rather than showing two answers that merely
  // agree. A row that is not blocked is skipped, never overwritten.
  const skipped: string[] = [];
  for (const reuseId of reuseIds) {
    if (reuseId === answerId) continue;
    const { data: target } = await db.from("application_answers")
      .select("id,application_id,field_key,confidence_state,field_label").eq("id", reuseId).single();
    if (!target || target.confidence_state !== "BLOCKED") continue;

    // Same rule as the primary row. An application whose form does not
    // offer this exact string is left blocked and keeps asking, rather
    // than being given the nearest thing that fits.
    if (!leaveBlank) {
      const targetOptions = await offeredBy(target.application_id, target.field_key);
      if (targetOptions && !targetOptions.includes(answer)) {
        skipped.push(target.application_id);
        continue;
      }
    }

    const { error: reuseErr } = await db.from("application_answers").update({
      answer_text: leaveBlank ? null : answer,
      confidence_state: "HUMAN_CONFIRMED",
      provenance: "USER_RESPONSE",
      block_kind: null,
      blocked_reason: null,
      resolved_at: new Date().toISOString(),
      promote_to_bank: promote ? true : null,
      considered_evidence: [{
        kind: "DELIBERATE_REUSE",
        reusedFromAnswerId: answerId,
        reusedFromApplicationId: row.application_id,
        chosenAt: new Date().toISOString(),
        note: "You chose to use one answer for this application as well.",
      }],
    }).eq("id", reuseId);
    if (reuseErr) return NextResponse.json({ error: reuseErr.message }, { status: 500 });

    // Same unblocking check as the primary row, for this application.
    const { data: left } = await db.from("application_answers")
      .select("id").eq("application_id", target.application_id).eq("confidence_state", "BLOCKED").limit(1);
    if (!left?.length) {
      const { data: a2 } = await db.from("applications").select("status").eq("id", target.application_id).single();
      if (a2?.status === "BLOCKED_NEEDS_INPUT") {
        await db.from("applications").update({ status: "AWAITING_REVIEW" }).eq("id", target.application_id);
      }
    }
  }

  const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/applications/queue";
  return NextResponse.redirect(new URL(safe, request.url), { status: 303 });
}
