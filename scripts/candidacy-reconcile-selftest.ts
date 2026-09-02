/**
 * Application state must not outlive the verdict that justified it.
 *
 *   node scripts/candidacy-reconcile-selftest.ts
 *
 * SpotHero reached READY_TO_SUBMIT and a later scoring pass wrote REJECT
 * for the same job. Nothing revisited the application, so for two days
 * it described itself as ready to send while the authoritative verdict
 * said it must not be.
 */
import { reconcileOne, reconcileAll, type ApplicationState } from "../lib/applications/reconcileCandidacy.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};
const app = (over: Partial<ApplicationState> = {}): ApplicationState =>
  ({ id: "a1", status: "READY_TO_SUBMIT", submittedAt: null, humanApproved: true, ...over });

console.log("\nthe SpotHero sequence:");
{
  const r = reconcileOne(app(), "REJECT");
  check("READY_TO_SUBMIT under a REJECT is downgraded", r?.to === "AWAITING_REVIEW", JSON.stringify(r));
  check("and the approval is cleared with it", r?.clearApproval === true);
  check("the reason names the verdict", /REJECT/.test(r?.reason ?? ""), r?.reason);
  check("and says the document was not touched",
    /Nothing about the prepared document has been changed or removed/.test(r?.reason ?? ""), r?.reason);
}

console.log("\nverdicts that permit submission leave it alone:");
for (const v of ["APPLICATION_CANDIDATE", "STRETCH"]) {
  check(`${v} leaves READY_TO_SUBMIT untouched`, reconcileOne(app(), v) === null, v);
}

console.log("\nverdicts that do not:");
for (const v of ["REJECT", "MANUAL_REVIEW"]) {
  const r = reconcileOne(app(), v);
  check(`${v} returns it to review`, r?.to === "AWAITING_REVIEW", `${v}: ${JSON.stringify(r)}`);
}

console.log("\nprepared before candidacy existed:");
{
  // checkCandidacy refuses to prepare with no verdict at all, so this is
  // a state that should not arise. If it does, silence is not evidence
  // of a bad verdict and nothing is downgraded on the strength of it.
  check("no verdict at all changes nothing", reconcileOne(app(), null) === null);
}

console.log("\nsubmitted applications are never reconciled:");
{
  const sent = app({ status: "SUBMITTED", submittedAt: "2026-09-01T00:00:00Z" });
  check("a submitted application is untouched by a later REJECT",
    reconcileOne(sent, "REJECT") === null);
  const sentButOpen = app({ status: "AWAITING_REVIEW", submittedAt: "2026-09-01T00:00:00Z" });
  check("anything with a submitted_at is untouched, whatever its status",
    reconcileOne(sentButOpen, "REJECT") === null);
}

console.log("\nclosed applications stay closed:");
for (const s of ["ABANDONED", "WITHDRAWN", "REJECTED", "OFFER", "INTERVIEWING"]) {
  check(`${s} is not disturbed`, reconcileOne(app({ status: s }), "REJECT") === null, s);
}

console.log("\nearlier states are left to run their course:");
for (const s of ["DRAFT", "PREPARING", "BLOCKED_NEEDS_INPUT"]) {
  check(`${s} is not downgraded`, reconcileOne(app({ status: s }), "REJECT") === null, s);
}

console.log("\nan approval under a refusing verdict is cleared even without a status change:");
{
  const r = reconcileOne(app({ status: "AWAITING_REVIEW", humanApproved: true }), "REJECT");
  check("already at AWAITING_REVIEW but approved -> approval cleared",
    r !== null && r.clearApproval === true && r.to === "AWAITING_REVIEW", JSON.stringify(r));
  check("already at AWAITING_REVIEW and NOT approved -> nothing to do",
    reconcileOne(app({ status: "AWAITING_REVIEW", humanApproved: false }), "REJECT") === null);
}

console.log("\nthe artifact going stale is a separate question:");
{
  // Reconciliation says nothing about the document. A stale artifact is
  // caught by the approval binding in revalidateBeforeSubmit, and this
  // deliberately does not duplicate that judgement.
  const r = reconcileOne(app(), "REJECT");
  check("no artifact or resume field is implied by a reconciliation",
    r !== null && !("artifact" in r) && !("resumeId" in r), JSON.stringify(r));
}

console.log("\nbatch behaviour:");
{
  const apps = [
    app({ id: "keep", status: "READY_TO_SUBMIT" }),
    app({ id: "drop", status: "READY_TO_SUBMIT" }),
    app({ id: "sent", status: "SUBMITTED", submittedAt: "2026-09-01T00:00:00Z" }),
  ];
  const verdicts = new Map<string, string | null>([["keep", "STRETCH"], ["drop", "REJECT"], ["sent", "REJECT"]]);
  const out = reconcileAll(apps, verdicts);
  check("only the one whose verdict refuses is reconciled",
    out.length === 1 && out[0]!.applicationId === "drop", JSON.stringify(out.map((o) => o.applicationId)));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("application state cannot outlive the verdict that justified it");
