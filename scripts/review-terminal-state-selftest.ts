/**
 * Locks the review-screen state semantics the Enova bug exposed: a submitted
 * application's terminal state outranks pre-submit readiness, an uncertain
 * click is never shown as success, and "needs your answer" counts only
 * REQUIRED blocked answers -- optional demographics left blank never do.
 *   node scripts/review-terminal-state-selftest.ts
 */
import { classifyTerminalState } from "../lib/portal/reviewData.ts";
import { requiredBlocked } from "../lib/applications/revalidate.ts";
let bad = 0;
const ok = (c: boolean, w: string, got?: unknown) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${c ? "" : "  got=" + JSON.stringify(got)}`); if (!c) bad++; };

// Which banner the page shows: terminal state wins over warnings.
const bannerWins = (t: string, warnings: number) => t !== "NONE" ? t : (warnings > 0 ? "WARN" : "OTHER");

// 1. Unsubmitted with a genuine human blocker (required + BLOCKED).
{
  const t = classifyTerminalState({ submittedAt: null });
  const rb = requiredBlocked([{ is_required: true, confidence_state: "BLOCKED" }]);
  ok(t === "NONE" && rb === 1 && bannerWins(t, rb) === "WARN", "unsubmitted + required blocker -> NONE, needs-your-answer, warning banner", { t, rb });
}
// 2. Unsubmitted with ONLY optional unanswered/blocked fields -> not a blocker.
{
  const t = classifyTerminalState({ submittedAt: null });
  const rb = requiredBlocked([{ is_required: false, confidence_state: "BLOCKED" }, { is_required: false, confidence_state: "BLOCKED" }]);
  ok(t === "NONE" && rb === 0 && bannerWins(t, rb) === "OTHER", "unsubmitted + only optional blocked -> NONE, 0 needs-your-answer (the Enova count bug)", { t, rb });
}
// 3. Ready to submit: unsubmitted, nothing blocked.
{
  const t = classifyTerminalState({ submittedAt: null });
  const rb = requiredBlocked([{ is_required: true, confidence_state: "VERIFIED", answer_text: "x" } as any]);
  ok(t === "NONE" && rb === 0, "ready-to-submit -> NONE, 0 blocked", { t, rb });
}
// 4. Employer-confirmed submission WITH stale optional-blocked records -> CONFIRMED, terminal wins.
{
  const t = classifyTerminalState({ submittedAt: "2026-09-02T02:04:00Z", confirmationReference: "conf-123", submitOutcome: null });
  const rb = requiredBlocked([{ is_required: false, confidence_state: "BLOCKED" }, { is_required: false, confidence_state: "BLOCKED" }]);
  ok(t === "CONFIRMED" && bannerWins(t, rb) === "CONFIRMED", "confirmed submission + stale optional-blocked -> CONFIRMED terminal wins over warnings (the Enova bug)", { t, rb });
}
ok(classifyTerminalState({ submittedAt: "x", submitOutcome: "CONFIRMED" }) === "CONFIRMED", "submit_outcome CONFIRMED -> CONFIRMED");
// 5. SUBMISSION_UNCERTAIN must NOT render as confirmed.
ok(classifyTerminalState({ submittedAt: null, submitOutcome: "AMBIGUOUS" }) === "UNCERTAIN", "AMBIGUOUS -> UNCERTAIN, never CONFIRMED");
ok(classifyTerminalState({ submittedAt: "x", submitOutcome: "AMBIGUOUS" }) === "UNCERTAIN", "submitted + AMBIGUOUS -> UNCERTAIN (not success)");
// submitted, no outcome, no confirmation
ok(classifyTerminalState({ submittedAt: "x" }) === "SENT_UNCONFIRMED", "submitted, no confirmation -> SENT_UNCONFIRMED");

console.log(bad ? `\n${bad} FAILED` : `\nreview-terminal-state-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
