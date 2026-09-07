/**
 * Conditional follow-ups: "If yes, please enter your position title and dates."
 *
 *   node scripts/follow-up-selftest.ts
 *
 * Pure. Holds the rule in lib/applications/followUp.ts to its contract:
 * a follow-up whose condition the parent answer rules out is blanked as
 * not applicable; one whose condition is met, or whose parent is
 * unanswered, stays open and names its parent; a required follow-up is
 * never blanked by rule; anything that is not a follow-up is untouched.
 */
import { followUpCue, parentQuestion, conditionMet, followUpContext, resolveFollowUps } from "../lib/applications/followUp.ts";
import type { FormField, ResolvedField } from "../lib/applications/answer.ts";

let bad = 0;
const ok = (c: boolean, label: string, extra?: unknown) => {
  if (!c) { bad++; console.log(`  FAIL  ${label}`, extra === undefined ? "" : JSON.stringify(extra)); } else console.log(`  PASS  ${label}`);
};

const f = (key: string, label: string, type: FormField["type"], required = false, options?: string[]): FormField =>
  ({ key, label, type, required, ...(options ? { options } : {}) });
const blocked = (field: FormField, why = "nothing in the question catalog matches this wording"): ResolvedField =>
  ({ field, intentKey: null, matchedBy: "none", answer: null, confidence: "BLOCKED", blockKind: "UNKNOWN", blockedReason: why, evidenceIds: [], considered: [], refused: false });
const answered = (field: FormField, answer: string, confidence: ResolvedField["confidence"] = "VERIFIED"): ResolvedField =>
  ({ field, intentKey: "x", matchedBy: "pattern", answer, confidence, blockKind: null, blockedReason: null, evidenceIds: ["e1"], considered: [], refused: false });

// The William Blair form, as frozen.
const fields: FormField[] = [
  f("q1", "Do you have a notice period with your current employer or other restrictions on your availability to start?", "select", true, ["Yes", "No"]),
  f("q2", "If yes, please outline notice period details or restrictions on your availability to start.", "text"),
  f("q3", "Have you ever been employed by William Blair?", "select", true, ["Yes", "No"]),
  f("q4", "If yes, please enter your position title and dates.", "text"),
  f("q5", "Are you related to a William Blair employee or client?", "select", true, ["Yes", "No"]),
  f("q6", "If no, please explain why not.", "text"),
  f("q7", "If yes, who?", "text", true),
];

console.log("cues");
ok(followUpCue("If yes, please enter your position title and dates.")?.expects === "yes", "'If yes' expects yes");
ok(followUpCue("If so, which ones?")?.expects === "yes", "'If so' expects yes");
ok(followUpCue("If applicable, list your certifications")?.expects === "yes", "'If applicable' expects yes");
ok(followUpCue("If no, please explain why not.")?.expects === "no", "'If no' expects no");
ok(followUpCue("If not, why?")?.expects === "no", "'If not' expects no");
ok(followUpCue("If you selected Other, please specify.")?.expects === "any", "'If you selected' refers back without a yes/no condition");
ok(followUpCue("Please explain your answer.")?.expects === "any", "'Please explain your answer' refers back");
ok(followUpCue("Please specify")?.expects === "any", "a bare 'Please specify' refers back");
ok(followUpCue("Please describe your experience with SQL.") === null, "'Please describe <a topic>' stands alone");
ok(followUpCue("Have you ever been employed by William Blair?") === null, "a plain question is not a follow-up");
ok(followUpCue("Describe a time you led a project, if any.") === null, "an 'if' mid-sentence is not a cue");

console.log("parents");
ok(parentQuestion(fields, 3)?.key === "q3", "the parent is the nearest closed question above");
ok(parentQuestion(fields, 1)?.key === "q1", "the first follow-up's parent is the first question");
ok(parentQuestion(fields, 0) === null, "nothing above the first question");
ok(parentQuestion([f("a", "How did you hear about us?", "select", true, ["Referral", "Other"]), f("b", "If Other, tell us more", "text"), f("c", "Please explain your answer.", "text")], 2, { expects: "any" })?.key === "b",
  "a referring-back wording takes the question immediately above, whatever its shape");
