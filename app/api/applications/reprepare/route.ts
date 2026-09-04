import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";
import { reprepareGuard } from "../../../../lib/applications/reprepareGuard.ts";

/**
 * Hand a parked live-form application back to the worker to prepare.
 *
 * An Ashby (or Lever) application whose form has no published API is parked
 * as a DRAFT with a blocked_reason until a browser can snapshot it. The
 * always-on prepare-listener claims DRAFTs whose blocked_reason IS NULL, so
 * clearing that one column is the whole re-enqueue: within a poll the worker
 * claims the row, opens the live form, snapshots it, and preparation runs
 * exactly as it does for any DRAFT. Nothing else changes -- status stays
 * DRAFT (prepareApplication owns the transitions), no answer is written
 * here, and no submission is possible from this route.
 *
 * The portal holds no browser and no model key, so it cannot prepare
 * anything itself; it can only put the row back in the queue the worker
 * already drains. Guarded so it only ever touches a genuinely parked live
 * DRAFT of the current user: not a mid-claim row, not a submitted one, not a
 * provider whose form the worker cannot open.
 */
export async function POST(request: Request): Promise<Response> {
  const store = await cookies();
  const db = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const applicationId = String(body?.applicationId ?? "");
  if (!applicationId) return NextResponse.json({ error: "no application id" }, { status: 400 });

  const { data: app, error } = await db.from("applications")
    .select("id,job_id,status,blocked_reason,prepare_started_at,submitted_at")
    .eq("id", applicationId).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!app) return NextResponse.json({ error: "no such application" }, { status: 404 });

  const { data: job } = await db.from("jobs").select("source").eq("id", app.job_id).maybeSingle();

  // Only a genuinely parked live DRAFT is re-preparable. Every other state
  // is either already moving, already sent, or has no browser path. One
  // pure rule, shared with the self-test.
  const guard = reprepareGuard(app, job ? String(job.source) : null);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  // The whole re-enqueue: clear the park so the worker's claim query sees
  // it. Guarded on the same preconditions in the WHERE so a concurrent
  // claim or clear cannot be clobbered.
  const { data: cleared, error: upErr } = await db.from("applications")
    .update({ blocked_reason: null })
    .eq("id", applicationId).eq("status", "DRAFT")
    .is("prepare_started_at", null).not("blocked_reason", "is", null)
    .select("id").maybeSingle();
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  if (!cleared) return NextResponse.json({ error: "state changed; try again" }, { status: 409 });

  return NextResponse.json({ ok: true, state: "QUEUED_FOR_PREPARATION" });
}
