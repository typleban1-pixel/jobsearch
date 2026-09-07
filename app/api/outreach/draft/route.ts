import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";
import { composeDraftFor } from "../../../../lib/outreach/draft.ts";

/**
 * "Send a note": composes the follow-up for one application from approved
 * material and records it, then lands on the Outreach page at that note.
 * A recruiter's name or email, when the person knows one, is typed by the
 * person; nothing here looks anyone up.
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
  const recruiterName = String(form.get("recruiterName") ?? "").trim() || null;
  const recruiterEmail = String(form.get("recruiterEmail") ?? "").trim() || null;
  if (!applicationId) return NextResponse.json({ error: "no application" }, { status: 400 });
  const made = await composeDraftFor(db, applicationId, { name: recruiterName, email: recruiterEmail });
  if (!made) return NextResponse.json({ error: "no such application" }, { status: 404 });
  const { error } = await db.rpc("record_application_event", {
    p_application_id: applicationId, p_event: "OUTREACH_DRAFTED",
    p_detail: JSON.stringify({ recruiterName, recruiterEmail, subject: made.draft.subject, body: made.draft.body,
      needsYourWords: made.draft.needsYourWords, problems: made.draft.problems }),
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.redirect(new URL(`/outreach#note-${applicationId}`, request.url), { status: 303 });
}
