/**
 * The application-review workflow invariant:
 *
 *   IF THE UI ASKS ME TO REVIEW OR ACT, THERE MUST BE SOMETHING I CAN DO.
 *
 * Locks the state machines (presentationState.present, blocker.deriveBlocker)
 * and the review-data hardening against the Northern Trust dead end: a
 * WORKDAY application whose form was never read (0 discovered fields,
 * all_fields_confident false by default) must NOT present as "Review
 * application" with nothing to do; it must route to the employer's site.
 *   node scripts/review-workflow-selftest.ts
 */
import { present, type ApplicationFacts } from "../lib/portal/presentationState.ts";
import { deriveBlocker, approvalProhibitedBy, type BlockerFacts } from "../lib/portal/blocker.ts";

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

const base: ApplicationFacts = {
  status: "DRAFT", humanApproved: false, allFieldsConfident: false, blockedAnswers: 0,
  submittedAt: null, confirmationReceived: false, provider: "WORKDAY", refusals: [], handoff: false,
  discoveredFields: 0, submitOutcome: null, applyUrl: null, handoffReason: null,
  submitQueued: false, submitRunning: false, activelyPreparing: false, blockedReason: null,
};
// A matrix of realistic states. The invariant: NEEDS_YOU and READY must
// carry an action; PREPARING/SUBMITTED/CLOSED may be actionless.
const matrix: Array<[string, Partial<ApplicationFacts>]> = [
  ["NT: workday form not read, parked", { provider: "WORKDAY", discoveredFields: 0, blockedReason: "no live snapshot path for WORKDAY.", applyUrl: "https://ntrs.wd1/x" }],
  ["workday parked, no applyUrl", { provider: "WORKDAY", discoveredFields: 0, blockedReason: "no live snapshot path for WORKDAY." }],
  ["lever parked", { provider: "LEVER", discoveredFields: 0, blockedReason: "LEVER handoff", applyUrl: "https://jobs.lever.co/x" }],
  ["ashby snapshot handoff", { provider: "ASHBY", blockedReason: "must be snapshotted locally in the browser", applyUrl: "https://jobs.ashbyhq.com/x", discoveredFields: 0 }],
  ["blocked answers", { discoveredFields: 5, blockedAnswers: 2 }],
  ["prepared, all confident, not approved", { status: "AWAITING_REVIEW", discoveredFields: 8, allFieldsConfident: true }],
  ["ready to submit greenhouse", { provider: "GREENHOUSE", status: "READY_TO_SUBMIT", humanApproved: true, allFieldsConfident: true, discoveredFields: 8 }],
  ["actively preparing", { activelyPreparing: true, status: "PREPARING" }],
  ["queued to submit", { submitQueued: true }],
  ["submitting", { submitRunning: true }],
  ["ambiguous submit", { submitOutcome: "AMBIGUOUS" }],
  ["submitted confirmed", { submittedAt: "2026-09-01", confirmationReceived: true }],
];
console.log("present(): NEEDS_YOU/READY must carry an action");
for (const [name, over] of matrix) {
  const p = present({ ...base, ...over }, "app1");
  const mustAct = p.state === "NEEDS_YOU" || p.state === "READY";
  ok(!mustAct || Boolean(p.action), `${name} -> ${p.state}`, mustAct && !p.action ? "NO ACTION (dead end)" : `${p.action?.label ?? "(none)"}`);
}
// The specific regression: NT must never present "Review application" / dead end.
{
  const p = present({ ...base, provider: "WORKDAY", discoveredFields: 0, blockedReason: "no live snapshot path for WORKDAY.", applyUrl: "https://ntrs.wd1/x" }, "app1");
  ok(p.state === "NEEDS_YOU" && /continue on workday/i.test(p.action?.label ?? ""), "NT routes to 'Continue on Workday', not a review dead end", `${p.state}: ${p.action?.label}`);
  ok(Boolean(p.action?.href?.startsWith("http")), "NT action points at the employer's site, not /review", p.action?.href ?? "");
}

console.log("\nderiveBlocker(): a person-facing blocker names an action or a legitimate wait");
const bbase: BlockerFacts = {
  status: "DRAFT", submittedAt: null, submitQueued: false, submitRunning: false, submitOutcome: null,
  humanApproved: false, blockedAnswers: 0, requiredUnanswered: 0, discoveredFields: 0, refusals: [],
  provider: "WORKDAY", providerCapability: null, providerPaused: false, applyUrl: "https://ntrs.wd1/x",
  handoffReason: null, dailyCapReached: false, jobStatus: "OPEN",
};
{
  const b = deriveBlocker(bbase, "app1");
  ok(b.code === "FORM_NOT_READ" && Boolean(b.action), "NT blocker is FORM_NOT_READ with an 'Open on Workday' action", `${b.code}: ${b.action?.label}`);
}
// A "needs your review/answer" blocker must carry an action.
for (const [name, over] of [
  ["blocked answer", { discoveredFields: 5, blockedAnswers: 1 }],
  ["needs review", { discoveredFields: 8, status: "AWAITING_REVIEW" }],
] as Array<[string, Partial<BlockerFacts>]>) {
  const b = deriveBlocker({ ...bbase, ...over, provider: "GREENHOUSE", providerCapability: "PRODUCTION" }, "app1");
  const asksUser = /needs your|hand-finish|sign-in|out of date/i.test(b.status);
  ok(!asksUser || Boolean(b.action), `${name} -> ${b.code}`, b.action?.label ?? "(no action)");
}

