/**
 * The automation policy decision, and the two bugs that nearly shipped.
 *
 *   node scripts/policy-selftest.ts
 *
 * A policy that authorizes unattended submission is only as good as the
 * cases where it says no, so almost everything here asserts a refusal.
 */
import { decide, type Candidate, type AutomationPolicy, type Switches } from "../lib/automation/policy.ts";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};

const POLICY: AutomationPolicy = {
  autoSubmitCandidacy: ["APPLICATION_CANDIDATE"], reviewCandidacy: ["STRETCH", "MANUAL_REVIEW"],
  minFit: null, allowUnknownSalary: true, baseSalaryFloor: 85_000,
  maxApplicationsPerDay: null, requireResumeReview: false,
  excludedCompanyIds: [], excludedJobIds: [],
};
const ON: Switches = { globalAutoSubmit: true, byProvider: { GREENHOUSE: { paused: false, capability: "PRODUCTION" } } };
const OFF: Switches = { globalAutoSubmit: false, byProvider: ON.byProvider };

const job = (over: Partial<Candidate> = {}): Candidate => ({
  jobId: "j", companyId: "c", provider: "GREENHOUSE",
  candidacy: "APPLICATION_CANDIDATE", eligibility: "ELIGIBLE", fit: 70,
  candidacyReasonCode: "MEETS_HARD_REQUIREMENTS", hardMet: 5, hardTotal: 8,
  baseSalaryMin: 120_000, allFieldsConfident: true, blockedAnswers: 0,
  resumeClaimsAllGrounded: true, artifactValid: true, submittedToday: 0, ...over,
});

console.log("the happy path");
check("a clean candidate submits", decide(job(), POLICY, ON).action === "SUBMIT");

console.log("\na switch narrows, and can never widen");
// The bug: kill switches were checked first, so with auto-submit off
// every job became REVIEW, REJECTs included, and the worker would have
// prepared an application for a store associate role.
check("a REJECT stays SKIP with the switch OFF",
  decide(job({ candidacy: "REJECT" }), POLICY, OFF).action === "SKIP",
  decide(job({ candidacy: "REJECT" }), POLICY, OFF).why);
check("a REJECT stays SKIP with the switch ON",
  decide(job({ candidacy: "REJECT" }), POLICY, ON).action === "SKIP");
check("an ineligible job stays SKIP with the switch OFF",
  decide(job({ eligibility: "INELIGIBLE" }), POLICY, OFF).action === "SKIP");
check("a below-floor job stays SKIP with the switch OFF",
  decide(job({ baseSalaryMin: 60_000 }), POLICY, OFF).action === "SKIP");
check("an unscored job stays SKIP with the switch OFF",
  decide(job({ candidacy: null }), POLICY, OFF).action === "SKIP");
check("a qualifying candidate demotes to REVIEW when switched off",
  decide(job(), POLICY, OFF).action === "REVIEW");

console.log("\nthe enum is the database's, not a paraphrase");
// The bug: the policy said "CANDIDATE", which matches none of the four
// real values, so every job would have been skipped as unscored while
// the policy looked correct.
check("APPLICATION_CANDIDATE is the value that submits",
  decide(job({ candidacy: "APPLICATION_CANDIDATE" }), POLICY, ON).action === "SUBMIT");
check("STRETCH is prepared but never submitted",
  decide(job({ candidacy: "STRETCH" }), POLICY, ON).action === "REVIEW");
check("MANUAL_REVIEW goes to review, not skip",
  decide(job({ candidacy: "MANUAL_REVIEW" }), POLICY, ON).action === "REVIEW");

console.log("\nper-provider switches");
check("a paused provider is skipped entirely, not prepared",
  decide(job(), POLICY, { ...ON, byProvider: { GREENHOUSE: { paused: true, capability: "PRODUCTION" } } }).action === "SKIP");
// A STRETCH job on a provider with no adapter used to be routed to
// REVIEW, and the worker then tried to prepare it and failed on "no form
// snapshot is implemented for LEVER". Nothing is attempted for a
// provider that cannot do the work.
check("a provider with no adapter is skipped, even for review",
  decide(job({ provider: "LEVER", candidacy: "STRETCH" }), POLICY,
    { globalAutoSubmit: true, byProvider: { LEVER: { paused: false, capability: "NONE" } } }).action === "SKIP");
check("and the reason names the missing adapter",
  /no application adapter/.test(decide(job({ provider: "LEVER" }), POLICY,
    { globalAutoSubmit: true, byProvider: { LEVER: { paused: false, capability: "NONE" } } }).why));
check("an unknown provider is skipped",
  decide(job({ provider: "WORKDAY" }), POLICY, ON).action === "SKIP");
check("a globally-off system still prepares Greenhouse for review",
  decide(job(), POLICY, OFF).action === "REVIEW");

