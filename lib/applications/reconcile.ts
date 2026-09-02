/**
 * What survives when an application is prepared a second time.
 *
 * Re-preparing used to delete every answer and write the new set over
 * the top. For VERIFIED and DERIVED answers that is right: they are
 * computed from current truth, and recomputing them is how they stay
 * correct. For an answer a person typed it is destruction. They read the
 * question, decided what was true, and typed it; a second preparation
 * because the employer edited the job description is not a reason to
 * make them do it again, and doing it silently is worse than doing it
 * loudly.
 *
 * So human answers are carried across, and the whole question is when
 * that is safe. The rule is materially the same question: the same
 * control, asked the same way, still offering the answer that was given.
 * Anything else and the old answer is kept in the audit log and the new
 * field blocks, because a person answering "Yes" to one question has not
 * answered a different one.
 */
import { normalizeQuestion } from "../feedback/classify.ts";
import type { FormField, ResolvedField } from "./answer.ts";

/** One answer already stored against this application. */
export interface ExistingAnswer {
  id: string;
  fieldKey: string | null;
  fieldLabel: string | null;
  questionText: string | null;
  answerText: string | null;
  confidenceState: string;
  provenance: string | null;
  evidenceIds: string[];
  promoteToBank: boolean | null;
  questionBankId: string | null;
}

export type CarryDecision =
  | { carry: true; because: string }
  | { carry: false; because: string };

/**
 * May this stored human answer be given to this newly resolved field?
 *
 * Every condition here is a way the question could have changed under an
 * answer that stayed the same. None of them is about how confident the
 * old answer was: it was confirmed by a person, and the only question is
 * whether it was confirmed about THIS.
 */
export function mayCarry(old: ExistingAnswer, field: FormField, resolved: ResolvedField): CarryDecision {
  // Only human work is protected. A computed answer is recomputed, which
  // is how it tracks the truth it came from.
  if (old.confidenceState !== "HUMAN_CONFIRMED") {
    return { carry: false, because: `${old.confidenceState} answers are recomputed from current truth` };
  }

  // The resolver found a real answer this time. Truth that can now be
  // established beats a remembered reply, and replacing it is not a
  // loss: the old answer stays in the log either way.
  if (resolved.confidence !== "BLOCKED") {
    return { carry: false, because: `the system can now answer this itself, as ${resolved.confidence}` };
  }

  // A field this system refuses to fill is refused however it was
  // answered before.
  if (resolved.refused) {
    return { carry: false, because: "this field is never filled by this system" };
  }

  if ((old.fieldKey ?? "") !== field.key) {
    return { carry: false, because: `the control changed from ${old.fieldKey ?? "(none)"} to ${field.key}` };
  }

  // Wording is compared normalized, so punctuation and required-field
  // markers moving around do not count as a new question. Words do
  // count: "commute to our Chicago office" and "commute to our New York
  // office" are different questions and must stay different.
  const before = normalizeQuestion(old.questionText ?? old.fieldLabel ?? "");
  const now = normalizeQuestion(field.label);
  if (!before || before !== now) {
    return { carry: false, because: `the question changed from "${before}" to "${now}"` };
  }

  // "Leave blank" is a real answer and carries like any other.
  if (old.answerText === null) {
    return { carry: true, because: "you chose to leave this blank, and it is the same question" };
  }

  // An option control that no longer offers the answer that was given is
  // a changed question whatever its wording says. Mapping the old answer
  // onto whichever new option looks closest is the guess this system
  // does not make.
  const options = field.options ?? [];
  if (options.length > 0 && !options.some((o) => o.trim().toLowerCase() === old.answerText!.trim().toLowerCase())) {
    return { carry: false, because: `the options changed and no longer offer ${JSON.stringify(old.answerText)}` };
  }

  return { carry: true, because: "the same question, the same control, and the answer is still offered" };
}

export interface Reconciliation {
  resolved: ResolvedField[];
  /** Human answers carried across, by field key, with the reason. */
  carried: Array<{ field: FormField; old: ExistingAnswer; because: string }>;
  /** Human answers NOT carried across, and why. Written to the log. */
  dropped: Array<{ old: ExistingAnswer; because: string }>;
}

/**
 * Applies the rule above across a whole preparation.
 *
 * Returns the resolved set with carried answers substituted in, plus the
 * two lists needed to explain what happened. Nothing here writes: the
 * caller decides what to do with the result, which is what lets the
 * whole set be validated before anything is destroyed.
 */
export function reconcileAnswers(
  fresh: ResolvedField[], existing: ExistingAnswer[],
): Reconciliation {
  const byKey = new Map<string, ExistingAnswer>();
  for (const e of existing) if (e.fieldKey) byKey.set(e.fieldKey, e);

  const out: Reconciliation = { resolved: [], carried: [], dropped: [] };
  const considered = new Set<string>();

  for (const r of fresh) {
    const old = byKey.get(r.field.key);
    if (!old) { out.resolved.push(r); continue; }
    considered.add(old.id);

    const verdict = mayCarry(old, r.field, r);
    if (!verdict.carry) {
      // Only a genuine loss is reported. An answer the resolver has just
      // reproduced word for word was not dropped, it was recomputed, and
      // logging that as lost human work would fill the audit trail with
      // events that describe nothing happening.
      const reproduced = r.answer !== null && old.answerText !== null
        && r.answer.trim().toLowerCase() === old.answerText.trim().toLowerCase();
      if (old.confidenceState === "HUMAN_CONFIRMED" && !reproduced) {
        out.dropped.push({ old, because: verdict.because });
      }
      out.resolved.push(r);
      continue;
    }

    out.carried.push({ field: r.field, old, because: verdict.because });
    out.resolved.push({
      ...r,
      answer: old.answerText,
      confidence: "HUMAN_CONFIRMED",
      blockKind: null,
      blockedReason: null,
      // Whatever a human answer cited before, it still cites. It is not
      // given evidence it did not have.
      evidenceIds: old.evidenceIds,
      matchedBy: `carried forward: ${verdict.because}`,
    });
  }

  // A human answer whose field is not on the form any more. It cannot be
  // carried anywhere, and it is still part of the record.
  for (const e of existing) {
    if (considered.has(e.id) || e.confidenceState !== "HUMAN_CONFIRMED") continue;
    out.dropped.push({ old: e, because: "the form no longer asks this question" });
  }

  return out;
}
