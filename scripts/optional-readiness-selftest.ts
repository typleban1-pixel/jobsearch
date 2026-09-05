/**
 * Locks the optional-field readiness semantics:
 *   - a REQUIRED blocked field -> NOT ready;
 *   - an OPTIONAL blocked field with every required field verified -> may be ready;
 *   - a field of UNKNOWN requiredness -> treated as required (fail closed) -> NOT ready.
 *   node scripts/optional-readiness-selftest.ts
 */
import { requiredBlocked, revalidateBeforeSubmit, type SubmitFacts } from "../lib/applications/revalidate.ts";
let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

// requiredBlocked: fail-closed required-only counting
ok(requiredBlocked([{ is_required: true, confidence_state: "BLOCKED" }]) === 1, "required blocked counts");
ok(requiredBlocked([{ is_required: false, confidence_state: "BLOCKED" }]) === 0, "optional blocked does NOT count");
ok(requiredBlocked([{ is_required: null, confidence_state: "BLOCKED" }]) === 1, "unknown requiredness fails closed (counts)");
ok(requiredBlocked([{ confidence_state: "BLOCKED" }]) === 1, "missing is_required fails closed (counts)");
ok(requiredBlocked([
  { is_required: true, confidence_state: "VERIFIED" },
  { is_required: false, confidence_state: "BLOCKED" },
  { is_required: false, confidence_state: "LOW_STAKES_SURVEY" },
]) === 0, "required verified + optional blocked/low-stakes -> 0 required-blocked");

// revalidate end to end
const GOOD: SubmitFacts = {
  applicationId: "t", jobStatus: "OPEN", eligibility: "ELIGIBLE",
  candidacyVerdict: "STRETCH", candidacyComputedAt: "2026-09-05T00:00:00Z",
  humanApproved: false, humanApprovedAt: null, authorizationMode: "POLICY_AUTHORIZED",
  allFieldsConfident: true, blockedAnswers: 0, requiredUnanswered: 0,
  jobVersionIsCurrent: true, storedArtifactSha256: "abc", approvedArtifactSha256: "abc",
  otherSubmittedOnOpening: false, currentAnswersSha256: "h", approvedAnswersSha256: null, readbackPassed: true,
};
ok(revalidateBeforeSubmit(GOOD).ok, "clean POLICY_AUTHORIZED facts -> READY");
{
  // required blocked: recompute would set allFieldsConfident false AND blockedAnswers>0
  const r = revalidateBeforeSubmit({ ...GOOD, allFieldsConfident: false, blockedAnswers: 1 });
  ok(!r.ok && r.refusals.some((x) => x.code === "BLOCKED_ANSWERS"), "required blocked -> NOT READY (BLOCKED_ANSWERS)");
}
{
  // optional blocked only: requiredBlocked=0, all_fields_confident stays true (recompute ignores optional)
  const r = revalidateBeforeSubmit({ ...GOOD, allFieldsConfident: true, blockedAnswers: 0 });
  ok(r.ok, "optional blocked only (required all verified) -> READY");
}
{
  // ambiguous requiredness contributes to requiredBlocked (fail closed) -> blockedAnswers>0 -> NOT ready
  const n = requiredBlocked([{ is_required: null, confidence_state: "BLOCKED" }, { is_required: true, confidence_state: "VERIFIED" }]);
  const r = revalidateBeforeSubmit({ ...GOOD, allFieldsConfident: false, blockedAnswers: n });
  ok(!r.ok, "ambiguous requiredness fails closed -> NOT READY", `blockedAnswers=${n}`);
}
console.log(bad ? `\n${bad} FAILED` : `\noptional-readiness-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
