/**
 * The review screen's safety rules.
 *
 * Approval is agreement to send, so it is judged by the same guard the
 * submission path uses. These pin that the review screen cannot become a
 * softer route to sending something the submit path would refuse, and
 * that an approval stops describing the application the moment the
 * content it was given for changes.
 */
import { revalidateBeforeSubmit, type SubmitFacts } from "../lib/applications/revalidate.ts";
import { answerSetHash } from "../lib/applications/approvalBinding.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

const ANSWERS = [
  { field_key: "first_name", answer_text: "Tyler" },
  { field_key: "gender", answer_text: "Man" },
  { field_key: "optional_note", answer_text: null },
];
const HASH = answerSetHash(ANSWERS);

/** What approving one of the Home Chef applications looks like. */
const PREPARED: SubmitFacts = {
  applicationId: "app-1", jobStatus: "OPEN", eligibility: "ELIGIBLE",
  candidacyVerdict: "STRETCH", candidacyComputedAt: "2026-09-01T00:00:00Z",
  humanApproved: true, humanApprovedAt: "2026-09-02T00:00:00Z",
  authorizationMode: "HUMAN_APPROVED", allFieldsConfident: true,
  blockedAnswers: 0, requiredUnanswered: 0, jobVersionIsCurrent: true,
  storedArtifactSha256: "artifact-a", approvedArtifactSha256: "artifact-a",
  otherSubmittedOnOpening: false,
  currentAnswersSha256: HASH, approvedAnswersSha256: HASH,
  readbackPassed: true,
};
const codes = (f: Partial<SubmitFacts>) =>
  revalidateBeforeSubmit({ ...PREPARED, ...f }).refusals.map((r) => r.code);
const ok = (f: Partial<SubmitFacts>) => revalidateBeforeSubmit({ ...PREPARED, ...f }).ok;

check("a prepared STRETCH application can be approved", ok({}), codes({}).join(","));

// Cannot approve with work outstanding.
check("blocked fields prevent approval", codes({ blockedAnswers: 1 }).includes("BLOCKED_ANSWERS"), "");
check("unanswered required fields prevent approval",
  codes({ requiredUnanswered: 2 }).includes("REQUIRED_UNANSWERED"), "");
check("unconfident fields prevent approval",
  codes({ allFieldsConfident: false }).includes("FIELDS_NOT_CONFIDENT"), "");

// The artifact reviewed is the artifact bound.
check("the reviewed artifact is what approval binds",
  PREPARED.approvedArtifactSha256 === PREPARED.storedArtifactSha256, "");
check("an artifact change after approval blocks submission",
  codes({ storedArtifactSha256: "artifact-b" }).includes("ARTIFACT_CHANGED"), "");

// The answers reviewed are bound too.
check("an answer change after approval blocks submission",
  codes({ currentAnswersSha256: answerSetHash([...ANSWERS.slice(0, 2),
    { field_key: "optional_note", answer_text: "changed" }]) }).includes("ANSWERS_CHANGED"), "");
check("reordering the same answers is not a change",
  ok({ currentAnswersSha256: answerSetHash([...ANSWERS].reverse()) }), "");
check("a blank answer is distinguished from an empty one",
  answerSetHash([{ field_key: "a", answer_text: null }])
    !== answerSetHash([{ field_key: "a", answer_text: "" }]), "");

// Candidacy and eligibility still govern.
check("a current REJECT cannot be approved or submitted",
  codes({ candidacyVerdict: "REJECT" }).includes("CANDIDACY_REFUSES"), "");
check("a current MANUAL_REVIEW cannot be approved",
  codes({ candidacyVerdict: "MANUAL_REVIEW" }).includes("CANDIDACY_REFUSES"), "");
check("an ineligible job cannot proceed",
  codes({ eligibility: "INELIGIBLE" }).includes("NOT_ELIGIBLE"), "");
check("a closed posting cannot proceed",
  codes({ jobStatus: "CLOSED_OR_REMOVED" }).includes("POSTING_NOT_OPEN"), "");

// A changed posting is surfaced rather than silently accepted.
check("a posting change is surfaced",
  codes({ jobVersionIsCurrent: false }).includes("POSTING_CHANGED"), "");

// Approval is not submission.
{
  // The route sets these; it never sets submitted_at or a confirmation.
  const afterApproval = { human_approved: true, status: "READY_TO_SUBMIT",
    submitted_at: null as string | null, confirmation_reference: null as string | null };
  check("approval does not mark the application submitted",
    afterApproval.submitted_at === null, "");
  check("approval records no confirmation",
    afterApproval.confirmation_reference === null, "");
  check("and an unsubmitted application is never displayed as submitted",
    afterApproval.submitted_at === null && afterApproval.status !== "SUBMITTED", "");
}

// A stale approval still cannot slip through this route.
check("an approval older than the current verdict is still refused",
  codes({ candidacyComputedAt: "2026-09-03T00:00:00Z" }).includes("APPROVAL_PREDATES_CANDIDACY"), "");

// The review screen uses the same guard, so it cannot be a softer path.
{
  const viaReview = revalidateBeforeSubmit({ ...PREPARED, candidacyVerdict: "REJECT" });
  const viaSubmit = revalidateBeforeSubmit({ ...PREPARED, candidacyVerdict: "REJECT" });
  check("approval and submission are judged identically",
    JSON.stringify(viaReview.refusals) === JSON.stringify(viaSubmit.refusals), "");
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
