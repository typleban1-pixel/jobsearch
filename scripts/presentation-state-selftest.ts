/**
 * The presentation-state mapping: every application lands in exactly one
 * human state with exactly one next action.
 */
import { present, type ApplicationFacts } from "../lib/portal/presentationState.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

const BASE: ApplicationFacts = {
  status: "DRAFT", humanApproved: false, allFieldsConfident: false, blockedAnswers: 0,
  submittedAt: null, confirmationReceived: false, provider: "GREENHOUSE", refusals: [], handoff: false,
};
const p = (f: Partial<ApplicationFacts>) => present({ ...BASE, ...f }, "app-1");

check("blocked questions become Needs you with an answer action",
  p({ status: "BLOCKED_NEEDS_INPUT", blockedAnswers: 5 }).state === "NEEDS_YOU"
  && p({ status: "BLOCKED_NEEDS_INPUT", blockedAnswers: 5 }).action?.label === "Answer questions",
  JSON.stringify(p({ status: "BLOCKED_NEEDS_INPUT", blockedAnswers: 5 })));

check("the question count is pluralized honestly",
  p({ blockedAnswers: 1 }).summary === "1 question needs your answer"
  && p({ blockedAnswers: 5 }).summary === "5 questions need your answer",
  p({ blockedAnswers: 1 }).summary);

// HANDOFF must never reach the reader as a word. When the employer's own
// apply URL is known, the action is named after the employer; when it is
// not, it falls back to opening the application. The copy must NOT claim
// the work was saved -- that reassurance was removed deliberately because
// it was untrue whenever nothing had been filled.
{
  const withUrl = p({ handoff: true, provider: "WORKDAY", applyUrl: "https://workday.example/apply" });
  check("handoff with a known apply URL is a named human action",
    withUrl.action?.label === "Continue on Workday", JSON.stringify(withUrl));
  check("and never says HANDOFF", !/handoff/i.test(withUrl.summary + (withUrl.action?.label ?? "")), withUrl.summary);

  const noUrl = p({ handoff: true, provider: "WORKDAY" });
  check("handoff without an apply URL opens the application",
    noUrl.action?.label === "Open application", JSON.stringify(noUrl));
  check("and never falsely claims the work was saved", !/\bsaved\b/i.test(noUrl.summary), noUrl.summary);
}

{
  // A prepared application awaiting review needs the person to read and
  // approve it, so it belongs under Needs you and is reviewable inline.
  const r = p({ status: "AWAITING_REVIEW", allFieldsConfident: true });
  check("a prepared application awaiting review is Needs you", r.state === "NEEDS_YOU", r.state);
  check("awaiting review offers Review & approve", r.action?.label === "Review & approve", JSON.stringify(r.action));
  check("awaiting review is flagged for inline review", r.inlineReview === true, String(r.inlineReview));
  check("awaiting review keeps the review permalink as its href", /\/review$/.test(r.action?.href ?? ""), r.action?.href ?? "");
}
// Approved with nothing queued: the send is a click the person makes, so it
// asks for them. Approved and queued/running: their part is done -- Ready.
{
  const approved = p({ status: "READY_TO_SUBMIT", humanApproved: true, allFieldsConfident: true });
  check("an approved application with nothing queued offers Submit", approved.action?.label === "Submit application", JSON.stringify(approved));
  check("and asks for the person, because Ready means running without them", approved.state === "NEEDS_YOU", approved.state);
  const queued = p({ status: "READY_TO_SUBMIT", humanApproved: true, allFieldsConfident: true, submitQueued: true });
  check("an approved application queued for the submitter is Ready", queued.state === "READY", queued.state);
  check("and carries a way to look at it", Boolean(queued.action), JSON.stringify(queued.action));
  const running = p({ status: "READY_TO_SUBMIT", humanApproved: true, allFieldsConfident: true, submitQueued: true, submitRunning: true });
  check("a submission in progress is Ready and says so", running.state === "READY" && /Submitting/.test(running.summary), running.summary);
  const retry = p({ status: "READY_TO_SUBMIT", humanApproved: true, allFieldsConfident: true, submitOutcome: "SAFE_STOP" });
  check("a stopped attempt that can be retried needs the person, not Ready", retry.state === "NEEDS_YOU" && retry.action?.label === "Submit application", retry.state);
}

