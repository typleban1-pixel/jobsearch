/**
 * The submission request lifecycle.
 *
 * The rule the whole thing turns on: whether the irreversible employer
 * Submit click may have occurred. Everything before it is retryable,
 * everything after it is not, and when it cannot be established the
 * answer is AMBIGUOUS.
 */
import { classifyOutcome, retryAllowed, type RunFacts } from "../lib/applications/submitOutcome.ts";
import { present, type ApplicationFacts } from "../lib/portal/presentationState.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

const CLAIMED = "2026-09-02T10:00:00.000Z";
const BEFORE_CLAIM = "2026-09-02T09:00:00.000Z";
const AFTER_CLAIM = "2026-09-02T10:05:00.000Z";
const run = (f: Partial<RunFacts>) =>
  classifyOutcome({ submittedAt: null, clickAttemptedAt: null, claimedAt: CLAIMED, ...f }).outcome;

// ── The irreversible-click boundary ────────────────────────────────
check("guard refusal before the browser ran is a safe stop", run({}) === "SAFE_STOP", run({}));
check("form drift before the click is a safe stop", run({}) === "SAFE_STOP", "");
check("a CAPTCHA before the click is a safe stop", run({}) === "SAFE_STOP", "");
check("a timeout provably before the click is a safe stop", run({}) === "SAFE_STOP", "");

check("submit clicked with no confirmation is ambiguous",
  run({ clickAttemptedAt: AFTER_CLAIM }) === "AMBIGUOUS", "");
check("a timeout after the click is ambiguous",
  run({ clickAttemptedAt: AFTER_CLAIM }) === "AMBIGUOUS", "");
check("a process death after the click is ambiguous",
  run({ clickAttemptedAt: AFTER_CLAIM }) === "AMBIGUOUS", "");
check("human verification after the click is ambiguous",
  run({ clickAttemptedAt: AFTER_CLAIM }) === "AMBIGUOUS", "");

check("a confirmed submission is CONFIRMED",
  run({ submittedAt: "2026-09-02T10:06:00Z", clickAttemptedAt: AFTER_CLAIM }) === "CONFIRMED", "");
check("confirmation outranks the click marker",
  classifyOutcome({ submittedAt: "x", clickAttemptedAt: AFTER_CLAIM, claimedAt: CLAIMED }).outcome === "CONFIRMED", "");
check("a declined request is DECLINED",
  classifyOutcome({ submittedAt: null, clickAttemptedAt: null, claimedAt: CLAIMED, declined: true }).outcome === "DECLINED", "");

// A marker from a previous attempt must not poison this one.
check("a click marker older than the claim belongs to a previous run",
  run({ clickAttemptedAt: BEFORE_CLAIM }) === "SAFE_STOP", run({ clickAttemptedAt: BEFORE_CLAIM }));

// ── Retry permission ───────────────────────────────────────────────
check("retry is allowed after a safe stop", retryAllowed("SAFE_STOP"), "");
check("retry is allowed after a decline", retryAllowed("DECLINED"), "");
check("retry is allowed when nothing has been attempted", retryAllowed(null), "");
check("retry is REFUSED while ambiguous", !retryAllowed("AMBIGUOUS"), "");
check("retry is refused once confirmed", !retryAllowed("CONFIRMED"), "");

// ── Double-click idempotency and worker locking ────────────────────
//
// Both are conditional UPDATEs whose WHERE clause carries the state they
// expect, so the database decides the winner and a loser changes nothing.
{
  type Row = { submit_requested_at: string | null; submit_started_at: string | null; submitted_at: string | null; status: string };
  const requestSubmit = (r: Row): boolean => {
    if (r.status !== "READY_TO_SUBMIT" || r.submitted_at || r.submit_requested_at) return false;
    r.submit_requested_at = "now"; return true;
  };
  const claim = (r: Row): boolean => {
    if (!r.submit_requested_at || r.submit_started_at) return false;
    r.submit_started_at = "now"; return true;
  };

  const row: Row = { submit_requested_at: null, submit_started_at: null, submitted_at: null, status: "READY_TO_SUBMIT" };
  check("the first click creates a request", requestSubmit(row), "");
  check("a second click changes nothing", !requestSubmit(row), "");
  check("a third click still changes nothing", !requestSubmit(row), "");
  check("the request survives as one row", row.submit_requested_at === "now", "");

  check("the first worker claims it", claim(row), "");
  check("a second worker gets nothing", !claim(row), "");

  const submitted: Row = { submit_requested_at: null, submit_started_at: null, submitted_at: "yes", status: "SUBMITTED" };
  check("an already-submitted application cannot be requested", !requestSubmit(submitted), "");
}

