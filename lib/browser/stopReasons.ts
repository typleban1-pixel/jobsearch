/**
 * Every way filling can stop, named.
 *
 * A closed set, because "it stopped" is not a useful thing to read in an
 * audit trail six weeks later, and because a stop reason that does not
 * appear here is a code path nobody designed.
 */
/**
 * The successful terminal state.
 *
 * READBACK finished, the guards were torn down, and control returned to
 * a person with the form on screen and the submit control untouched. It
 * is emphatically NOT "submitted": nothing in this system can produce
 * that, and no outcome value means it.
 *
 * Kept out of STOP_REASONS because it is not a stop. Modelling success
 * as a stop reason is what made the outcome set look like it could be
 * exactly STOP_REASONS, and it cannot.
 */
export const HANDOFF = "HANDOFF" as const;

export const STOP_REASONS = [
  "LOGIN_WALL",
  "SSO_PROMPT",
  "CAPTCHA",
  "FORM_CHANGED",               // required field differs from the snapshot
  "POSTING_CHANGED",            // the employer published a newer version
  "SELECTOR_AMBIGUOUS",         // zero or several controls matched
  "UNLABELLED_REQUIRED_FIELD",
  "READBACK_MISMATCH",          // what was typed is not what the field holds
  "UPLOAD_UNACKNOWLEDGED",
  "PARSER_CONFLICT",            // an ATS parse collided with a prepared answer
  "PARSER_FILLED_BLOCKED_FIELD",// it answered something we refused to answer
  "PARSER_BEHAVIOUR_LEARNED",   // first evidence of overwriting; re-run with the right order
  "REQUIRED_FIELD_BLOCKED",
  "AMBIGUOUS_NAVIGATION",       // cannot prove a control advances rather than submits
  "SUBMISSION_ATTEMPT_BLOCKED", // a guard fired; always a hard stop
  "DYNAMIC_LOOP_LIMIT",
  "APPLICATION_NOT_READY",
  "NO_FORM_FOUND",
  "PROVIDER_UNSUPPORTED",
  "BROWSER_ERROR",
] as const;

export type StopReason = (typeof STOP_REASONS)[number];

/**
 * Every way a run can end: the one success, plus every stop.
 *
 * This is the set the database enum mirrors exactly. There is no value
 * meaning the system submitted anything, because there is no code path
 * that could produce one.
 */
export const FILL_OUTCOMES = [HANDOFF, ...STOP_REASONS] as const;
export type FillOutcomeName = (typeof FILL_OUTCOMES)[number];

/** Stops that mean "a person should look at this now", as opposed to a clean finish. */
export function isFailure(outcome: FillOutcomeName): boolean {
  return outcome !== HANDOFF;
}

export class Stop extends Error {
  readonly reason: StopReason;
  readonly detail: unknown;

  constructor(reason: StopReason, message: string, detail: unknown = null) {
    super(`${reason}: ${message}`);
    this.name = "Stop";
    this.reason = reason;
    this.detail = detail;
  }
}
