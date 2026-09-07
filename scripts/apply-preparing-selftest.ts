/**
 * /apply must tell the truth about preparation. Only a row a worker is
 * genuinely mid-run on (fresh prepare claim, or status PREPARING) reads
 * "Preparing"; a DRAFT that came back parked with a reason surfaces under
 * Needs You (a provider/browser handoff like Ashby points at the employer's
 * form and preserves the reason), never "Preparing" forever. READY/SUBMITTED
 * are unaffected. The board auto-refreshes only while something is preparing.
 */
import { present, type ApplicationFacts } from "../lib/portal/presentationState.ts";
import { readFileSync } from "node:fs";

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };
const base: ApplicationFacts = { status: "DRAFT", humanApproved: false, allFieldsConfident: false, blockedAnswers: 0, submittedAt: null, confirmationReceived: false, provider: "ASHBY", refusals: [], handoff: false };
const p = (o: Partial<ApplicationFacts>) => present({ ...base, ...o }, "app-1");

// 1. fresh claimed DRAFT -> Preparing (your application)
{
  const r = p({ status: "DRAFT", activelyPreparing: true });
  ok(r.state === "PREPARING" && /Preparing your application/.test(r.summary), "fresh claimed DRAFT reads 'Preparing your application…'", r.summary.slice(0, 40));
  ok(/leave this page/i.test(r.summary), "and tells the reader they can leave the page");
}
// 2. status PREPARING -> Preparing
{
  const r = p({ status: "PREPARING", activelyPreparing: true });
  ok(r.state === "PREPARING" && /Preparing your application/.test(r.summary), "status PREPARING reads 'Preparing your application…'");
}
// 3. DRAFT + blocked_reason (Ashby handoff) with apply URL -> Needs You, Continue on Ashby, reason preserved
{
  const r = p({ status: "DRAFT", activelyPreparing: false, blockedReason: "Ashby does not publish application forms without an employer API key.", handoffReason: "Ashby does not publish application forms.", applyUrl: "https://jobs.ashbyhq.com/aleph/x" });
  ok(r.state === "NEEDS_YOU", "DRAFT + blocked_reason is Needs You, not Preparing", r.state);
  ok(r.action?.label === "Continue on Ashby", "action is 'Continue on Ashby'", JSON.stringify(r.action));
  ok(r.action?.href === "https://jobs.ashbyhq.com/aleph/x", "action points at the employer's own form");
  ok(/Ashby does not publish/.test(r.summary), "the actual blocked reason is preserved in the summary");
  ok(!/Preparing/i.test(r.summary), "it never reads 'Preparing'");
}
// 4. DRAFT + blocked_reason, no apply URL -> Needs You, open application
{
  const r = p({ status: "DRAFT", activelyPreparing: false, blockedReason: "something parked", handoffReason: "Something needs you." });
  ok(r.state === "NEEDS_YOU" && r.action?.label === "Open application", "DRAFT + blocked_reason with no apply URL falls back to Open application", JSON.stringify(r.action));
}
// 5. blocked_reason but a worker is actively mid-run -> NOT yanked into Needs You
{
  const r = p({ status: "PREPARING", activelyPreparing: true, blockedReason: "stale prior reason" });
  ok(r.state === "PREPARING", "a genuinely mid-run row is not pulled into Needs You by a stale reason", r.state);
}
// 6. freshly queued DRAFT, nothing parked, not yet claimed -> Preparing (queued)
{
  const r = p({ status: "DRAFT", activelyPreparing: false });
  ok(r.state === "PREPARING" && /Queued for preparation/.test(r.summary), "a freshly queued DRAFT reads 'Queued for preparation'", r.summary.slice(0, 30));
}
// 7. transition becomes visible: same app before/after the parked reason lands
{
  const before = p({ status: "PREPARING", activelyPreparing: true });
  const after = p({ status: "DRAFT", activelyPreparing: false, blockedReason: "Ashby does not publish application forms.", handoffReason: "Ashby does not publish application forms." });
  ok(before.state === "PREPARING" && after.state === "NEEDS_YOU", "when preparation parks the app, its presented state changes (PREPARING -> Needs You) so a poll surfaces it", `${before.state} -> ${after.state}`);
}
// 8/9. READY / SUBMITTED unaffected
{
  // Ready means approved AND handed to the submitter; approved with nothing
  // queued is a click the person still has to make.
  ok(p({ status: "READY_TO_SUBMIT", humanApproved: true, allFieldsConfident: true, discoveredFields: 3, submitQueued: true }).state === "READY", "READY_TO_SUBMIT + approved + queued is READY");
  ok(p({ status: "READY_TO_SUBMIT", humanApproved: true, allFieldsConfident: true, discoveredFields: 3 }).state === "NEEDS_YOU", "READY_TO_SUBMIT + approved but not queued asks for the person");
  ok(p({ status: "SUBMITTED", submittedAt: "2026-09-04", confirmationReceived: true }).state === "SUBMITTED", "SUBMITTED is still SUBMITTED");
}
// 10. the board auto-refreshes only while something is preparing
{
  const page = readFileSync("app/apply/page.tsx", "utf8");
  // Polls while something is preparing or queued to submit; quiet otherwise.
  ok(/<AutoRefreshApply active=\{board\.preparing\.length > 0( \|\| board\.ready\.length > 0)?\}/.test(page), "/apply renders AutoRefreshApply, gated on there being something in flight");
  const cmp = readFileSync("app/apply/AutoRefreshApply.tsx", "utf8");
  ok(/if \(!active\) return;/.test(cmp) && /router\.refresh\(\)/.test(cmp), "AutoRefreshApply polls router.refresh() only while active (quiet when settled)");
}

console.log(bad ? `\n${bad} FAILED` : `\napply-preparing-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