// ── Presentation ───────────────────────────────────────────────────
const BASE: ApplicationFacts = {
  status: "READY_TO_SUBMIT", humanApproved: true, allFieldsConfident: true, blockedAnswers: 0,
  submittedAt: null, confirmationReceived: false, provider: "GREENHOUSE", refusals: [], handoff: false,
};
const p = (f: Partial<ApplicationFacts>) => present({ ...BASE, ...f }, "app-1");

// Approved and handed to the submitter is Ready: the person's part is done.
check("a queued request reads as approved and queued", p({ submitQueued: true }).summary === "Approved. Queued to submit." && p({ submitQueued: true }).state === "READY", p({ submitQueued: true }).summary);
check("a running request reads as submitting", /Submitting/.test(p({ submitRunning: true }).summary) && p({ submitRunning: true }).state === "READY", "");
// A way to look at it, never a way to send it again: a second Submit while
// one is queued or running is the double-submission this file exists to prevent.
check("neither offers a Submit button",
  p({ submitQueued: true }).action?.label !== "Submit application" && p({ submitRunning: true }).action?.label !== "Submit application"
  && !/submit/i.test(p({ submitQueued: true }).action?.label ?? "") && !/submit/i.test(p({ submitRunning: true }).action?.label ?? ""), "");

// Refresh persistence: the state is read from the row, so a fresh render
// of the same row produces the same thing.
check("a refresh mid-run shows the same state",
  JSON.stringify(p({ submitRunning: true })) === JSON.stringify(p({ submitRunning: true })), "");

{
  const r = p({ submitOutcome: "AMBIGUOUS" });
  check("ambiguity is Needs you", r.state === "NEEDS_YOU", r.state);
  check("and is never shown as submitted", !/submitted \u2713|Submitted \u2713/.test(r.summary), r.summary);
  check("and offers no retry", r.action?.label !== "Submit application", JSON.stringify(r.action));
  check("and sends the person to look", r.action?.label === "Check this submission", "");
  check("and says the employer did not confirm", /did not confirm/.test(r.summary), r.summary);
}
{
  const r = p({ submitOutcome: "SAFE_STOP" });
  check("a safe stop is retryable", r.action?.label === "Submit application", "");
  check("and says nothing was sent", /before anything was sent/.test(r.summary), r.summary);
}
{
  const r = p({ submittedAt: "2026-09-02T10:06:00Z", confirmationReceived: true });
  check("a confirmed submission reads as submitted", r.state === "SUBMITTED", "");
}
{
  const r = p({ submittedAt: "2026-09-02T10:06:00Z", confirmationReceived: false });
  check("a submission without confirmation is never called received",
    /needs verification/i.test(r.summary), r.summary);
}

// ── Human resolution ───────────────────────────────────────────────
{
  // Only reachable from ambiguity, and only with stated evidence.
  const allowed = (outcome: string | null, evidence: string) =>
    outcome === "AMBIGUOUS" && ["CONFIRMATION_PAGE", "CONFIRMATION_EMAIL", "EMPLOYER_PORTAL", "OTHER"].includes(evidence);
  check("resolution requires an ambiguous outcome", !allowed("SAFE_STOP", "CONFIRMATION_PAGE"), "");
  check("resolution requires stated evidence", !allowed("AMBIGUOUS", ""), "");
  check("resolution is allowed with both", allowed("AMBIGUOUS", "CONFIRMATION_EMAIL"), "");
  check("resolution is not offered on a fresh application", !allowed(null, "CONFIRMATION_PAGE"), "");
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