// ---------------------------------------------------------------------------
// Approval-consistency invariant (the /jobs vs /review dead-end).
//
//   IF /jobs says "it submits after you approve it" THEN approval must be
//   genuinely possible (no qualification/candidacy/posting refusal), and
//   conversely a prohibited approval must NEVER be shown as WAITING_FOR_MY_REVIEW.
//
// deriveBlocker is the /jobs derivation; a WAITING_FOR_MY_REVIEW code is the
// only one whose reason promises approval. approvalProhibitedBy is the shared
// truth the review page's canApprove also keys on, so testing the blocker code
// against the refusals proves both surfaces agree.
console.log("\napproval consistency: /jobs never promises approval the guard would refuse");
const gbase: BlockerFacts = {
  status: "AWAITING_REVIEW", submittedAt: null, submitQueued: false, submitRunning: false, submitOutcome: null,
  humanApproved: false, blockedAnswers: 0, requiredUnanswered: 0, discoveredFields: 8, refusals: [],
  provider: "GREENHOUSE", providerCapability: "PRODUCTION", providerPaused: false, applyUrl: "https://boards.greenhouse.io/x/jobs/1",
  handoffReason: null, dailyCapReached: false, jobStatus: "OPEN",
};
const promisesApprove = (b: { reason: string }) => /submits after you approve/.test(b.reason);
const cases: Array<[string, Partial<BlockerFacts>, { code: string; approvePromised: boolean; hasAction: boolean }]> = [
  // A. Greenhouse, everything resolved, no refusal -> review/approve promised, action present.
  ["A greenhouse ready for review", {}, { code: "WAITING_FOR_MY_REVIEW", approvePromised: true, hasAction: true }],
  // B. policy-authorized (READY_TO_SUBMIT, not human-approved) -> not asked to approve again.
  ["B policy-authorized ready", { status: "READY_TO_SUBMIT", humanApproved: true }, { code: "READY_TO_SUBMIT", approvePromised: false, hasAction: false }],
  // C. Workday external-only (capability NONE) -> external action, never approve.
  ["C workday external-only", { provider: "WORKDAY", providerCapability: "NONE" }, { code: "ATS_NOT_AUTOMATED", approvePromised: false, hasAction: true }],
  // D. unresolved HUMAN_FACT (blocked answer) -> answer action, not approve.
  ["D blocked answer", { blockedAnswers: 1 }, { code: "WAITING_FOR_MY_ANSWER", approvePromised: false, hasAction: true }],
  // E. material qualification gap -> manual optional, never approve, action present.
  ["E material qualification gap", { refusals: ["MATERIAL_QUALIFICATION_GAP"] }, { code: "MANUAL_OPTIONAL_QUALIFICATION_GAP", approvePromised: false, hasAction: true }],
  // F. unsupported provider (Lever paused) with fields read -> external, never approve.
  ["F lever paused", { provider: "LEVER", providerCapability: "PRODUCTION", providerPaused: true }, { code: "ATS_NOT_AUTOMATED", approvePromised: false, hasAction: true }],
  // G. submission uncertain -> inspect, never a retry/approve.
  ["G ambiguous submit", { submitOutcome: "AMBIGUOUS" }, { code: "AMBIGUOUS_SUBMIT_STATE", approvePromised: false, hasAction: true }],
  // H. already submitted -> confirmation, no approve.
  ["H submitted", { submittedAt: "2026-09-01" }, { code: "SUBMITTED", approvePromised: false, hasAction: false }],
  // I. candidacy refuses -> not a match, never approve, action present.
  ["I candidacy refuses", { refusals: ["CANDIDACY_REFUSES"] }, { code: "NOT_A_MATCH", approvePromised: false, hasAction: true }],
  // J. posting changed pre-approval -> re-review, never a bare "approve it".
  ["J posting changed", { refusals: ["POSTING_CHANGED"] }, { code: "REVALIDATION_FAILED", approvePromised: false, hasAction: true }],
  // K. ASSISTED provider (Lever), prepared, guards clear -> READY_FOR_HUMAN_SUBMIT,
  //    has an action, and NEVER promises an autonomous approval/submit.
  ["K lever assisted ready", { provider: "LEVER", providerCapability: "ASSISTED_SUBMIT", providerPaused: true }, { code: "READY_FOR_HUMAN_SUBMIT", approvePromised: false, hasAction: true }],
  // L. ASSISTED + material qualification gap -> still MANUAL_OPTIONAL, not a handoff.
  ["L lever assisted + material gap", { provider: "LEVER", providerCapability: "ASSISTED_SUBMIT", providerPaused: true, refusals: ["MATERIAL_QUALIFICATION_GAP"] }, { code: "MANUAL_OPTIONAL_QUALIFICATION_GAP", approvePromised: false, hasAction: true }],
  // M. ASSISTED + blocked answer (HUMAN_FACT) -> answer first, not a handoff.
  ["M lever assisted + blocked answer", { provider: "LEVER", providerCapability: "ASSISTED_SUBMIT", providerPaused: true, blockedAnswers: 1 }, { code: "WAITING_FOR_MY_ANSWER", approvePromised: false, hasAction: true }],
];
for (const [name, over, exp] of cases) {
  const b = deriveBlocker({ ...gbase, ...over }, "app1");
  ok(b.code === exp.code, `${name} -> code ${b.code}`, b.code === exp.code ? "" : `expected ${exp.code}`);
  ok(promisesApprove(b) === exp.approvePromised, `${name} -> approve-promised=${promisesApprove(b)}`, "");
  ok(Boolean(b.action) === exp.hasAction, `${name} -> hasAction=${Boolean(b.action)}`, b.action?.label ?? "(none)");
  // The core invariant: a promise of approval implies no prohibiting refusal.
  if (promisesApprove(b)) ok(approvalProhibitedBy((over.refusals as string[]) ?? []) === null, `${name} -> promise implies approvable`, "");
}

console.log(bad ? `\n${bad} FAILED` : `\nreview-workflow-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
