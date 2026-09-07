import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";

/**
 * "Apply now": send the batch without waiting for the scheduled run.
 *
 * This writes nothing but a time. Every batched request carries the
 * earliest moment the listener may run it (submit_not_before, the next
 * scheduled run); this moves that moment to the present for every held
 * request, or for one when an applicationId is given. The listener on the
 * Mac notices on its next poll, opens the browser and runs the same
 * submitter with every gate intact. The portal still cannot submit
 * anything itself.
 *
 * Requests already running, already sent, or not requested are untouched:
 * the WHERE clause names exactly the held ones.
 */
export async function POST(request: Request): Promise<Response> {
  const store = await cookies();
  const db = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (n, v, o) => store.set(n, v, o as any),
  });
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const form = await request.formData();
  const applicationId = String(form.get("applicationId") ?? "");
  const nowIso = new Date().toISOString();

  let q = db.from("applications")
    .update({ submit_not_before: nowIso })
    .not("submit_requested_at", "is", null)
    .is("submit_started_at", null)
    .is("submitted_at", null)
    .gt("submit_not_before", nowIso);
  if (applicationId) q = q.eq("id", applicationId);
  const { data: released, error } = await q.select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  for (const r of released ?? []) {
    await db.rpc("record_application_event", {
      p_application_id: r.id,
      p_event: "SUBMIT_REQUESTED",
      p_detail: `Apply now pressed by ${auth.user.email ?? auth.user.id}: the hold until the next scheduled run was cleared. The local worker re-runs every guard before submitting.`,
    }).then(() => undefined, () => undefined);
  }
  return NextResponse.redirect(new URL("/batched", request.url), { status: 303 });
}
