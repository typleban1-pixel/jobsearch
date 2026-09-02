/**
 * "Needs answers" must mean the same thing everywhere.
 *
 * Both Home Chef applications had every blocked answer resolved while
 * still carrying BLOCKED_NEEDS_INPUT. The queue read the answer rows and
 * correctly said nothing was blocked; anything reading the status
 * reported six items of work that did not exist.
 */
import { applicationsNeedingAnswers, blockedCount, needsAnswers, staleBlockedStatus,
  type AnswerRow } from "../lib/portal/answerCompleteness.ts";
import { present } from "../lib/portal/presentationState.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

const row = (app: string, state: string, required = true, answer: string | null = null): AnswerRow =>
  ({ application_id: app, confidence_state: state, is_required: required, answer_text: answer });

// The exact reported sequence.
{
  // Before: five blocked questions on each of two applications.
  const before: AnswerRow[] = [];
  for (const app of ["a", "b"]) for (let i = 0; i < 5; i++) before.push(row(app, "BLOCKED"));
  check("before answering, both applications need answers",
    applicationsNeedingAnswers(before).size === 2, "");
  check("and the blocked count is five each",
    blockedCount(before, "a") === 5 && blockedCount(before, "b") === 5, "");

  // After: every question answered.
  const after: AnswerRow[] = before.map((r) => ({ ...r, confidence_state: "HUMAN_CONFIRMED", answer_text: "No" }));
  check("after answering, no application needs answers",
    applicationsNeedingAnswers(after).size === 0, String(applicationsNeedingAnswers(after).size));
  check("and neither application counts individually",
    !needsAnswers(after, "a") && !needsAnswers(after, "b"), "");

  // The header, the queue and Apply all read this one condition, so a
  // stale status cannot make them disagree.
  const staleStatus = "BLOCKED_NEEDS_INPUT";
  check("a stale BLOCKED_NEEDS_INPUT does not create a need-answers item",
    !needsAnswers(after, "a"), "");
  check("and the stale status is detected for repair",
    staleBlockedStatus(staleStatus, blockedCount(after, "a")) === "AWAITING_REVIEW",
    String(staleBlockedStatus(staleStatus, blockedCount(after, "a"))));

  // Once repaired, the application presents as ready for review, not as
  // work waiting on an answer.
  const p = present({
    status: "AWAITING_REVIEW", humanApproved: false, allFieldsConfident: true,
    blockedAnswers: blockedCount(after, "a"), submittedAt: null, confirmationReceived: false,
    provider: "GREENHOUSE", refusals: [], handoff: false,
  }, "app-a");
  check("the repaired application is Ready, not Needs you", p.state === "READY", p.state);
  check("and its action is to review, not to answer",
    p.action?.label === "Review application", JSON.stringify(p.action));
  check("and it never says questions need answering",
    !/question/i.test(p.summary), p.summary);
}

// A status that is still genuinely blocked must not be repaired away.
{
  const mixed = [row("a", "BLOCKED"), row("a", "HUMAN_CONFIRMED", true, "No")];
  check("a genuinely blocked application is still counted",
    needsAnswers(mixed, "a"), "");
  check("and its status is left alone",
    staleBlockedStatus("BLOCKED_NEEDS_INPUT", blockedCount(mixed, "a")) === null, "");
}

// Only BLOCKED_NEEDS_INPUT is ever repaired.
for (const s of ["AWAITING_REVIEW", "READY_TO_SUBMIT", "DRAFT", "PREPARING", "SUBMITTED", "ABANDONED"]) {
  check(`${s} is never rewritten by the repair`, staleBlockedStatus(s, 0) === null, "");
}

// A closed application makes no claim on attention, whatever its
// answer rows still say.
//
// Six abandoned drafts kept unresolved blocked answers from before they
// were abandoned. The header counted them because it defined "live" as
// "not submitted", so it advertised six applications needing answers
// while the queue correctly showed none.
{
  const CLOSED = new Set(["ABANDONED", "WITHDRAWN", "REJECTED"]);
  const answers = [row("open-app", "BLOCKED"), row("abandoned-app", "BLOCKED")];
  const apps = [
    { id: "open-app", status: "BLOCKED_NEEDS_INPUT", submitted_at: null },
    { id: "abandoned-app", status: "ABANDONED", submitted_at: null },
  ];
  const blocked = applicationsNeedingAnswers(answers);

  const wrong = apps.filter((a) => !a.submitted_at).filter((a) => blocked.has(a.id)).length;
  const right = apps.filter((a) => !a.submitted_at && !CLOSED.has(a.status)).filter((a) => blocked.has(a.id)).length;

  check("the old definition counted an abandoned application", wrong === 2, String(wrong));
  check("live excludes closed applications", right === 1, String(right));
  check("and the open one is still counted", blocked.has("open-app"), "");
}

// A deliberate blank is an answer, not an absence.
{
  const blank = [row("a", "HUMAN_CONFIRMED", false, null)];
  check("a deliberately blank optional field does not need an answer",
    !needsAnswers(blank, "a"), "");
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
