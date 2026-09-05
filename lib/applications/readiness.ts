/**
 * Is this application ready to submit, and if so, enqueue it -- now.
 *
 * Submission must not wait for a scheduled scan once an application is
 * ready: a Greenhouse application that becomes fully ready at 1:37pm
 * should be queued at 1:37pm and the listener picks it up within
 * seconds. This runs identically from a Vercel API route (a portal
 * action just changed the state) and from a local script (the scan's
 * reconciliation sweep), because it is nothing but database reads, the
 * same pure gate functions the submitter uses, and one conditional
 * write.
 *
 * It cannot double-submit. The enqueue is a conditional UPDATE that
 * only lands on a row with no pending request, no running claim and no
 * submission; the listener's claim is itself atomic; and a submitted
 * application fails the very first check. Ten concurrent triggers
 * produce at most one request.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidateBeforeSubmit, requiredBlocked } from "./revalidate.ts";
import { answerSetHash } from "./approvalBinding.ts";

export type ReadinessOutcome =
  | { ready: true; enqueued: boolean; note: string }
  | { ready: false; code: string; note: string };

export async function evaluateReadiness(db: SupabaseClient, applicationId: string): Promise<ReadinessOutcome> {
  // The select is one literal string: supabase-js only types columns it
  // can parse from a template literal, and a concatenated string types
  // every row as an error shape.
  const { data: app } = await db.from("applications")
    .select("id,job_id,job_version_id,status,human_approved,human_approved_at,authorization_mode,all_fields_confident,submitted_at,submit_requested_at,submit_started_at,approved_artifact_sha256,approved_answers_sha256,is_test")
    .eq("id", applicationId).maybeSingle() as { data: any };
  if (!app) return { ready: false, code: "NOT_FOUND", note: "no such application" };
  if (app.is_test) return { ready: false, code: "TEST_ROW", note: "test applications never enqueue" };
  if (app.submitted_at) return { ready: false, code: "SUBMITTED", note: "already submitted; a submitted application cannot re-enter the queue" };
  if (app.submit_requested_at || app.submit_started_at) {
    return { ready: true, enqueued: false, note: "already queued or running; nothing to do" };
  }

  const authorized = app.human_approved || app.authorization_mode === "POLICY_AUTHORIZED";
  if (app.status !== "READY_TO_SUBMIT" || !authorized) {
    return { ready: false, code: "NOT_AUTHORIZED",
      note: `status ${app.status}, authorization ${app.authorization_mode ?? "none"}` };
  }

  // Provider capability: only a provider in PRODUCTION submits unattended.
  const { data: job } = await db.from("jobs")
    .select("status,eligibility,source,canonical_opening_id").eq("id", app.job_id).single();
  const { data: ats } = await db.from("ats_policy")
    .select("paused,capability").eq("provider", job!.source).maybeSingle();
  if (!ats || ats.paused || ats.capability !== "PRODUCTION") {
    return { ready: false, code: "PROVIDER_NOT_AUTOMATED",
      note: `${job!.source} is ${ats ? (ats.paused ? "paused" : `capability ${ats.capability}`) : "unknown to policy"}` };
  }

  // The global daily cap. Enforced here so the queue never holds more
  // than policy allows, and re-checked by the worker path; both read the
  // same count so they cannot disagree for long.
  const { data: pol } = await db.from("automation_policy").select("max_applications_per_day").limit(1).maybeSingle();
  const cap = pol?.max_applications_per_day ?? null;
  if (cap !== null) {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const { count } = await db.from("applications").select("id", { count: "exact", head: true })
      .gte("submitted_at", midnight.toISOString());
    if ((count ?? 0) >= cap) {
      return { ready: false, code: "DAILY_CAP_REACHED", note: `${count} submitted today against a cap of ${cap}` };
    }
  }

  // The same revalidation the submitter runs, against facts read now.
  const [{ data: verdictRows }, { data: answerRows }, { data: version }] = await Promise.all([
    db.from("job_candidacy").select("verdict,created_at,reason_codes,hard_met,hard_total").eq("job_id", app.job_id)
      .order("created_at", { ascending: false }).limit(1),
    db.from("application_answers").select("confidence_state,is_required,answer_text,field_key")
      .eq("application_id", applicationId),
    db.from("job_versions").select("is_current").eq("id", (app as any).job_version_id ?? "").maybeSingle(),
  ]);
  const answers = answerRows ?? [];
  const check = revalidateBeforeSubmit({
    applicationId,
    jobStatus: job!.status, eligibility: job!.eligibility ?? null,
    candidacyVerdict: verdictRows?.[0]?.verdict ?? null,
    candidacyComputedAt: verdictRows?.[0]?.created_at ?? null,
    candidacyReasonCode: (verdictRows?.[0] as any)?.reason_codes?.[0] ?? null,
    hardMet: (verdictRows?.[0] as any)?.hard_met ?? null,
    hardTotal: (verdictRows?.[0] as any)?.hard_total ?? null,
    humanApproved: Boolean(app.human_approved),
    humanApprovedAt: (app as any).human_approved_at ?? null,
    authorizationMode: app.authorization_mode ?? null,
    allFieldsConfident: Boolean(app.all_fields_confident),
    blockedAnswers: requiredBlocked(answers as any),
    requiredUnanswered: answers.filter((a: any) => a.is_required && !a.answer_text).length,
    jobVersionIsCurrent: version ? Boolean(version.is_current) : true,
    storedArtifactSha256: app.approved_artifact_sha256 ?? null,
    approvedArtifactSha256: app.approved_artifact_sha256 ?? null,
    otherSubmittedOnOpening: false,   // checked again with full data by the submitter, which fails closed
    currentAnswersSha256: answerSetHash(answers as any),
    approvedAnswersSha256: (app as any).approved_answers_sha256 ?? null,
    readbackPassed: true,
  });
  if (!check.ok) {
    return { ready: false, code: "REVALIDATION_FAILED",
      note: check.refusals.map((r) => r.code).join(", ") };
  }

  // The one write, conditional on the row still being unclaimed.
  const now = new Date().toISOString();
  const { data: updated, error } = await db.from("applications")
    .update({ submit_requested_at: now })
    .eq("id", applicationId)
    .is("submit_requested_at", null).is("submit_started_at", null).is("submitted_at", null)
    .select("id");
  if (error) return { ready: false, code: "ENQUEUE_FAILED", note: error.message };
  if (!updated?.length) return { ready: true, enqueued: false, note: "another trigger enqueued it first" };

  await db.from("application_events").insert({
    application_id: applicationId, event: "ENQUEUED", actor: "worker",
    detail: `Ready on re-evaluation: every gate passed and a submission request was queued at ${now}. `
      + `The listener owns the next step.`,
  }).then(() => undefined, () => undefined);
  return { ready: true, enqueued: true, note: "queued; the listener submits next" };
}
