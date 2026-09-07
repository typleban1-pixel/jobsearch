import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";

/**
 * "Not interested": the person removes an application they no longer want.
 *
 * Two things happen, and both have to: the application is ABANDONED, so
 * nothing prepares, asks, or submits it again; and the opening is marked
 * NOT_INTERESTED, so the worker never selects it afresh (a closed
 * application does not by itself stop a job being chosen again). A
 * submitted application is never touched here -- what was sent is history.
 * Form post, same-origin redirect, RLS on every write, like /api/interest.
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
  const returnTo = String(form.get("returnTo") ?? "/apply");
  if (!applicationId) return NextResponse.json({ error: "no application" }, { status: 400 });

  const { data: app } = await db.from("applications")
    .select("id,job_id,canonical_opening_id,status,submitted_at").eq("id", applicationId).maybeSingle();
  if (!app) return NextResponse.json({ error: "no such application" }, { status: 404 });
  if (app.submitted_at) return NextResponse.json({ error: "already submitted; a sent application is not removed" }, { status: 409 });

  if (!["ABANDONED", "WITHDRAWN"].includes(app.status)) {
    const { error } = await db.from("applications").update({
      status: "ABANDONED",
      outcome_note: `Removed by the person from the portal on ${new Date().toISOString().slice(0, 10)}: not interested.`,
      submit_requested_at: null,
    }).eq("id", applicationId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await db.rpc("record_application_event", {
      p_application_id: applicationId,
      p_event: "ABANDONED_BY_PERSON",
      p_detail: `Removed from the questions page by ${auth.user.email ?? auth.user.id}: not interested. `
        + `The opening is marked not interested, so it is never prepared again.`,
    }).then(() => undefined, () => undefined);
  }
  if (app.canonical_opening_id) {
    const { error } = await db.from("job_interest").upsert(
      { canonical_opening_id: app.canonical_opening_id, decided_from_job_id: app.job_id, state: "NOT_INTERESTED", updated_at: new Date().toISOString() },
      { onConflict: "canonical_opening_id" },
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/apply";
  return NextResponse.redirect(new URL(safe, request.url), { status: 303 });
}
