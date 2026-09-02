/**
 * What must still be true at the moment of submission.
 *
 * An approval is a fact about a past moment: a person read *that*
 * application against *those* facts and said yes. The submit path
 * treated it as a fact about the present, checking only that the flag
 * was set and the artifact still hashed correctly.
 *
 * SpotHero's Legal Operations Specialist showed what that costs. It was
 * approved on 2026-08-31 at 04:46 and left in READY_TO_SUBMIT. The v4
 * re-extraction then moved its candidacy to REJECT. The approval was
 * still true about the past and completely wrong about the present, and
 * nothing between it and an outbound submission would have noticed.
 *
 * This runs immediately before submitting, on facts read fresh. It
 * decides nothing about candidacy or eligibility; it only refuses to act
 * on an approval the current facts no longer support. Model 3 and the
 * eligibility rules are untouched, and no history is rewritten: a
 * refusal leaves the application and its approval exactly as they were.
 */

export interface SubmitFacts {
  applicationId: string;
  jobStatus: string;
  eligibility: string | null;
  /** The newest verdict for this job, not the one approval was given against. */
  candidacyVerdict: string | null;
  candidacyComputedAt: string | null;
  humanApproved: boolean;
  humanApprovedAt: string | null;
  authorizationMode: string | null;
  allFieldsConfident: boolean;
  blockedAnswers: number;
  requiredUnanswered: number;
  jobVersionIsCurrent: boolean;
  storedArtifactSha256: string | null;
  approvedArtifactSha256: string | null;
  /** A submitted application on the same opening, excluding this one. */
  otherSubmittedOnOpening: boolean;
  /** Hash of the answers as they stand now. */
  currentAnswersSha256: string | null;
  /** Hash of the answers as they stood when approved. Null before approval. */
  approvedAnswersSha256: string | null;
  readbackPassed: boolean;
}

export interface Refusal { code: string; detail: string }

/**
 * Verdicts that may reach an outbound submission.
 *
 * STRETCH is here because a person reviewing a stretch and approving it
 * is a legitimate decision; the automation policy separately governs
 * what may be submitted with nobody reading it. REJECT and
 * MANUAL_REVIEW are not, whatever an older approval said.
 */
const SUBMITTABLE = new Set(["APPLICATION_CANDIDATE", "STRETCH"]);

export function revalidateBeforeSubmit(f: SubmitFacts): { ok: boolean; refusals: Refusal[] } {
  const refusals: Refusal[] = [];
  const no = (code: string, detail: string) => refusals.push({ code, detail });

  if (f.jobStatus !== "OPEN") no("POSTING_NOT_OPEN", `the posting is ${f.jobStatus}`);
  if (f.eligibility !== "ELIGIBLE") no("NOT_ELIGIBLE", `eligibility is now ${f.eligibility ?? "unknown"}`);

  if (f.candidacyVerdict === null) {
    no("NO_CURRENT_CANDIDACY", "this job has no candidacy verdict to check the approval against");
  } else if (!SUBMITTABLE.has(f.candidacyVerdict)) {
    no("CANDIDACY_REFUSES", `candidacy is now ${f.candidacyVerdict}`);
  }

  // An approval given before the current verdict was computed was given
  // against different facts. It is not evidence about the verdict that
  // exists now, so it cannot authorize acting on it.
  if (f.humanApproved && f.humanApprovedAt && f.candidacyComputedAt
      && f.candidacyComputedAt > f.humanApprovedAt) {
    no("APPROVAL_PREDATES_CANDIDACY",
      `approved ${f.humanApprovedAt}, but candidacy was recomputed ${f.candidacyComputedAt}`);
  }

  if (!f.jobVersionIsCurrent) no("POSTING_CHANGED", "the posting has a newer version than the one approved");

  if (!f.allFieldsConfident) no("FIELDS_NOT_CONFIDENT", "not every field is confidently answered");
  if (f.blockedAnswers > 0) no("BLOCKED_ANSWERS", `${f.blockedAnswers} answer(s) still blocked`);
  if (f.requiredUnanswered > 0) no("REQUIRED_UNANSWERED", `${f.requiredUnanswered} required field(s) unanswered`);

  if (!f.approvedArtifactSha256) no("NO_APPROVED_ARTIFACT", "no approved resume artifact is bound");
  else if (f.storedArtifactSha256 !== f.approvedArtifactSha256) {
    no("ARTIFACT_CHANGED",
      `the stored artifact ${f.storedArtifactSha256 ?? "(none)"} is not the approved ${f.approvedArtifactSha256}`);
  }

  // The answers are half of what was approved. A changed answer set
  // means the approval describes something other than what would be
  // sent, exactly as a changed artifact does.
  if (f.humanApproved && f.approvedAnswersSha256
      && f.currentAnswersSha256 !== f.approvedAnswersSha256) {
    no("ANSWERS_CHANGED", "the answers changed after this application was approved");
  }

  if (f.otherSubmittedOnOpening) no("ALREADY_SUBMITTED_ON_OPENING", "another application on this opening is already submitted");
  if (!f.readbackPassed) no("READBACK_FAILED", "the form readback did not pass");

  const authorized = f.humanApproved || f.authorizationMode === "POLICY_AUTHORIZED";
  if (!authorized) no("NOT_AUTHORIZED", "neither a person nor policy authorized this application");

  return { ok: refusals.length === 0, refusals };
}
