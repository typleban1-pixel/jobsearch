import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";
import { retryAllowed } from "../../../../lib/applications/submitOutcome.ts";

/**
 * Asking the local worker to submit an application.
 *
 * This writes a row and nothing else. The portal has no browser and no
 * credentials; the listener on the Mac notices the request, claims it
 * atomically, and runs the same submitter that sent the two Home Chef
 * applications. Every guard runs there, freshly, immediately before the
 * click.
 *
 * The request is idempotent by construction: the update only matches an
 * application that is ready, unsubmitted, and not already requested. A
 * second click, a double submit, or a refresh-and-click-again all match
 * zero rows and change nothing.
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
  if (!applicationId) return NextResponse.json({ error: "no application id" }, { status: 400 });

  const { data: app } = await db.from("applications")
    .select("id,status,submitted_at,submit_requested_at,submit_outcome").eq("id", applicationId).maybeSingle();
  if (!app) return NextResponse.json({ error: "no such application" }, { status: 404 });
  if (app.submitted_at) return NextResponse.json({ error: "already submitted" }, { status: 409 });

  // An unresolved ambiguous outcome blocks a new request outright. The
  // employer may already hold this application, and asking again would
  // be exactly the duplicate the ambiguity exists to prevent.
  if (!retryAllowed(app.submit_outcome as any)) {
    return NextResponse.json({
      error: "this submission needs a person to establish what happened before it can be requested again",
    }, { status: 409 });
  }

  // Conditional, so concurrency is decided by the database. The stale
  // outcome is cleared in the same statement: a queued request must
  // never be displayed beside the outcome of the previous attempt.
  const { data: claimed, error } = await db.from("applications")
    .update({
      submit_requested_at: new Date().toISOString(),
      submit_started_at: null,
      submit_outcome: null,
      submit_outcome_at: null,
      submit_click_attempted_at: null,
    })
    .eq("id", applicationId)
    .eq("status", "READY_TO_SUBMIT")
    .is("submitted_at", null)
    .is("submit_requested_at", null)
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Zero rows means someone already asked. That is success, not failure.
  if (claimed?.length) {
    await db.rpc("record_application_event", {
      p_application_id: applicationId,
      p_event: "SUBMIT_REQUESTED",
      p_detail: `requested from the portal by ${auth.user.email ?? auth.user.id}. `
        + `The local worker will re-run every guard immediately before submitting.`,
    }).then(() => undefined, () => undefined);
  }

  return NextResponse.redirect(new URL(`/applications/${applicationId}/review`, request.url), { status: 303 });
}