console.log("\nsalary");
check("unknown salary proceeds when allowed", decide(job({ baseSalaryMin: null }), POLICY, ON).action === "SUBMIT");
check("unknown salary is reviewed when not allowed",
  decide(job({ baseSalaryMin: null }), { ...POLICY, allowUnknownSalary: false }, ON).action === "REVIEW");
check("a published base below the floor is skipped",
  decide(job({ baseSalaryMin: 84_999 }), POLICY, ON).action === "SKIP");
check("exactly the floor passes", decide(job({ baseSalaryMin: 85_000 }), POLICY, ON).action === "SUBMIT");

console.log("\nstanding gates cannot be configured away");
check("a blocked answer stops it", decide(job({ blockedAnswers: 1 }), POLICY, ON).action === "REVIEW");
check("unaccounted fields stop it", decide(job({ allFieldsConfident: false }), POLICY, ON).action === "REVIEW");
check("an ungrounded resume claim stops it", decide(job({ resumeClaimsAllGrounded: false }), POLICY, ON).action === "REVIEW");
check("a failed artifact stops it", decide(job({ artifactValid: false }), POLICY, ON).action === "REVIEW");

console.log("\ncaps and exclusions");
check("the daily cap demotes to REVIEW",
  decide(job({ submittedToday: 3 }), { ...POLICY, maxApplicationsPerDay: 3 }, ON).action === "REVIEW");
check("under the cap still submits",
  decide(job({ submittedToday: 2 }), { ...POLICY, maxApplicationsPerDay: 3 }, ON).action === "SUBMIT");
check("no cap is not a cap of zero", decide(job({ submittedToday: 99 }), POLICY, ON).action === "SUBMIT");
check("an excluded employer is skipped",
  decide(job(), { ...POLICY, excludedCompanyIds: ["c"] }, ON).action === "SKIP");
check("an excluded job is skipped", decide(job(), { ...POLICY, excludedJobIds: ["j"] }, ON).action === "SKIP");
check("requiring resume review stops every submission",
  decide(job(), { ...POLICY, requireResumeReview: true }, ON).action === "REVIEW");


// ============================================================================
// STRETCH autonomous policy: BOTH APPLICATION_CANDIDATE and STRETCH may
// auto-submit when every OTHER safeguard passes. The candidacy MEANINGS are
// unchanged; only submission policy widened. decide() is generic, so this
// is exercised by a policy whose auto-submit list includes STRETCH.
// ============================================================================
const STRETCH_POLICY: AutomationPolicy = {
  ...POLICY, autoSubmitCandidacy: ["APPLICATION_CANDIDATE", "STRETCH"], reviewCandidacy: ["MANUAL_REVIEW"],
};
console.log("\nSTRETCH autonomous policy");
check("APPLICATION_CANDIDATE + all safeguards still auto-submits",
  decide(job({ candidacy: "APPLICATION_CANDIDATE" }), STRETCH_POLICY, ON).action === "SUBMIT");
check("STRETCH + all safeguards now auto-submits",
  decide(job({ candidacy: "STRETCH" }), STRETCH_POLICY, ON).action === "SUBMIT",
  decide(job({ candidacy: "STRETCH" }), STRETCH_POLICY, ON).why);
check("STRETCH on an unsupported provider does NOT submit (SKIP)",
  decide(job({ candidacy: "STRETCH", provider: "LEVER" }), STRETCH_POLICY, ON).action === "SKIP");
check("STRETCH below the salary floor does NOT submit (SKIP)",
  decide(job({ candidacy: "STRETCH", baseSalaryMin: 60_000 }), STRETCH_POLICY, ON).action === "SKIP");
check("STRETCH that is ineligible does NOT submit (SKIP)",
  decide(job({ candidacy: "STRETCH", eligibility: "INELIGIBLE" }), STRETCH_POLICY, ON).action === "SKIP");
check("STRETCH with an unresolved HUMAN_FACT/blocked answer -> REVIEW, not submit",
  decide(job({ candidacy: "STRETCH", blockedAnswers: 1 }), STRETCH_POLICY, ON).action === "REVIEW");
check("STRETCH with fields not all confident -> REVIEW, not submit",
  decide(job({ candidacy: "STRETCH", allFieldsConfident: false }), STRETCH_POLICY, ON).action === "REVIEW");
check("STRETCH with a failed resume grounding check -> REVIEW, not submit",
  decide(job({ candidacy: "STRETCH", resumeClaimsAllGrounded: false }), STRETCH_POLICY, ON).action === "REVIEW");
check("STRETCH with an invalid artifact -> REVIEW, not submit",
  decide(job({ candidacy: "STRETCH", artifactValid: false }), STRETCH_POLICY, ON).action === "REVIEW");
