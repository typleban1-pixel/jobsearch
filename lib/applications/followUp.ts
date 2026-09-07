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
export interface FollowUpCue {
  expects: "yes" | "no" | "any" | "option";
  /** For "option": the parent option this question is shown for, and the word that linked them. */
  option?: string;
  keyword?: string;
}

/**
 * A follow-up the form declares by structure rather than by wording.
 *
 * Greenhouse's "What event did you attend?" says nothing about being
 * conditional; it is shown only when "How did you first hear about
 * Flexport?" was answered "Event (Tech Talks at Sea, Conference, ...)".
 * The link is in the form itself: a nearby choice question offers an
 * option naming the very thing this question asks about. When that is
 * so, this question applies exactly when that option is the answer --
 * and when a different option was chosen the employer's form never shows
 * it, so it is not a question at all, required or not.
 *
 * Nouns are taken from the label with the question words removed; an
 * option matches when it contains one as a whole word. The parent is
 * looked for on both sides, because the board API does not always list a
 * conditional child after its parent (Flexport lists it before).
 */
const NOT_A_NOUN = new Set(["what", "which", "when", "where", "please", "your", "you", "did", "does", "attend", "attended",
  "select", "specify", "name", "list", "describe", "provide", "other", "have", "were", "with", "from", "that", "this",
  "there", "their", "them", "would", "will", "about", "into", "many", "much", "type", "kind"]);
export function optionLinkedParent(
  fields: FormField[], index: number,
): { parent: FormField; option: string; keyword: string } | null {
  const label = fields[index]?.label ?? "";
  const nouns = label.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/)
    .filter((w) => w.length >= 4 && !NOT_A_NOUN.has(w));
  if (!nouns.length) return null;
  for (const offset of [-1, 1, -2, 2, -3, 3]) {
    const f = fields[index + offset];
    if (!f || (f.options?.length ?? 0) < 2) continue;
    for (const noun of nouns) {
      const re = new RegExp(`\\b${noun}s?\\b`, "i");
      const hits = (f.options ?? []).filter((o) => re.test(o));
      // Exactly one option names the thing; several would be ambiguous.
      if (hits.length === 1) return { parent: f, option: hits[0]!, keyword: noun };
    }
  }
  return null;
}

/** Whether a label reads as a follow-up, and which parent answer it applies to. */
export function followUpCue(label: string): FollowUpCue | null {
  const t = label.trim();
  // "If yes, ..." refers to the answer just given. "If you were referred
  // by an employee, who?" is a condition on a fact about the applicant,
  // asked on its own, and reading it as a follow-up tied it to whatever
  // question happened to sit above it (a pronoun choice, once). Only
  // wording that names an ANSWER is a cue.
  if (/^if\s+(?:yes|so|applicable|you\s+(?:answered|selected|said|chose|checked|marked|indicated)\s+["'“]?yes)\b/i.test(t)) return { expects: "yes" };
  if (/^if\s+(?:no|not|you\s+(?:answered|selected|said|chose|checked|marked|indicated)\s+["'“]?no)\b/i.test(t)) return { expects: "no" };
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
  // A wording cue ("If yes") refers to the question ABOVE; with nothing
  // above it there is nothing it can mean. Structure-declared follow-ups
  // (optionLinkedParent) look in both directions instead.
  return null;
}

/** Whether the parent's answer satisfies the cue: true, false, or null when unknown. */
export function conditionMet(cue: FollowUpCue, parentAnswer: string | null): boolean | null {
  if (parentAnswer === null || cue.expects === "any") return null;
  if (cue.expects === "option") {
    return cue.option ? parentAnswer.trim().toLowerCase() === cue.option.trim().toLowerCase() : null;
  }
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
  if (index < 0) return null;
  const linked = followUpOf(fields, index);
  if (!linked) return null;
  return { question: linked.parent.label, answer: answerOf(linked.parent.key) };
}

/** The cue and parent for a field, by wording first and by form structure second. */
export function followUpOf(fields: FormField[], index: number): { cue: FollowUpCue; parent: FormField } | null {
  const cue = followUpCue(fields[index]!.label);
  if (cue) {
    const parent = parentQuestion(fields, index, cue);
    return parent ? { cue, parent } : null;
  }
  const linked = optionLinkedParent(fields, index);
  return linked ? { cue: { expects: "option", option: linked.option, keyword: linked.keyword }, parent: linked.parent } : null;
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
    const index = fields.findIndex((f) => f.key === r.field.key);
    const linked = index >= 0 ? followUpOf(fields, index) : null;
    if (!linked) return r;
    const { cue, parent } = linked;
    const parentResolved = byKey.get(parent.key);
    const parentAnswer = settled(parentResolved) ? parentResolved.answer : null;
    const met = conditionMet(cue, parentAnswer);

    // Not applicable. A wording cue blanks only an optional field; an
    // option-linked one blanks even a required field, because the parent's
    // answer removes it from the employer's form altogether.
    if (met === false && (!r.field.required || cue.expects === "option")) {
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