ok(conditionMet({ expects: "any" }, "Other") === null, "a referring-back cue is never decided by rule");

console.log("conditions");
ok(conditionMet({ expects: "yes" }, "No") === false, "'If yes' with No is not met");
ok(conditionMet({ expects: "yes" }, "Yes") === true, "'If yes' with Yes is met");
ok(conditionMet({ expects: "no" }, "Yes") === false, "'If no' with Yes is not met");
ok(conditionMet({ expects: "yes" }, null) === null, "an unanswered parent is unknown");
ok(conditionMet({ expects: "yes" }, "Prefer not to say") === null, "a non-yes/no parent answer is unknown, never assumed");

console.log("resolution");
{
  const resolved = [
    blocked(fields[0]!),                 // notice period: still blocked
    blocked(fields[1]!),                 // its follow-up: parent unanswered
    answered(fields[2]!, "No"),          // employed by William Blair: No
    blocked(fields[3]!),                 // its follow-up: not applicable
    answered(fields[4]!, "No", "HUMAN_CONFIRMED"), // related: No
    blocked(fields[5]!),                 // "If no, explain": applicable
    blocked(fields[6]!),                 // "If yes, who?" required: not applicable but required
  ];
  const { resolved: out, blanked } = resolveFollowUps(fields, resolved);
  const by = new Map(out.map((r) => [r.field.key, r]));

  const q4 = by.get("q4")!;
  ok(q4.confidence === "DERIVED" && q4.answer === null && q4.blockedReason === null, "'If yes' after a No is blanked, derived, not blocked", q4);
  ok(q4.intentKey === "follow_up_not_applicable" && /William Blair/.test(q4.matchedBy), "and it records which answer made it not applicable", q4.matchedBy);
  ok(q4.evidenceIds.length === 1, "and inherits the parent's evidence", q4.evidenceIds);

  const q2 = by.get("q2")!;
  ok(q2.confidence === "BLOCKED" && /not answered yet/.test(q2.blockedReason ?? ""), "a follow-up of an unanswered parent stays open and says so", q2.blockedReason);
  ok(/notice period/.test(q2.blockedReason ?? "") && /question catalog/.test(q2.blockedReason ?? ""), "keeping the original reason after the context", q2.blockedReason);

  const q6 = by.get("q6")!;
  ok(q6.confidence === "BLOCKED" && /answered "No"/.test(q6.blockedReason ?? ""), "'If no' after a No is applicable: still asked, with its parent named", q6.blockedReason);

  const q7 = by.get("q7")!;
  ok(q7.confidence === "BLOCKED", "a REQUIRED follow-up is never blanked by rule", q7);
  ok(/answered "No"/.test(q7.blockedReason ?? ""), "but still carries its context", q7.blockedReason);

  ok(by.get("q1")!.confidence === "BLOCKED" && by.get("q1")!.blockedReason === "nothing in the question catalog matches this wording", "a non-follow-up is untouched");
  ok(by.get("q3")!.answer === "No" && by.get("q3")!.confidence === "VERIFIED", "answered fields are untouched");
  ok(blanked.length === 1 && /position title/.test(blanked[0]!), "exactly one field was blanked, and it is reported", blanked);
}

