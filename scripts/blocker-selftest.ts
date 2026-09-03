/**
 * The portal never says "blocked" without saying why. Each case pins the
 * one blocker a person would fix first, in the order the submission path
 * itself checks the gates.
 */
import { deriveBlocker, type BlockerFacts } from "../lib/portal/blocker.ts";
let n=0,bad=0; const ok=(c:boolean,w:string)=>{n++;if(!c){bad++;console.error(`FAIL ${w}`);}};
const F = (o: Partial<BlockerFacts>): BlockerFacts => ({
  status: "AWAITING_REVIEW", submittedAt: null, submitQueued: false, submitRunning: false,
  submitOutcome: null, humanApproved: false, blockedAnswers: 0, requiredUnanswered: 0,
  discoveredFields: 10, refusals: [], provider: "GREENHOUSE", providerCapability: "PRODUCTION",
  providerPaused: false, dailyCapReached: false, jobStatus: "OPEN", ...o });
const B = (o: Partial<BlockerFacts>) => deriveBlocker(F(o), "app-1");

// ---- terminal and in-flight beat everything ---------------------------
ok(B({ submittedAt: "2026-09-03" }).code === "SUBMITTED", "submitted is terminal");
ok(B({ submittedAt: "2026-09-03", blockedAnswers: 5 }).code === "SUBMITTED", "submitted beats stale answer counts");
ok(B({ submitOutcome: "AMBIGUOUS" }).code === "AMBIGUOUS_SUBMIT_STATE", "ambiguous is surfaced");
ok(B({ submitOutcome: "AMBIGUOUS" }).reason.includes("never retried"), "and says it is never auto-retried");
ok(B({ submitRunning: true }).code === "SUBMISSION_IN_PROGRESS", "a claimed run shows as submitting");
ok(B({ submitQueued: true }).code === "ENQUEUED", "queued says the listener owns it");
ok(B({ submitQueued: true }).action === null, "queued asks nothing of the person");
ok(B({ jobStatus: "CLOSED" }).code === "JOB_CLOSED_OR_CHANGED", "a closed posting is stated");

// ---- the person's gates, with direct actions --------------------------
{
  const b = B({ blockedAnswers: 2, requiredUnanswered: 2 });
  ok(b.code === "WAITING_FOR_MY_ANSWER", "unanswered questions are the first personal gate");
  ok(b.reason.includes("2 required questions"), "the count is stated");
  ok(b.action?.href === "/apply/questions", "the action opens the question wizard");
  ok(b.action?.label === "Answer 2 questions", "the button says how many");
}
ok(B({ blockedAnswers: 1 }).action?.label === "Answer 1 question", "singular reads naturally");
{
  const b = B({ discoveredFields: 0 });
  ok(b.code === "FORM_NOT_READ", "zero discovered fields is named, not hidden behind review");
}
{
  const b = B({});
  ok(b.code === "WAITING_FOR_MY_REVIEW", "a complete unapproved application waits for review");
  ok(b.action?.href === "/applications/app-1/review", "review links to this application");
}

// ---- provider capability is honest ------------------------------------
{
  const b = B({ provider: "WORKDAY", providerCapability: "NONE", humanApproved: true,
    handoffReason: "sign in to Workday in the browser profile", applyUrl: "https://x.wd1.example/apply" });
  ok(b.code === "AUTHENTICATION_REQUIRED", "an authentication handoff is named as such");
  ok(b.action?.href === "https://x.wd1.example/apply", "and continues on the employer's site");
}
{
  const b = B({ provider: "ASHBY", providerCapability: "NONE", humanApproved: true, applyUrl: "https://a/x" });
  ok(b.code === "ATS_NOT_AUTOMATED", "an unautomated provider says so");
  ok(/ASHBY/.test(b.reason), "and names the provider");
}

// ---- policy states ask nothing ----------------------------------------
{
  const b = B({ status: "READY_TO_SUBMIT", humanApproved: true, dailyCapReached: true });
  ok(b.code === "DAILY_CAP_REACHED", "cap reached is stated");
  ok(b.action === null, "and asks nothing of the person");
  ok(/midnight/.test(b.reason), "and says when it becomes eligible");
}
{
  const b = B({ status: "READY_TO_SUBMIT", humanApproved: true });
  ok(b.code === "READY_TO_SUBMIT", "fully ready is ready");
  ok(b.action === null, "ready asks nothing; the listener owns the next step");
}
{
  const b = B({ status: "READY_TO_SUBMIT", humanApproved: true, refusals: ["POSTING_CHANGED"] });
  ok(b.code === "REVALIDATION_FAILED", "a refusal names revalidation");
  ok(b.reason.includes("POSTING_CHANGED"), "and carries the actual refusal code");
}
{
  const b = B({ status: "READY_TO_SUBMIT", humanApproved: true, submitOutcome: "SAFE_STOP",
    lastStopDetail: "[READBACK_MISMATCH @ fill] the location was not committed" });
  ok(b.code === "SUBMISSION_FAILED", "a safe stop is a failed attempt, not a mystery");
  ok(Boolean(b.reason.includes("READBACK_MISMATCH")), "and quotes the recorded stop reason");
  ok(Boolean(b.action?.href.endsWith("/events")), "and links to the run history");
}

// ---- never a bare "blocked" -------------------------------------------
for (const facts of [ {}, { blockedAnswers: 3 }, { submitQueued: true }, { dailyCapReached: true, status: "READY_TO_SUBMIT", humanApproved: true } ] as Partial<BlockerFacts>[]) {
  const b = B(facts);
  ok(b.reason.trim().length > 20, `every blocker explains itself (${b.code})`);
  ok(!/^blocked$/i.test(b.status), `no bare "blocked" status (${b.code})`);
}
console.log(`${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
