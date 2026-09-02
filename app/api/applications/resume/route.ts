import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";

/**
 * Re-queue an application that stopped, from where it stopped.
 *
 * This creates no new state and rebuilds nothing. The answers, the frozen
 * job version, the approved artifact hash and the form snapshot all stay
 * exactly as they were; the only thing that changes is that the
 * application becomes eligible for another fill attempt, and the reason
 * is written to the audit trail.
 *
 * It deliberately cannot resume past a blocked answer. Resuming with a
 * question still unanswered would just reproduce the same stop, and
 * offering the button anyway would suggest otherwise.
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
  const applicationId = String(form.get("applicationId") ?? "");
  const returnTo = String(form.get("returnTo") ?? "/handoff");
  if (!applicationId) return NextResponse.json({ error: "no application" }, { status: 400 });

  const { data: app } = await db.from("applications")
    .select("id,status,human_approved,all_fields_confident,submitted_at").eq("id", applicationId).single();
  if (!app) return NextResponse.json({ error: "no such application" }, { status: 404 });
  if (app.submitted_at) {
    return NextResponse.json({ error: "this application is already submitted" }, { status: 409 });
  }

  const { count: blocked } = await db.from("application_answers")
    .select("id", { count: "exact", head: true })
    .eq("application_id", applicationId).eq("confidence_state", "BLOCKED");
  if ((blocked ?? 0) > 0) {
    return NextResponse.json(
      { error: `${blocked} question${blocked === 1 ? " is" : "s are"} still blocked; answer them first` },
      { status: 409 },
    );
  }

  // Where it goes back to depends on which gate it is behind, not on
  // where it stopped. An approved application is ready to be filled
  // again; an unapproved one goes back to review, because approval is
  // the thing it is actually missing.
  const next = app.human_approved && app.all_fields_confident ? "READY_TO_SUBMIT" : "AWAITING_REVIEW";
  if (app.status !== next) {
    const { error } = await db.from("applications").update({ status: next }).eq("id", applicationId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Same trap as request-submit: the browser cannot write the audit
  // trail. The status change above is the durable part and IS checked;
  // the event is best-effort and its failure is not reported as success.
  await db.from("application_events").insert({
    application_id: applicationId,
    event: "REQUEUED_BY_OPERATOR",
    detail: `Re-queued from the handoff inbox at ${new Date().toISOString()}. `
      + `State preserved: answers, frozen job version, approved artifact and form snapshot are unchanged. `
      + `Status ${app.status} -> ${next}.`,
    actor: "user",
  });

  // Re-queuing also clears any stale run request so the worker does not
  // pick this up twice.
  await db.from("applications")
    .update({ submit_requested_at: null, submit_started_at: null }).eq("id", applicationId);

  const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/handoff";
  return NextResponse.redirect(new URL(safe, request.url), { status: 303 });
}