console.log("portal context");
{
  const answers = new Map<string, string | null>([["q3", "No"], ["q1", null]]);
  const answerOf = (k: string) => answers.get(k) ?? null;
  const c4 = followUpContext(fields, "q4", answerOf);
  ok(c4?.question === fields[2]!.label && c4?.answer === "No", "the questions page gets the parent and its answer", c4);
  const c2 = followUpContext(fields, "q2", answerOf);
  ok(c2?.question === fields[0]!.label && c2?.answer === null, "an unanswered parent is reported as such", c2);
  ok(followUpContext(fields, "q3", answerOf) === null, "a plain question has no context line");
  const ref = [f("a", "How did you hear about us?", "select", true, ["Referral", "Other"]), f("b", "If you selected Other, please specify.", "text")];
  const cb = followUpContext(ref, "b", (k) => (k === "a" ? "Other" : null));
  ok(cb?.question === ref[0]!.label && cb?.answer === "Other", "a referring-back question shows what it refers to", cb);
  const { resolved: kept } = resolveFollowUps(ref, [answered(ref[0]!, "Other", "HUMAN_CONFIRMED"), blocked(ref[1]!)]);
  ok(kept[1]!.confidence === "BLOCKED" && /answered "Other"/.test(kept[1]!.blockedReason ?? ""), "and stays a question for a person, with that context", kept[1]!.blockedReason);
}

console.log(bad ? `\n${bad} FAILED` : "\nfollow-up-selftest: ALL PASS");
process.exit(bad ? 1 : 0);


// A follow-up the form declares by structure: "What event did you attend?"
// is shown only when "How did you first hear about Flexport?" is answered
// "Event (...)". Flexport lists the child BEFORE its parent.
{
  const { resolveFollowUps, followUpContext } = await import("../lib/applications/followUp.ts");
  const flex = [
    { key: "li", label: "LinkedIn Profile", type: "text" as const, required: false },
    { key: "ev", label: "What event did you attend?", type: "select" as const, required: true, options: ["NYU", "Georgia Tech", "USC"] },
    { key: "src", label: "How did you first hear about Flexport?", type: "select" as const, required: true,
      options: ["Campus", "Career Platform (LinkedIn, Glassdoor, BuiltIn, etc.)", "Event (Tech Talks at Sea, Conference, Meetup, etc.)", "Flexport Blog"] },
  ];
  const blocked = (key: string, label: string) => ({ field: flex.find((f) => f.key === key)!, intentKey: null, matchedBy: "x", answer: null,
    confidence: "BLOCKED" as const, blockKind: "UNKNOWN" as const, blockedReason: "nothing matches", evidenceIds: [], considered: [], refused: false });
  const answered = (key: string, answer: string) => ({ ...blocked(key, ""), answer, confidence: "LOW_STAKES_SURVEY" as const, blockKind: null, blockedReason: null });
  const notEvent = resolveFollowUps(flex, [answered("li", "https://x"), blocked("ev", ""), answered("src", "Career Platform (LinkedIn, Glassdoor, BuiltIn, etc.)")]);
  const ev = notEvent.resolved.find((r) => r.field.key === "ev")!;
  ok(ev.confidence !== "BLOCKED" && ev.answer === null, "the event question is blanked when the source was not an event, even though the snapshot marks it required", ev.confidence);
  ok(/How did you first hear/.test(ev.matchedBy), "and the blank names the parent question", ev.matchedBy);
  const isEvent = resolveFollowUps(flex, [answered("li", "https://x"), blocked("ev", ""), answered("src", "Event (Tech Talks at Sea, Conference, Meetup, etc.)")]);
  const ev2 = isEvent.resolved.find((r) => r.field.key === "ev")!;
  ok(ev2.confidence === "BLOCKED" && /How did you first hear/.test(ev2.blockedReason ?? ""), "when the source WAS an event it stays a question, with the parent named", ev2.blockedReason ?? "");
  const ctx = followUpContext(flex, "ev", (k) => (k === "src" ? "Event (Tech Talks at Sea, Conference, Meetup, etc.)" : null));
  ok(ctx?.question === "How did you first hear about Flexport?" && /Event/.test(ctx?.answer ?? ""), "the questions page gets the parent and its answer as context", JSON.stringify(ctx));
  ok(followUpContext(flex, "li", () => null) === null, "a plain text field is not linked to anything");
}
