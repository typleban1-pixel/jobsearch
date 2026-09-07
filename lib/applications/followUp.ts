/**
 * Conditional follow-up questions: "If yes, please enter your position
 * title and dates."
 *
 * A follow-up has no meaning on its own. It depends on the yes/no question
 * just above it on the form, and the system already knows how that one was
 * answered. So:
 *
 *  - when the condition is not met (the form says "If yes" and the answer
 *    above is "No"), the follow-up is not applicable: it is resolved as a
 *    deliberate blank, derived from the parent answer, and never asked;
 *  - when the condition is met, or the parent is itself unanswered, the
 *    follow-up stays open -- but it carries the parent question and its
 *    answer, so the person reading "If yes, please enter your position
 *    title and dates" knows what the "yes" refers to.
 *
 * Only an optional follow-up is ever blanked: a required one that reads
 * as not applicable is a form the employer built strangely, and a person
 * should look at it rather than a rule leaving a required control empty.
 */
import type { FormField, ResolvedField } from "./answer.ts";

/**
 * "yes"/"no": the follow-up applies when the answer above is that. "any":
 * the wording refers back to another question ("If you selected Other",
 * "Please explain your answer", "Please specify") without a yes/no
 * condition the rule could decide; it is never blanked, only given context.
 */
export interface FollowUpCue { expects: "yes" | "no" | "any" }

/** Whether a label reads as a follow-up, and which parent answer it applies to. */
export function followUpCue(label: string): FollowUpCue | null {
  const t = label.trim();
  if (/^if\s+(?:yes|so|applicable|you\s+(?:do|have|did|are|were|answered\s+yes|selected\s+yes|said\s+yes))\b/i.test(t)) return { expects: "yes" };
  if (/^if\s+(?:no|not|you\s+(?:do not|don't|have not|haven't|did not|didn't|are not|aren't|answered\s+no|selected\s+no|said\s+no))\b/i.test(t)) return { expects: "no" };
  // Refers to another question without saying which answer it depends on.
  if (/^if\s+(?:other|you\s+(?:selected|answered|chose|indicated|checked|marked)|the answer|applicable to you|your answer)\b/i.test(t)) return { expects: "any" };
  if (/^(?:please\s+)?(?:specify|explain|elaborate|clarify|describe|provide\s+(?:more\s+)?(?:details|detail|information|specifics)|give\s+details|list\s+(?:them|which))\b/i.test(t)
    && /\b(?:your\s+(?:answer|response|selection|choice)|above|other|so|why|which|them)\b|^(?:please\s+)?(?:specify|explain|elaborate|clarify)\.?$/i.test(t)) return { expects: "any" };
  return null;
}

const YES = /^(?:yes|y|true)\b/i;
const NO = /^(?:no|n|false|none|not applicable|n\/a)\b/i;

/**
 * The question above `index` that a follow-up depends on.
 *
 * For a yes/no cue, the nearest closed choice above it. For a wording that
 * merely refers back ("Please explain your answer"), the question
 * immediately above, whatever its shape.
 */
export function parentQuestion(fields: FormField[], index: number, cue: FollowUpCue = { expects: "yes" }): FormField | null {
  if (cue.expects === "any") return index > 0 ? fields[index - 1]! : null;
  for (let i = index - 1; i >= 0; i--) {
    const f = fields[i]!;
    if (f.type === "select" || f.type === "boolean") return f;
    // A yes/no rendered as text options still counts; a free-text field does not.
    if ((f.options?.length ?? 0) >= 2) return f;
  }
  return null;
}

/** Whether the parent's answer satisfies the cue: true, false, or null when unknown. */
export function conditionMet(cue: FollowUpCue, parentAnswer: string | null): boolean | null {
  if (parentAnswer === null || cue.expects === "any") return null;
  const yes = YES.test(parentAnswer), no = NO.test(parentAnswer);
  if (!yes && !no) return null;
  return cue.expects === "yes" ? yes : no;
}

export interface FollowUpContext { question: string; answer: string | null }

/**
 * The parent question and its answer for a follow-up field, or null when
 * the field is not a follow-up or has no closed question above it.
 */
export function followUpContext(
  fields: FormField[], fieldKey: string, answerOf: (key: string) => string | null,
): FollowUpContext | null {
  const index = fields.findIndex((f) => f.key === fieldKey);
  const cue = index >= 0 ? followUpCue(fields[index]!.label) : null;
  if (!cue) return null;
  const parent = parentQuestion(fields, index, cue);
  return parent ? { question: parent.label, answer: answerOf(parent.key) } : null;
}

/** Whether an answer is one the fill would enter (mirrors the fill's FILLABLE set). */
const settled = (r: ResolvedField | undefined): r is ResolvedField =>
  Boolean(r && r.confidence !== "BLOCKED" && r.answer !== null);

export interface FollowUpOutcome {
  resolved: ResolvedField[];
  /** One line per follow-up that was blanked as not applicable. */
  blanked: string[];
}

/**
 * Apply the follow-up rule across one form's resolutions.
 *
 * `fields` is the frozen form in order; `resolved` is whatever the resolver
 * produced for the fields it did not skip. Returns the same array with
 * not-applicable follow-ups blanked and applicable ones annotated.
 */
export function resolveFollowUps(fields: FormField[], resolved: ResolvedField[]): FollowUpOutcome {
  const byKey = new Map(resolved.map((r) => [r.field.key, r]));
  const blanked: string[] = [];
  const out = resolved.map((r) => {
    if (r.confidence !== "BLOCKED") return r;
    const cue = followUpCue(r.field.label);
    if (!cue) return r;
    const index = fields.findIndex((f) => f.key === r.field.key);
    const parent = index >= 0 ? parentQuestion(fields, index, cue) : null;
    if (!parent) return r;
    const parentResolved = byKey.get(parent.key);
    const parentAnswer = settled(parentResolved) ? parentResolved.answer : null;
    const met = conditionMet(cue, parentAnswer);

    if (met === false && !r.field.required) {
      blanked.push(`${JSON.stringify(r.field.label)} left blank: follows ${JSON.stringify(parent.label)}, answered ${JSON.stringify(parentAnswer)}`);
      return {
        ...r,
        intentKey: "follow_up_not_applicable",
        matchedBy: `follow-up to ${JSON.stringify(parent.label)}, answered ${JSON.stringify(parentAnswer)}: not applicable`,
        answer: null, confidence: "DERIVED", blockKind: null, blockedReason: null,
        evidenceIds: parentResolved ? parentResolved.evidenceIds : [],
      } satisfies ResolvedField;
    }

    // Still a question for a person; say what it follows from.
    const because = parentAnswer === null
      ? `This follows ${JSON.stringify(parent.label)}, which is not answered yet.`
      : `This follows ${JSON.stringify(parent.label)}, answered ${JSON.stringify(parentAnswer)}.`;
    return { ...r, blockedReason: r.blockedReason ? `${because} ${r.blockedReason}` : because };
  });
  return { resolved: out, blanked };
}
