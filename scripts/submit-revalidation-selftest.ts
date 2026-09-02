/**
 * The stale-approval guard.
 *
 * SpotHero's Legal Operations Specialist sat in READY_TO_SUBMIT with
 * human_approved true from 2026-08-31, while its candidacy had since
 * become REJECT. These pin the rule that an approval authorizes acting
 * on the facts it was given against, and nothing later.
 */
import { revalidateBeforeSubmit, type SubmitFacts } from "../lib/applications/revalidate.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

/** A submission that should go through, so each case below changes one thing. */
const GOOD: SubmitFacts = {
  applicationId: "app-1",
  jobStatus: "OPEN",
  eligibility: "ELIGIBLE",
  candidacyVerdict: "APPLICATION_CANDIDATE",
  candidacyComputedAt: "2026-08-30T00:00:00Z",
  humanApproved: true,
  humanApprovedAt: "2026-08-31T04:46:42Z",
  authorizationMode: "HUMAN_APPROVED",
  allFieldsConfident: true,
  blockedAnswers: 0,
  requiredUnanswered: 0,
  jobVersionIsCurrent: true,
  storedArtifactSha256: "abc",
  approvedArtifactSha256: "abc",
  otherSubmittedOnOpening: false,
  currentAnswersSha256: "answers-1",
  approvedAnswersSha256: "answers-1",
  readbackPassed: true,
};
const codes = (f: Partial<SubmitFacts>) =>
  revalidateBeforeSubmit({ ...GOOD, ...f }).refusals.map((r) => r.code);

check("a submission with current facts intact passes", revalidateBeforeSubmit(GOOD).ok, codes({}).join(","));

// The SpotHero case itself.
{
  const c = codes({ candidacyVerdict: "REJECT", candidacyComputedAt: "2026-09-01T23:00:00Z" });
  check("a current REJECT blocks submission", c.includes("CANDIDACY_REFUSES"), c.join(","));
  check("and the approval is flagged as predating the verdict",
    c.includes("APPROVAL_PREDATES_CANDIDACY"), c.join(","));
  check("and the result is not ok",
    !revalidateBeforeSubmit({ ...GOOD, candidacyVerdict: "REJECT" }).ok, "");
}

check("MANUAL_REVIEW blocks submission",
  codes({ candidacyVerdict: "MANUAL_REVIEW" }).includes("CANDIDACY_REFUSES"), "");
check("a missing candidacy blocks submission",
  codes({ candidacyVerdict: null }).includes("NO_CURRENT_CANDIDACY"), "");
check("a human-reviewed STRETCH may still be submitted",
  revalidateBeforeSubmit({ ...GOOD, candidacyVerdict: "STRETCH" }).ok, "");

// An approval given before the current verdict was computed is stale
// even when the verdict itself is still submittable: it was given
// against different facts.
check("an approval older than the current verdict is refused",
  codes({ candidacyComputedAt: "2026-09-01T23:00:00Z" }).includes("APPROVAL_PREDATES_CANDIDACY"), "");
check("an approval newer than the verdict is fine",
  revalidateBeforeSubmit({ ...GOOD, candidacyComputedAt: "2026-08-01T00:00:00Z" }).ok, "");

check("a closed posting blocks submission",
  codes({ jobStatus: "CLOSED_OR_REMOVED" }).includes("POSTING_NOT_OPEN"), "");
check("lost eligibility blocks submission",
  codes({ eligibility: "INELIGIBLE" }).includes("NOT_ELIGIBLE"), "");
check("a materially changed posting blocks submission",
  codes({ jobVersionIsCurrent: false }).includes("POSTING_CHANGED"), "");
check("unconfident fields block submission",
  codes({ allFieldsConfident: false }).includes("FIELDS_NOT_CONFIDENT"), "");
check("a blocked answer blocks submission",
  codes({ blockedAnswers: 1 }).includes("BLOCKED_ANSWERS"), "");
check("an unanswered required field blocks submission",
  codes({ requiredUnanswered: 1 }).includes("REQUIRED_UNANSWERED"), "");
check("a changed resume artifact blocks submission",
  codes({ storedArtifactSha256: "different" }).includes("ARTIFACT_CHANGED"), "");
check("a missing approved artifact blocks submission",
  codes({ approvedArtifactSha256: null }).includes("NO_APPROVED_ARTIFACT"), "");
check("a duplicate submitted opening blocks submission",
  codes({ otherSubmittedOnOpening: true }).includes("ALREADY_SUBMITTED_ON_OPENING"), "");
check("a failed readback blocks submission",
  codes({ readbackPassed: false }).includes("READBACK_FAILED"), "");

// The answers are half of what was approved.
check("answers changed after approval block submission",
  codes({ currentAnswersSha256: "answers-2" }).includes("ANSWERS_CHANGED"), "");
check("an unapproved application is not judged on an answer binding",
  !codes({ humanApproved: false, approvedAnswersSha256: null, currentAnswersSha256: "x" })
    .includes("ANSWERS_CHANGED"), "");
check("unchanged answers pass",
  revalidateBeforeSubmit({ ...GOOD }).ok, "");
check("no authorization at all blocks submission",
  codes({ humanApproved: false, authorizationMode: null }).includes("NOT_AUTHORIZED"), "");

// Policy authorization is not a way around current facts.
check("POLICY_AUTHORIZED cannot submit a current REJECT",
  !revalidateBeforeSubmit({
    ...GOOD, humanApproved: false, authorizationMode: "POLICY_AUTHORIZED",
    candidacyVerdict: "REJECT",
  }).ok, "");

// Every refusal is reported, so one fix does not reveal another later.
{
  const r = revalidateBeforeSubmit({
    ...GOOD, candidacyVerdict: "REJECT", jobStatus: "CLOSED_OR_REMOVED",
    allFieldsConfident: false, storedArtifactSha256: "x",
  });
  check("all refusals are reported at once, not one at a time", r.refusals.length >= 4, String(r.refusals.length));
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
