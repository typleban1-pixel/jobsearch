/**
 * Everything the review screen shows, in the shape it shows it.
 *
 * The page's job is to let a person see what is about to be sent. So
 * this returns the resume that is bound to the application, the answers
 * as the employer will read them, and the checks in plain language. The
 * audit fields come along too, but the page keeps them folded away.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidateBeforeSubmit, requiredBlocked } from "../applications/revalidate.ts";
import { answerSetHash } from "../applications/approvalBinding.ts";

export interface ReviewAnswer {
  fieldKey: string;
  question: string;
  answer: string | null;
  /** "Answered by you" / "Filled from verified profile" / "" */
  source: string;
  required: boolean;
  sensitive: boolean;
}

export interface ReviewCheck { label: string; state: "PASS" | "PENDING" | "FAIL"; detail?: string }

export interface ReviewData {
  applicationId: string;
  jobId: string;
  company: string;
  title: string;
  location: string;
  workArrangement: string | null;
  salary: string | null;
  candidacyLabel: string;
  candidacyVerdict: string | null;
  strongEvidence: string[];
  mainGap: string | null;
  descriptionExcerpt: string;
  keyRequirements: string[];
  jobUrl: string | null;

  /** Human phase, deliberately not the internal status. */
  phase: "PREPARED" | "APPROVED" | "SUBMITTED";
  /**
   * The authoritative terminal state, from the submission OUTCOME, which
   * takes precedence over any pre-submit readiness once a submission has
   * happened. CONFIRMED = employer confirmed receipt; UNCERTAIN = a click
   * may have transmitted but was never confirmed (must NEVER read as
   * success); SENT_UNCONFIRMED = submitted with no confirmation signal yet;
   * NONE = nothing submitted, the pre-submit review is what matters.
   */
  terminalState: "NONE" | "CONFIRMED" | "UNCERTAIN" | "SENT_UNCONFIRMED";
  submissionMode: string | null;
  submitQueued: boolean;
  submitRunning: boolean;
  submitOutcome: "CONFIRMED" | "SAFE_STOP" | "AMBIGUOUS" | "DECLINED" | null;
  clickAttemptedAt: string | null;
  approved: boolean;
  submittedAt: string | null;
  confirmed: boolean;

  resume: {
    id: string | null;
    hasArtifact: boolean;
    artifactSha256: string | null;
    contentSha256: string | null;
    rendererVersion: number | null;
    groundingVersion: number | null;
    linesAccepted: number;
  };
  answers: ReviewAnswer[];
  resumeChecks: ReviewCheck[];
  applicationChecks: ReviewCheck[];
  finalChecks: ReviewCheck[];
  /** Blocking problems, in plain English. Empty means approval may proceed. */
  warnings: string[];
  canApprove: boolean;
  /** How many employer fields were actually discovered. Zero means the form
   *  was never read, so there is nothing to review or approve here. */
  discoveredFields: number;
  /** Whether this provider can be submitted through the automated adapter. */
  automatable: boolean;
  /** The employer's own application URL, for the manual/external path. */
  applyUrl: string | null;
  providerLabel: string;
  /**
   * The single next action when the automated in-portal path is not
   * available (form not read, or a provider with no adapter): apply on the
   * employer's site. Guarantees this page is never a dead end.
   */
  externalAction: { label: string; href: string } | null;
  /** Why there is no in-portal action, in one plain sentence. */
  noActionReason: string | null;
  technical: Record<string, string | number | null>;
}

const SENSITIVE = /gender|ethnic|race|disability|veteran|hispanic/i;

/**
 * The authoritative terminal state of an application, decided by submission
 * OUTCOME and confirmation evidence -- never by pre-submit readiness. Pure so
 * the precedence rule (a confirmed submission is terminal and outranks any
 * stale readiness warning; an uncertain click is NEVER rendered as success)
 * is regression-tested without a database.
 */
