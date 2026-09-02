/**
 * Whether an application still needs a human answer.
 *
 * One condition, one place. The homepage counter derived this from a
 * set of application ids built from blocked answer rows; the queue
 * derived it from the answer rows directly; Apply derived it from the
 * blocked count on each row. Three readings of the same fact will
 * eventually disagree, and they did: every blocked answer on both Home
 * Chef applications was resolved while both applications still carried
 * BLOCKED_NEEDS_INPUT, so anything reading the status reported work
 * that no longer existed.
 *
 * The authoritative condition is the answer rows. `status` is a cached
 * summary of them and may lag; it is never the source of truth for
 * "does this need me".
 */

export interface AnswerRow {
  application_id: string;
  confidence_state: string;
  is_required?: boolean | null;
  answer_text?: string | null;
}

/** Blocked answer rows for one application. */
export function blockedCount(answers: AnswerRow[], applicationId: string): number {
  return answers.filter((a) => a.application_id === applicationId && a.confidence_state === "BLOCKED").length;
}

/** The single condition every surface must agree on. */
export function needsAnswers(answers: AnswerRow[], applicationId: string): boolean {
  return blockedCount(answers, applicationId) > 0;
}

/** Application ids that genuinely still need a human answer. */
export function applicationsNeedingAnswers(answers: AnswerRow[]): Set<string> {
  const out = new Set<string>();
  for (const a of answers) if (a.confidence_state === "BLOCKED") out.add(a.application_id);
  return out;
}

/**
 * A status that no longer describes the answers underneath it.
 *
 * BLOCKED_NEEDS_INPUT with nothing blocked is stale, and the fix is to
 * move it on through the ordinary transition rather than to hide it
 * from a count. Returns the status it should hold, or null when the
 * status is already right.
 */
export function staleBlockedStatus(
  status: string, blocked: number, isEmployerFormHandoff = false,
): "AWAITING_REVIEW" | null {
  // An employer-form handoff is not an answer blocker and is not
  // resolved by having no blocked answers.
  //
  // Popl and Northern Trust have zero answer rows because Ashby and
  // Workday publish no form, so "nothing is blocked" is trivially true
  // and says nothing about whether a person still has to go and finish
  // the application. Clearing the block on that basis moved Popl to
  // AWAITING_REVIEW while it was still entirely unstarted, and the card
  // stopped saying what had to happen next.
  //
  // Such a handoff ends when the employer-side condition is dealt with:
  // the application is submitted, or it is abandoned. Not before.
  if (isEmployerFormHandoff) return null;
  return status === "BLOCKED_NEEDS_INPUT" && blocked === 0 ? "AWAITING_REVIEW" : null;
}

/**
 * Whether a blocked_reason describes an employer-form handoff rather
 * than a missing answer.
 *
 * Read from the text the preparation step wrote, because that is where
 * the distinction is recorded today.
 */
export function isEmployerFormHandoff(blockedReason: string | null | undefined): boolean {
  return /HANDOFF/i.test(String(blockedReason ?? ""));
}
