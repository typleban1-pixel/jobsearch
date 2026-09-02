import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";

/**
 * Ask the local worker to run an application you already approved.
 *
 * Approval and execution were separate from the beginning and only the
 * first had a control, so an approved application sat at READY_TO_SUBMIT
 * with nothing in the portal able to move it. This is the missing half.
 *
 * It does not submit anything. The deployed portal has no browser, no
 * Playwright and no Gmail credential; it records a request, and the
 * local worker picks it up and runs the same production adapter a manual
 * run would. Every gate still applies, and confirmation is still
 * required before anything is marked submitted.
 *
 * Requested submission is explicitly NOT policy authorization. You
 * approved this specific application, so it stays HUMAN_APPROVED and is
 * unaffected by the global unattended-submission switch, which governs
 * applications no person has read.
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
  const returnTo = String(form.get("returnTo") ?? "/applications");
  if (!applicationId) return NextResponse.json({ error: "no application" }, { status: 400 });

  const { data: app } = await db.from("applications")
    .select("id,status,human_approved,all_fields_confident,submitted_at").eq("id", applicationId).single();
  if (!app) return NextResponse.json({ error: "no such application" }, { status: 404 });
  if (app.submitted_at) return NextResponse.json({ error: "already submitted" }, { status: 409 });
  if (!app.human_approved) {
    return NextResponse.json({ error: "approve this application first" }, { status: 409 });
  }
  if (!app.all_fields_confident) {
    return NextResponse.json({ error: "not every required field is accounted for" }, { status: 409 });
  }

  // Written to the application, not to application_events. The audit
  // trail has no insert policy for the browser on purpose, and the first
  // version of this route wrote there anyway, ignored the RLS rejection,
  // and redirected as though the click had worked. Errors are checked
  // now: a request that cannot be recorded must not look successful.
  const { error } = await db.from("applications")
    .update({ submit_requested_at: new Date().toISOString(), submit_started_at: null })
    .eq("id", applicationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/applications";
  return NextResponse.redirect(new URL(safe, request.url), { status: 303 });
}