export function classifyTerminalState(a: {
  submitOutcome?: string | null;
  confirmationReference?: string | null;
  confirmationEmailReceived?: boolean | null;
  submittedAt?: string | null;
}): "NONE" | "CONFIRMED" | "UNCERTAIN" | "SENT_UNCONFIRMED" {
  const hasConfirmation = Boolean(
    a.confirmationEmailReceived || a.confirmationReference || a.submitOutcome === "CONFIRMED");
  if (hasConfirmation) return "CONFIRMED";
  if (a.submitOutcome === "AMBIGUOUS") return "UNCERTAIN";
  if (a.submittedAt) return "SENT_UNCONFIRMED";
  return "NONE";
}

export async function loadReview(db: SupabaseClient, applicationId: string): Promise<ReviewData | null> {
  const { data: app } = await db.from("applications").select("*").eq("id", applicationId).maybeSingle();
  if (!app) return null;

  const [{ data: job }, { data: answersRaw }, { data: version }] = await Promise.all([
    db.from("jobs").select("*").eq("id", app.job_id).single(),
    db.from("application_answers")
      .select("field_key,field_label,question_text,answer_text,confidence_state,is_required,provenance")
      .eq("application_id", applicationId),
    db.from("job_versions").select("id,is_current").eq("id", app.job_version_id).maybeSingle(),
  ]);
  const [{ data: company }, { data: resume }, { data: candidacyRows }, { data: desc }, { data: reqs }] =
    await Promise.all([
      db.from("companies").select("name").eq("id", job!.company_id).single(),
      app.resume_id
        ? db.from("resumes").select("id,artifact_sha256,content_sha256,renderer_version,grounding_version,artifact_pdf,content")
            .eq("id", app.resume_id).maybeSingle()
        : Promise.resolve({ data: null } as any),
      db.from("job_candidacy").select("verdict,reason,reason_codes,hard_met,hard_total,created_at,core_gaps,occupational,direct_matches")
        .eq("job_id", app.job_id).order("created_at", { ascending: false }).limit(1),
      db.from("job_descriptions").select("description_text").eq("job_id", app.job_id).maybeSingle(),
      db.from("job_requirements").select("raw_text,is_hard_requirement")
        .eq("job_id", app.job_id).eq("is_hard_requirement", "HARD").limit(6),
    ]);

  const answers = (answersRaw ?? []);
  // "Needs your answer" means a REQUIRED employer field the system could not
  // resolve -- a genuine human blocker. An OPTIONAL blocked field (a deferred
  // demographic, a pronoun self-ID) is left blank on purpose and must never
  // read as a question waiting on Ty. This is the same required-only rule the
  // submit path applies; counting all BLOCKED answers here is what made the
  // review screen say "2 questions still need your answer" while also saying
  // "All required questions answered".
  const blocked = requiredBlocked(answers as any);
  const optionalBlocked = answers.filter((a: any) => !(a.is_required ?? true) && a.confidence_state === "BLOCKED").length;
  const unansweredRequired = answers.filter((a: any) => a.is_required && !a.answer_text).length;
  // Zero discovered fields is not low confidence -- there is nothing to be
  // confident ABOUT. The all_fields_confident flag defaults false and cannot
  // be recomputed with no answer rows, so an unprepared or unautomatable
  // application (Northern Trust: a WORKDAY form never snapshotted) otherwise
  // shows "not every field has a confident answer yet" over zero fields, with
  // no field to display and no control to fix it. That is the dead end.
  const discoveredFields = answers.length;
  const cand = candidacyRows?.[0] ?? null;

  const submittedOnOpening = await (async () => {
    if (!job?.canonical_opening_id || app.submitted_at) return false;
    const { data: subs } = await db.from("applications").select("job_id").not("submitted_at", "is", null);
    const ids = (subs ?? []).map((s: any) => s.job_id).filter((id: string) => id !== app.job_id);
    if (!ids.length) return false;
    const { data: js } = await db.from("jobs").select("canonical_opening_id").in("id", ids);
    return (js ?? []).some((j: any) => j.canonical_opening_id === job.canonical_opening_id);
  })();

  const guard = revalidateBeforeSubmit({
    applicationId,
    jobStatus: job!.status,
    eligibility: job!.eligibility,
    candidacyVerdict: cand?.verdict ?? null,
    candidacyComputedAt: cand?.created_at ?? null,
    // The material-qualification guard needs these; without them the review
    // page showed canApprove=true for a material-gap job the submit path
    // would refuse (Algo Trader / Sales Engineer).
    candidacyReasonCode: (cand as any)?.reason_codes?.[0] ?? null,
    hardMet: (cand as any)?.hard_met ?? null,
    hardTotal: (cand as any)?.hard_total ?? null,
    humanApproved: Boolean(app.human_approved),
    humanApprovedAt: app.human_approved_at ?? null,
    authorizationMode: app.authorization_mode ?? null,
    allFieldsConfident: Boolean(app.all_fields_confident),
    blockedAnswers: blocked,
    requiredUnanswered: unansweredRequired,
    jobVersionIsCurrent: Boolean(version?.is_current),
    storedArtifactSha256: resume?.artifact_sha256 ?? null,
    approvedArtifactSha256: app.approved_artifact_sha256 ?? resume?.artifact_sha256 ?? null,
    otherSubmittedOnOpening: submittedOnOpening,
    currentAnswersSha256: answerSetHash(answers as any),
    approvedAnswersSha256: app.approved_answers_sha256 ?? null,
    readbackPassed: true,
  });

  // Only the conditions a person must know about before approving. The
  // ones that describe "not approved yet" are what this page is for.
  const PRE_APPROVAL = new Set(["NOT_AUTHORIZED", "NO_APPROVED_ARTIFACT", "ARTIFACT_CHANGED"]);
  const SAID: Record<string, string> = {
    CANDIDACY_REFUSES: "This no longer looks like a good match, so it should not be sent.",
    NOT_ELIGIBLE: "This job no longer meets your eligibility rules.",
    POSTING_NOT_OPEN: "The job posting is no longer open.",
    POSTING_CHANGED: "The job posting changed after this application was prepared.",
    ALREADY_SUBMITTED_ON_OPENING: "You have already applied to this opening.",
    ANSWERS_CHANGED: "The answers changed after this application was approved.",
    BLOCKED_ANSWERS: `${blocked} question${blocked === 1 ? "" : "s"} still need your answer.`,
    REQUIRED_UNANSWERED: `${unansweredRequired} required field${unansweredRequired === 1 ? "" : "s"} are unanswered.`,
    FIELDS_NOT_CONFIDENT: "Not every field has a confident answer yet.",
    MATERIAL_QUALIFICATION_GAP: "This role's core qualifications are not established by your verified evidence, so it should not be submitted automatically; review it and apply manually if you choose.",
  };
  const warnings = guard.refusals
    .filter((r) => !PRE_APPROVAL.has(r.code))
    // A confidence complaint over zero discovered fields is not a real
    // warning: the honest state is "the form was not read", surfaced as an
    // external action below rather than as an unfixable "needs another look".
    .filter((r) => !(r.code === "FIELDS_NOT_CONFIDENT" && discoveredFields === 0))
    .map((r) => SAID[r.code] ?? r.detail);

  const contentLines = Array.isArray((resume?.content as any)?.lines) ? (resume!.content as any).lines.length : 0;
  const hasArtifact = Boolean(resume?.artifact_pdf && resume?.artifact_sha256);

  const resumeChecks: ReviewCheck[] = [
    { label: "Tailored resume created", state: resume ? "PASS" : "FAIL" },
    { label: "Resume claims passed grounding checks", state: resume?.grounding_version ? "PASS" : "FAIL" },
    { label: "Exact PDF saved for this application", state: hasArtifact ? "PASS" : "FAIL" },
  ];
  const applicationChecks: ReviewCheck[] = [
    { label: "All required questions answered", state: unansweredRequired === 0 ? "PASS" : "FAIL" },
    { label: "No unanswered questions need you", state: blocked === 0 ? "PASS" : "FAIL" },
    { label: "Current job posting is still open", state: job!.status === "OPEN" ? "PASS" : "FAIL" },
    { label: "Still allowed by current candidacy and eligibility",
      state: (job!.eligibility === "ELIGIBLE" && (cand?.verdict === "APPLICATION_CANDIDATE" || cand?.verdict === "STRETCH"))
        ? "PASS" : "FAIL" },
  ];
  // Not a check that has passed. It is a thing that has not happened.
  const finalChecks: ReviewCheck[] = [
    { label: "Live form fill and readback happen when submission begins", state: "PENDING" },
  ];

  const LABEL: Record<string, string> = {
    APPLICATION_CANDIDATE: "Strong match", STRETCH: "Worth considering",
    MANUAL_REVIEW: "Needs review", REJECT: "Skip",
  };

  const occ = Array.isArray(cand?.occupational) ? cand!.occupational : [];
  const gapFromOcc = occ.filter((o: any) => !o.met).map((o: any) => o.concept);
  const gaps = [...(cand?.core_gaps ?? []), ...gapFromOcc];

  const description = desc?.description_text ?? "";
  const phase: ReviewData["phase"] = app.submitted_at ? "SUBMITTED" : app.human_approved ? "APPROVED" : "PREPARED";
  // Terminal state is decided by the submission OUTCOME, not by readiness.
  // CONFIRMED wins outright; AMBIGUOUS is UNCERTAIN and must never render as
  // success; a submitted_at with neither is SENT_UNCONFIRMED.
  const terminalState: ReviewData["terminalState"] = classifyTerminalState({
    submitOutcome: app.submit_outcome, confirmationReference: app.confirmation_reference,
    confirmationEmailReceived: app.confirmation_email_received, submittedAt: app.submitted_at });

  // The escape hatch that keeps this page from ever being a dead end. When
  // there is no in-portal action to offer -- the form was never read, or the
  // provider has no automated adapter -- the honest next step is the
  // employer's own application. Greenhouse is the only productionised
  // submitter today; every other provider hands off to the employer's site.
  const ATS_LABEL: Record<string, string> = { WORKDAY: "Workday", GREENHOUSE: "Greenhouse", LEVER: "Lever", ASHBY: "Ashby" };
  const provider = String(job!.source ?? "");
  const providerLabel = ATS_LABEL[provider] ?? provider;
  const automatable = provider === "GREENHOUSE" && !app.blocked_reason;
  const applyUrl = (job as any)!.application_form_url ?? job!.url ?? null;
  const formNotRead = discoveredFields === 0;
  // A qualification/candidacy refusal means approval is genuinely prohibited:
  // the honest state is not "cannot be approved" with no control (a dead end
  // the person actually hit), but "this will not be submitted automatically;
  // apply manually if you want". Even a fully automatable Greenhouse job gets
  // a manual action in that case, matching what the /jobs board now shows.
  const qualificationBlocked = !app.human_approved && guard.refusals.some(
    (r) => r.code === "MATERIAL_QUALIFICATION_GAP" || r.code === "CANDIDACY_REFUSES"
      || r.code === "NOT_ELIGIBLE" || r.code === "NO_CURRENT_CANDIDACY" || r.code === "APPROVAL_PREDATES_CANDIDACY");
  const externalOnly = !app.submitted_at && (formNotRead || Boolean(app.blocked_reason) || !automatable || qualificationBlocked);
  const externalAction = externalOnly && applyUrl
    ? { label: `Apply on ${providerLabel}`, href: applyUrl } : null;
  const noActionReason = externalOnly
    ? (formNotRead
        ? `${providerLabel}'s form has not been read by the system, so there is nothing to review or approve here. Apply on the employer's site.`
        : qualificationBlocked
        ? `This will not be submitted automatically because its core qualifications are not established by your verified evidence. You can still apply on the employer's site if you want.`
        : `${providerLabel} cannot be submitted through the automated adapter. Apply on the employer's site.`)
    : null;

  return {
    applicationId, jobId: app.job_id,
    company: company?.name ?? "Unknown",
    title: job!.title,
    location: [job!.city, job!.state].filter(Boolean).join(", ") || job!.location_raw || "",
    workArrangement: job!.remote_policy === "FULLY_REMOTE" ? "Remote"
      : job!.remote_policy === "HYBRID" ? "Hybrid" : job!.remote_policy === "ONSITE" ? "On site" : null,
    salary: job!.salary_min
      ? `$${Math.round(job!.salary_min / 1000)}k` + (job!.salary_max ? `–$${Math.round(job!.salary_max / 1000)}k` : "")
      : null,
    candidacyLabel: LABEL[cand?.verdict ?? ""] ?? "Needs review",
    candidacyVerdict: cand?.verdict ?? null,
    strongEvidence: [],
    mainGap: gaps.length ? gaps.join(", ") : null,
    descriptionExcerpt: description.slice(0, 700),
    keyRequirements: (reqs ?? []).map((r: any) => String(r.raw_text)).slice(0, 6),
    jobUrl: job!.url ?? null,
    phase,
    terminalState,
    submissionMode: app.submission_mode ?? null,
    submitQueued: Boolean(app.submit_requested_at && !app.submit_started_at),
    submitRunning: Boolean(app.submit_requested_at && app.submit_started_at),
    submitOutcome: app.submit_outcome ?? null,
    clickAttemptedAt: app.submit_click_attempted_at ?? null,
    approved: Boolean(app.human_approved),
    submittedAt: app.submitted_at ?? null,
    confirmed: Boolean(app.confirmation_email_received || app.confirmation_reference),
    resume: {
      id: resume?.id ?? null,
      hasArtifact,
      artifactSha256: resume?.artifact_sha256 ?? null,
      contentSha256: resume?.content_sha256 ?? null,
      rendererVersion: resume?.renderer_version ?? null,
      groundingVersion: resume?.grounding_version ?? null,
      linesAccepted: contentLines,
    },
    answers: answers.map((a: any) => ({
      fieldKey: a.field_key,
      question: a.question_text || a.field_label || a.field_key,
      answer: a.answer_text,
      source: a.provenance === "USER_RESPONSE" ? "Answered by you"
        : a.provenance === "PROFILE" || a.provenance === "EMPLOYMENT_RECORD" ? "Filled from verified profile"
        : a.confidence_state === "DERIVED" ? "Worked out from your profile" : "",
      required: Boolean(a.is_required),
      sensitive: SENSITIVE.test(`${a.field_label ?? ""} ${a.question_text ?? ""}`),
    })).sort((x, y) => Number(y.required) - Number(x.required)),
    resumeChecks, applicationChecks, finalChecks,
    warnings,
    canApprove: warnings.length === 0 && !app.submitted_at && !app.human_approved
      && !app.submit_requested_at && app.submit_outcome !== "AMBIGUOUS"
      // Never "approvable" with no fields: there is nothing to approve.
      && discoveredFields > 0,
    discoveredFields, automatable, applyUrl, providerLabel, externalAction, noActionReason,
    technical: {
      applicationId, jobId: app.job_id,
      canonicalOpeningId: job!.canonical_opening_id ?? null,
      resumeId: app.resume_id ?? null,
      artifactSha256: resume?.artifact_sha256 ?? null,
      contentSha256: resume?.content_sha256 ?? null,
      jobVersionId: app.job_version_id ?? null,
      jobVersionIsCurrent: String(Boolean(version?.is_current)),
      formSnapshotHash: app.form_snapshot_hash ?? null,
      answerSetSha256: answerSetHash(answers as any),
      approvedAnswersSha256: app.approved_answers_sha256 ?? null,
      approvedArtifactSha256: app.approved_artifact_sha256 ?? null,
      candidacyVerdict: cand?.verdict ?? null,
      candidacyComputedAt: cand?.created_at ?? null,
      internalStatus: app.status,
    },
  };
}
