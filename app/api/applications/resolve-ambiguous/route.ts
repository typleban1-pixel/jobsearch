import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";

/**
 * Resolving a submission the system could not verify.
 *
 * An AMBIGUOUS outcome means the submit click may have reached the
 * employer and no confirmation could be read. Only a person can settle
 * that, by going and looking. Both answers are recorded as human
 * judgements and never disguised as machine verification.
 *
 * "received" marks the application submitted with HUMAN_CONFIRMED
 * provenance and the evidence the person says they checked.
 * "not-received" clears the ambiguity so an ordinary retry becomes
 * possible again, and says so in the audit trail.
 */
const EVIDENCE_LABEL: Record<string, string> = {
  CONFIRMATION_PAGE: "the employer's confirmation page",
  CONFIRMATION_EMAIL: "a confirmation email from the employer",
  EMPLOYER_PORTAL: "the employer's application portal",
  OTHER: "another source they described",
};

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
  const decision = String(form.get("decision") ?? "");
  const evidence = String(form.get("evidence") ?? "");
  const note = String(form.get("note") ?? "").slice(0, 500);
  const who = auth.user.email ?? auth.user.id;

  const { data: app } = await db.from("applications")
    .select("id,submit_outcome,submitted_at,submit_click_attempted_at").eq("id", applicationId).maybeSingle();
  if (!app) return NextResponse.json({ error: "no such application" }, { status: 404 });

  // Only ever available from ambiguity. This is not a general way to
  // mark something submitted.
  if (app.submit_outcome !== "AMBIGUOUS") {
    return NextResponse.json({ error: "this submission is not awaiting your judgement" }, { status: 409 });
  }
  if (app.submitted_at) return NextResponse.json({ error: "already submitted" }, { status: 409 });

  if (decision === "received") {
    if (!EVIDENCE_LABEL[evidence]) {
      return NextResponse.json({ error: "say what you checked" }, { status: 400 });
    }
    const { error } = await db.from("applications").update({
      status: "SUBMITTED",
      // The click is the moment the employer received it, not the moment
      // it was noticed.
      submitted_at: app.submit_click_attempted_at ?? new Date().toISOString(),
      submission_mode: "ASSISTED",
      confirmation_email_received: evidence === "CONFIRMATION_EMAIL",
      submit_outcome: "CONFIRMED",
      submit_outcome_at: new Date().toISOString(),
    }).eq("id", applicationId).eq("submit_outcome", "AMBIGUOUS");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await db.rpc("record_application_event", {
      p_application_id: applicationId,
      p_event: "SUBMISSION_CONFIRMED_BY_USER",
      p_detail: `${who} checked ${EVIDENCE_LABEL[evidence]} and confirmed the employer received `
        + `this application. The automated run could not verify it: submit was clicked at `
        + `${app.submit_click_attempted_at} and no confirmation could be read from the page. `
        + `This confirmation is HUMAN_CONFIRMED, not machine-verified. The original ambiguous `
        + `event and all browser evidence are unchanged.`
        + (note ? ` Note: ${note}` : ""),
    }).then(() => undefined, () => undefined);
  } else if (decision === "not-received") {
    const { error } = await db.from("applications").update({
      submit_outcome: "SAFE_STOP",
      submit_outcome_at: new Date().toISOString(),
      submit_click_attempted_at: null,
    }).eq("id", applicationId).eq("submit_outcome", "AMBIGUOUS");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await db.rpc("record_application_event", {
      p_application_id: applicationId,
      p_event: "SUBMISSION_RULED_OUT_BY_USER",
      p_detail: `${who} checked ${EVIDENCE_LABEL[evidence] ?? "the employer"} and established that `
        + `the application was NOT received, despite submit being clicked at `
        + `${app.submit_click_attempted_at}. The ambiguity is cleared and an ordinary retry is `
        + `allowed again. The original ambiguous event and all browser evidence are unchanged.`
        + (note ? ` Note: ${note}` : ""),
    }).then(() => undefined, () => undefined);
  } else {
    return NextResponse.json({ error: "unknown decision" }, { status: 400 });
  }

  return NextResponse.redirect(new URL(`/applications/${applicationId}/review`, request.url), { status: 303 });
}
