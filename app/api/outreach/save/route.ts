import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";

/** Saves the person's edits to a note (OUTREACH_EDITED) or marks it sent (OUTREACH_SENT). */
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
  const action = String(form.get("action") ?? "save");
  if (!applicationId) return NextResponse.json({ error: "no application" }, { status: 400 });
  if (action === "sent") {
    const { error } = await db.rpc("record_application_event", {
      p_application_id: applicationId, p_event: "OUTREACH_SENT",
      p_detail: `The person marked the follow-up note as sent on ${new Date().toISOString()}.`,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const subject = String(form.get("subject") ?? "").slice(0, 300);
    const body = String(form.get("body") ?? "").slice(0, 6000);
    const recruiterName = String(form.get("recruiterName") ?? "").trim() || null;
    const recruiterEmail = String(form.get("recruiterEmail") ?? "").trim() || null;
    const { error } = await db.rpc("record_application_event", {
      p_application_id: applicationId, p_event: "OUTREACH_EDITED",
      p_detail: JSON.stringify({ recruiterName, recruiterEmail, subject, body, needsYourWords: /\[[^\]]+\]/.test(body), problems: [] }),
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.redirect(new URL(`/outreach#note-${applicationId}`, request.url), { status: 303 });
}