// The SpotHero shape: READY_TO_SUBMIT, a stale approval, and a current
// REJECT. No action a person can take makes this submittable, so it is
// not work waiting on them.
{
  const r = p({ status: "READY_TO_SUBMIT", humanApproved: true, allFieldsConfident: true,
                refusals: ["CANDIDACY_REFUSES", "APPROVAL_PREDATES_CANDIDACY"] });
  check("a stale approval over a current REJECT is not Needs you", r.state !== "NEEDS_YOU", r.state);
  check("and it is surfaced as closed / skipped by the system", r.state === "CLOSED", r.state);
  check("and it never offers Submit", r.action?.label !== "Submit application", JSON.stringify(r.action));
  check("and it says it was skipped, in plain words",
    /^Skipped\./.test(r.summary) && /not safe to send/.test(r.summary), r.summary);
  check("and it names no enum", !/REJECT|CANDIDACY_REFUSES|READY_TO_SUBMIT/.test(r.summary), r.summary);
}

// A terminal refusal wins even when a fixable one is also present:
// re-approving cannot rescue a REJECT.
{
  const r = p({ refusals: ["APPROVAL_PREDATES_CANDIDACY", "CANDIDACY_REFUSES"] });
  check("a terminal refusal outranks a fixable one in any order", r.state === "CLOSED", r.state);
}
for (const code of ["NOT_ELIGIBLE", "POSTING_NOT_OPEN", "ALREADY_SUBMITTED_ON_OPENING"]) {
  const r = p({ refusals: [code] });
  check(`${code} is closed, not Needs you`, r.state === "CLOSED", r.state);
}

// A refusal a person can actually act on still asks for them.
for (const code of ["POSTING_CHANGED", "ARTIFACT_CHANGED", "APPROVAL_PREDATES_CANDIDACY"]) {
  const r = p({ refusals: [code] });
  check(`${code} still needs a person`, r.state === "NEEDS_YOU", r.state);
  check(`${code} offers a review action`, r.action?.label === "Review application", JSON.stringify(r.action));
}

// Submission is not submission without confirmation.
check("a confirmed submission reads as submitted",
  p({ submittedAt: "2026-09-01T20:14:00Z", confirmationReceived: true }).summary
    === "Submitted. Employer confirmation received.", "");
check("an unconfirmed submission does not claim success",
  /needs verification/i.test(p({ submittedAt: "2026-09-01T20:14:00Z", confirmationReceived: false }).summary), "");
check("and an unconfirmed submission is never described as received",
  !/confirmation received/i.test(p({ submittedAt: "2026-09-01T20:14:00Z", confirmationReceived: false }).summary), "");

check("abandoned applications are Closed", p({ status: "ABANDONED" }).state === "CLOSED", "");
check("a draft with nothing needed is Preparing and offers no action",
  p({ status: "PREPARING" }).state === "PREPARING" && p({ status: "PREPARING" }).action === null, "");

// The same words everywhere, and a raw enum never among them.
{
  const { STATE_LABEL, sourceLabel } = await import("../lib/portal/presentationState.ts");
  check("the five state words are the human ones",
    STATE_LABEL.NEEDS_YOU === "Needs you" && STATE_LABEL.READY === "Ready" && STATE_LABEL.PREPARING === "Preparing"
    && STATE_LABEL.SUBMITTED === "Submitted" && STATE_LABEL.CLOSED === "Closed", JSON.stringify(STATE_LABEL));
  check("every ATS has a friendly name", ["GREENHOUSE", "LEVER", "ASHBY", "WORKDAY", "SMARTRECRUITERS", "ICIMS", "JOBVITE"]
    .every((k) => !/^[A-Z_]+$/.test(sourceLabel(k))), ["SMARTRECRUITERS", "ICIMS"].map(sourceLabel).join(", "));
}

// Exhaustiveness: every shape lands somewhere, with no internal wording.
{
  const shapes: Array<Partial<ApplicationFacts>> = [
    {}, { status: "PREPARING" }, { status: "BLOCKED_NEEDS_INPUT" }, { status: "AWAITING_REVIEW" },
    { status: "READY_TO_SUBMIT", humanApproved: true, allFieldsConfident: true },
    { status: "SUBMITTED", submittedAt: "x", confirmationReceived: true },
    { status: "ABANDONED" }, { status: "WITHDRAWN" }, { handoff: true },
  ];
  const valid = new Set(["NEEDS_YOU", "PREPARING", "READY", "SUBMITTED", "CLOSED"]);
  check("every shape maps to exactly one valid state",
    shapes.every((s) => valid.has(p(s).state)), "");
  const leaks = /READY_TO_SUBMIT|BLOCKED_NEEDS_INPUT|AWAITING_REVIEW|HANDOFF|all_fields_confident|POLICY_AUTHORIZED/;
  check("no internal terminology reaches the summary or button",
    shapes.every((s) => !leaks.test(p(s).summary + (p(s).action?.label ?? ""))), "");
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
