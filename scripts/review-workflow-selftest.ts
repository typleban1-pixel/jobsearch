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
import { deriveBlocker, type BlockerFacts } from "../lib/portal/blocker.ts";

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

console.log(bad ? `\n${bad} FAILED` : `\nreview-workflow-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