check("STRETCH at the daily cap -> REVIEW, not submit",
  decide(job({ candidacy: "STRETCH", submittedToday: 3 }), { ...STRETCH_POLICY, maxApplicationsPerDay: 3 }, ON).action === "REVIEW");
check("STRETCH demotes to REVIEW when auto-submit is switched off globally",
  decide(job({ candidacy: "STRETCH" }), STRETCH_POLICY, OFF).action === "REVIEW");
check("REJECT never auto-submits under the STRETCH policy",
  decide(job({ candidacy: "REJECT" }), STRETCH_POLICY, ON).action === "SKIP");
check("MANUAL_REVIEW never auto-submits under the STRETCH policy (routes to REVIEW)",
  decide(job({ candidacy: "MANUAL_REVIEW" }), STRETCH_POLICY, ON).action === "REVIEW");


// ============================================================================
// FIX #1 (material gap) + FIX #3 (autonomous-STRETCH evidence guard).
// STRETCH stays broad; autonomous SUBMISSION is more selective.
// ============================================================================
console.log("\nautonomous-STRETCH evidence guard");
// material gap -> REVIEW, both verdicts, never SUBMIT (planner parity)
check("material-gap STRETCH (OCCUPATIONAL_GAP) routes to REVIEW, not SUBMIT",
  decide(job({ candidacy: "STRETCH", candidacyReasonCode: "OCCUPATIONAL_GAP", hardMet: 2, hardTotal: 6 }), STRETCH_POLICY, ON).action === "REVIEW");
check("material-gap STRETCH (0 of N hard) routes to REVIEW",
  decide(job({ candidacy: "STRETCH", candidacyReasonCode: "NO_DIRECT_EVIDENCE", hardMet: 0, hardTotal: 5 }), STRETCH_POLICY, ON).action === "REVIEW");
check("material-gap APPLICATION_CANDIDATE also routes to REVIEW (Fix #1 applies to both)",
  decide(job({ candidacy: "APPLICATION_CANDIDATE", candidacyReasonCode: "OCCUPATIONAL_GAP", hardMet: 2, hardTotal: 6 }), STRETCH_POLICY, ON).action === "REVIEW");
// weak STRETCH -> REVIEW (Lincoln shape: 2/9, no material gap)
check("weak STRETCH (2/9, no material gap) routes to REVIEW, not autonomous SUBMIT",
  decide(job({ candidacy: "STRETCH", candidacyReasonCode: "LOW_HARD_RATIO", hardMet: 2, hardTotal: 9 }), STRETCH_POLICY, ON).action === "REVIEW");
check("STRETCH with too few supported requirements (2/3, <3 supported) routes to REVIEW",
  decide(job({ candidacy: "STRETCH", candidacyReasonCode: "LOW_HARD_RATIO", hardMet: 2, hardTotal: 3 }), STRETCH_POLICY, ON).action === "REVIEW");
// sufficient STRETCH -> SUBMIT
check("sufficiently-supported STRETCH (4/8 = 50%, >=3 supported) auto-submits",
  decide(job({ candidacy: "STRETCH", candidacyReasonCode: "LOW_HARD_RATIO", hardMet: 4, hardTotal: 8 }), STRETCH_POLICY, ON).action === "SUBMIT");
check("STRETCH at exactly 3/7 (43% >= 40%, 3 supported) auto-submits",
  decide(job({ candidacy: "STRETCH", candidacyReasonCode: "LOW_HARD_RATIO", hardMet: 3, hardTotal: 7 }), STRETCH_POLICY, ON).action === "SUBMIT");
check("STRETCH at 3/8 (37.5% < 40%) routes to REVIEW",
  decide(job({ candidacy: "STRETCH", candidacyReasonCode: "LOW_HARD_RATIO", hardMet: 3, hardTotal: 8 }), STRETCH_POLICY, ON).action === "REVIEW");
// APPLICATION_CANDIDATE is exempt from the STRETCH evidence guard
check("APPLICATION_CANDIDATE with modest coverage (2/4) still auto-submits (exempt from the STRETCH guard)",
  decide(job({ candidacy: "APPLICATION_CANDIDATE", candidacyReasonCode: "MEETS_HARD_REQUIREMENTS", hardMet: 2, hardTotal: 4 }), STRETCH_POLICY, ON).action === "SUBMIT");
// stale POLICY_AUTHORIZED cannot bypass: the planner re-decides from candidacy each cycle,
// so a material-gap or weak STRETCH is re-routed to REVIEW regardless of prior authorization.
check("a weak STRETCH cannot be auto-submitted even if it was previously prepared",
  decide(job({ candidacy: "STRETCH", candidacyReasonCode: "LOW_HARD_RATIO", hardMet: 2, hardTotal: 9, allFieldsConfident: true }), STRETCH_POLICY, ON).action === "REVIEW");

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
