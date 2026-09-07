import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";
import { revalidateBeforeSubmit } from "../../../../lib/applications/revalidate.ts";
import { answerSetHash } from "../../../../lib/applications/approvalBinding.ts";

/**
 * Approving an application.
 *
 * Approval records that a person read a specific resume and a specific
 * set of answers and agreed to them. It binds all three hashes, so if
 * any of them moves afterwards the submission guard refuses rather than
 * treating the old approval as though it described the new content.
 *
 * It then REQUESTS submission. Approval is the decision to send, and
 * making a person click twice for one decision meant approved
 * applications sat unsent indefinitely.
 *
 * Requesting is not sending. Nothing here touches an employer: the
 * worker picks the request up and runs every gate again -- revalidation,
 * duplicates, candidacy, the exact artifact and answer hashes, field
 * completeness, the live read-back -- and refuses any provider whose
 * adapter is not PRODUCTION. Workday stays unsubmittable through this
 * route as through every other.
 *
 * The same guard the submit path runs decides whether approval is
 * allowed at all, so this cannot become a weaker parallel route to
 * sending something the submit path would refuse.
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
  // The review page's "Approve anyway": the person has read the qualification
  // gap and chooses to apply. Only that refusal may be waived, and only here.
  const acceptGap = String(form.get("acceptQualificationGap") ?? "") === "1";

  const { data: app } = await db.from("applications").select("*").eq("id", applicationId).maybeSingle();
  if (!app) return NextResponse.json({ error: "no such application" }, { status: 404 });
  if (app.submitted_at) return NextResponse.json({ error: "already submitted" }, { status: 409 });

  const [{ data: job }, { data: answers }, { data: version }] = await Promise.all([
    db.from("jobs").select("status,eligibility,canonical_opening_id").eq("id", app.job_id).single(),
    db.from("application_answers").select("field_key,answer_text,confidence_state,is_required")
      .eq("application_id", applicationId),
    db.from("job_versions").select("is_current").eq("id", app.job_version_id).maybeSingle(),
  ]);
  const { data: verdicts } = await db.from("job_candidacy").select("verdict,created_at,reason_codes,hard_met,hard_total")
    .eq("job_id", app.job_id).order("created_at", { ascending: false }).limit(1);
  const { data: resume } = app.resume_id
    ? await db.from("resumes").select("artifact_sha256,content_sha256").eq("id", app.resume_id).maybeSingle()
    : { data: null } as any;

  const rows = answers ?? [];
  const currentAnswers = answerSetHash(rows as any);

  // Approving is agreeing to send. Anything that would stop the send
  // stops the approval, judged on the same rules.
  const check = revalidateBeforeSubmit({
    applicationId,
    jobStatus: job?.status ?? "unknown",
    eligibility: job?.eligibility ?? null,
    candidacyVerdict: verdicts?.[0]?.verdict ?? null,
    candidacyComputedAt: verdicts?.[0]?.created_at ?? null,
    candidacyReasonCode: (verdicts?.[0] as any)?.reason_codes?.[0] ?? null,
    hardMet: (verdicts?.[0] as any)?.hard_met ?? null,
    hardTotal: (verdicts?.[0] as any)?.hard_total ?? null,
    // Judged as though already approved with this content, so the guard
    // reports what would stop the submission rather than reporting that
    // it has not been approved yet.
    humanApproved: true,
    humanApprovedAt: new Date().toISOString(),
    authorizationMode: "HUMAN_APPROVED",
    allFieldsConfident: Boolean(app.all_fields_confident),
    blockedAnswers: rows.filter((a: any) => a.confidence_state === "BLOCKED").length,
    requiredUnanswered: rows.filter((a: any) => a.is_required && a.answer_text == null).length,
    jobVersionIsCurrent: Boolean(version?.is_current),
    storedArtifactSha256: resume?.artifact_sha256 ?? null,
    approvedArtifactSha256: resume?.artifact_sha256 ?? null,
    currentAnswersSha256: currentAnswers,
    approvedAnswersSha256: currentAnswers,
    otherSubmittedOnOpening: false,
    readbackPassed: true,
  });
  const gapOnly = check.refusals.length > 0 && check.refusals.every((r) => r.code === "MATERIAL_QUALIFICATION_GAP");
  if (!check.ok && !(gapOnly && acceptGap)) {
    return NextResponse.json(
      { error: "cannot approve", refusals: check.refusals }, { status: 409 });
  }

  const now = new Date().toISOString();
  const { error } = await db.from("applications").update({
    human_approved: true,
    human_approved_at: now,
    authorization_mode: "HUMAN_APPROVED",
    approved_artifact_sha256: resume?.artifact_sha256 ?? null,
    approved_content_sha256: resume?.content_sha256 ?? null,
    approved_answers_sha256: currentAnswers,
    status: "READY_TO_SUBMIT",
    // Approval IS the authorization to send.
    //
    // This used to stop at READY_TO_SUBMIT and wait for a second,
    // separate action, so an approved application sat indefinitely: the
    // Stripe AutoFile Specialist passed every gate at 01:37 and was
    // never submitted, because nothing had set this column.
    //
    // Requesting is not sending. The worker still runs revalidation,
    // the duplicate and candidacy checks, the exact-artifact and
    // answer-hash bindings, field completeness and the live read-back
    // before anything reaches an employer, and it refuses providers
    // whose adapter is not PRODUCTION -- which is why this cannot
    // submit Workday.
    submit_requested_at: now,
  }).eq("id", applicationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Written through a narrow SECURITY DEFINER function: the browser has
  // no INSERT grant on application_events, so the audit trail still
  // cannot be edited from a page. See migration 0071.
  //
  // A failure here must not lose the approval that already committed, so
  // it is reported rather than thrown.
  const { error: auditErr } = await db.rpc("record_application_approval", {
    p_application_id: applicationId,
    p_detail: `approved from the review screen by ${auth.user.email ?? auth.user.id}. `
      + `artifact ${resume?.artifact_sha256 ?? "(none)"}, answers ${currentAnswers}, `
      + `${rows.length} answers. Nothing has been submitted.`
      + (gapOnly && acceptGap ? ` The person chose to apply despite the qualification gap: ${check.refusals[0]!.detail}.` : ""),
  });
  if (auditErr) console.error("approval recorded but the audit event failed:", auditErr.message);

  return NextResponse.redirect(new URL(`/applications/${applicationId}/review?approved=1`, request.url), { status: 303 });
}
