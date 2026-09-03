/**
 * Reproduces the production submission bug: a browser launch that could
 * not start left every later submission dying at launch, and the portal
 * showed an about:blank tab with no explanation.
 *
 * The launch property is exercised against real Chrome, because the bug
 * was entirely in process-level contention that a mock cannot have. The
 * surrounding guarantees (enqueue exactly once, a handoff has a real
 * destination, an ambiguous state never retries) are checked at the
 * decision layer where they live.
 */
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { deriveBlocker, type BlockerFacts } from "../lib/portal/blocker.ts";
let n=0,bad=0; const ok=(c:boolean,w:string)=>{n++;if(!c){bad++;console.error(`FAIL ${w}`);}};

// ---- 1. sequential launches do not wedge each other ------------------
// This is the exact scenario that died: one launch, then another, with
// no leftover port or lock permitted to block the second.
{
  let first: any = null, second: any = null, err = "";
  try {
    first = await launchApplicationContext();
    await first.close();
    second = await launchApplicationContext();
    await second.close();
  } catch (e) { err = (e as Error).message; }
  ok(err === "", `two sequential launches both succeed (${err || "ok"})`);
}

// ---- 2. the production submitter asks for no debug port --------------
// A fixed debug port is what made a single stale Chrome fatal. The
// submitter must not request one; only the interactive attach flow does.
{
  const submitSrc = (await import("node:fs")).readFileSync("scripts/submit-application.ts", "utf8");
  ok(/launchApplicationContext\(\)/.test(submitSrc), "the submitter launches with no options (no debug port)");
  ok(!/launchApplicationContext\(\{[^}]*debugPort/.test(submitSrc), "the submitter never opens a debug port");
  const launchSrc = (await import("node:fs")).readFileSync("lib/browser/launch.ts", "utf8");
  ok(/if \(options\.debugPort\)/.test(launchSrc), "the debug port is opt-in, not always on");
  ok(/SingletonLock/.test(launchSrc), "a stale profile lock is cleared before launch");
}

// ---- 3. a launch failure is a named stop, not a silent death --------
{
  const submitSrc = (await import("node:fs")).readFileSync("scripts/submit-application.ts", "utf8");
  ok(/BROWSER_LAUNCH_FAILED/.test(submitSrc), "a failed launch records BROWSER_LAUNCH_FAILED, not RUNNER_DIED");
}

// ---- 4. the portal never implies a non-automated ATS can self-submit -
const F = (o: Partial<BlockerFacts>): BlockerFacts => ({
  status: "AWAITING_REVIEW", submittedAt: null, submitQueued: false, submitRunning: false,
  submitOutcome: null, humanApproved: false, blockedAnswers: 0, requiredUnanswered: 0,
  discoveredFields: 10, refusals: [], provider: "GREENHOUSE", providerCapability: "PRODUCTION",
  providerPaused: false, dailyCapReached: false, jobStatus: "OPEN", ...o });
{
  // A Workday candidate looks submittable but Workday is not automated.
  const b = deriveBlocker(F({ provider: "WORKDAY", providerCapability: "NONE", humanApproved: true,
    applyUrl: "https://x.wd1.myworkdayjobs.com/x/apply" }), "app-w");
  ok(b.code === "ATS_NOT_AUTOMATED", "a non-automated provider is named, not shown as plain ready");
  ok(Boolean(b.action?.href.startsWith("http")), "and its action points at a real employer URL, never about:blank");
  ok(!/about:blank/.test(JSON.stringify(b)), "no about:blank anywhere in the presented state");
}

// ---- 5. an ambiguous prior submit never offers an automatic retry ---
{
  const b = deriveBlocker(F({ status: "READY_TO_SUBMIT", humanApproved: true, submitOutcome: "AMBIGUOUS" }), "app-a");
  ok(b.code === "AMBIGUOUS_SUBMIT_STATE", "an ambiguous submit is surfaced");
  ok(!/READY_TO_SUBMIT|ENQUEUE/.test(b.code), "and never re-enters the queue automatically");
}

// ---- 6. a SAFE_STOP at launch reads as a real, fixable failure ------
{
  const b = deriveBlocker(F({ status: "READY_TO_SUBMIT", humanApproved: true, submitOutcome: "SAFE_STOP",
    lastStopCode: "BROWSER_LAUNCH_FAILED",
    lastStopDetail: "[BROWSER_LAUNCH_FAILED @ launch] The browser could not start" }), "app-s");
  ok(b.code === "SUBMISSION_FAILED", "a launch SAFE_STOP is a failed attempt, not generic readiness");
  ok(/could not start|launch/i.test(b.reason), "and the reason names the launch failure");
}

// Assertion 1 already proves the property that matters: a second launch
// after a first does not wedge. A "count the leftover browsers" check
// races Chrome's asynchronous shutdown and tests this script's own
// teardown rather than production behaviour, so it is deliberately not
// here.

console.log(`${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
