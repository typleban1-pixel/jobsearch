/**
 * Why a submission run stopped, in a form both a machine and a person can read.
 *
 * The gap this closes: classifyOutcome has always produced a reason string,
 * and the listener has always thrown it away, writing submit_outcome with no
 * record of the cause. A SAFE_STOP with no recorded reason is close to
 * useless — it says "nothing reached the employer" and nothing about why,
 * so the only way to learn anything is to run at the employer again. That
 * is exactly the thing worth not doing twice.
 *
 * application_events has no jsonb column and there is no DDL path, so the
 * record is encoded into the existing text `detail`: prose first for a
 * person, then a delimited single-line JSON block for a machine. Both halves
 * are written together or not at all.
 */

/** Where in the run it stopped. Ordered as the run passes through them. */
export const STOP_STAGES = [
  "preflight",      // gates, artifact, version — before any browser exists
  "revalidation",   // the approval no longer matches present facts
  "launch",         // browser/context could not be started
  "auth",           // a login wall, or a session that was not authenticated
  "navigation",     // the form URL did not resolve to a form
  "fill",           // writing answers into controls
  "readback",       // reading them back out again
  "pre-submit",     // form filled, submit control not resolved or not reached
] as const;
export type StopStage = (typeof STOP_STAGES)[number];

/**
 * Machine-readable cause. Kept coarse enough to be stable and specific
 * enough to route: each one implies a different next action by a person.
 */
export const STOP_CODES = [
  "REVALIDATION_REFUSED",         // revalidateBeforeSubmit said no
  "ARTIFACT_MISMATCH",            // stored artifact is not the approved one
  "STALE_JOB_VERSION",            // the posting moved under the approval
  "ALREADY_SUBMITTED",            // there is a submitted_at already
  "PROVIDER_DISABLED",            // adapter paused or capability not PRODUCTION
  "ADAPTER_REFUSED",              // the adapter declined this form
  "BROWSER_LAUNCH_FAILED",
  "LOGIN_WALL",                   // the employer demanded a sign-in
  "CAPTCHA_WALL",                 // a live challenge frame was present
  "EMAIL_VERIFICATION_REQUIRED",  // a code was mailed and must be typed
  "NAVIGATION_FAILED",            // the form URL did not load a form
  "UNEXPECTED_PAGE_STATE",        // the page was not the one the run expected
  "CONTROL_NOT_FOUND",            // a required control did not resolve
  "SUBMIT_CONTROL_AMBIGUOUS",     // resolved to zero or many, never clicked
  "FILL_INCOMPLETE",              // the fill did not reach handoff
  "READBACK_MISMATCH",            // what was written is not what is there
  "TIMEOUT",                      // the run was killed at the wall clock
  "RUNNER_CRASHED",               // threw, with a message
  "RUNNER_DIED_WITHOUT_REASON",   // the last resort; see below
] as const;
export type StopCode = (typeof STOP_CODES)[number];

export type StopRecord = {
  code: StopCode;
  stage: StopStage;
  /** One sentence a person can act on. Never empty. */
  detail: string;
  /** Whether a browser page existed at all when it stopped. */
  pageReached: boolean;
  url?: string | null;
  title?: string | null;
  /** Field-level trouble: read-back mismatches, controls that did not resolve. */
  mismatches?: { field: string; expected?: string; actual?: string }[];
};

const MARK = "stop-record:";

/** The event name carrying a stop record. One name, so one query finds them all. */
export const STOP_EVENT = "SUBMIT_SAFE_STOP";

/**
 * A stop with no detail is the bug this module exists to prevent, so an
 * empty detail is filled rather than allowed through: a record that says
 * only "SAFE_STOP" is what we had before.
 */
export function formatStopDetail(r: StopRecord): string {
  const prose = r.detail.trim() || `stopped at ${r.stage} (${r.code}) with no further detail recorded`;
  const where = r.pageReached
    ? `Page reached: ${r.url ?? "url unavailable"}${r.title ? ` — ${r.title}` : ""}.`
    : "No browser page was reached.";
  const bad = (r.mismatches ?? []).length
    ? " " + r.mismatches!.map((m) => `${m.field}: wrote ${JSON.stringify(m.expected ?? "")}, `
        + `read ${JSON.stringify(m.actual ?? "")}`).join("; ") + "."
    : "";
  const machine = JSON.stringify({
    code: r.code, stage: r.stage, pageReached: r.pageReached,
    url: r.url ?? null, title: r.title ?? null, mismatches: r.mismatches ?? [],
  });
  return `[${r.code} @ ${r.stage}] ${prose} ${where}${bad}\n${MARK}${machine}`;
}

/** Read a record back out of a stored detail. null when the text carries none. */
export function parseStopDetail(detail: string | null | undefined): StopRecord | null {
  if (!detail) return null;
  const line = detail.split("\n").find((l) => l.startsWith(MARK));
  if (!line) return null;
  try {
    const o = JSON.parse(line.slice(MARK.length));
    if (!STOP_CODES.includes(o.code) || !STOP_STAGES.includes(o.stage)) return null;
    const prose = detail.split("\n")[0] ?? "";
    return {
      code: o.code, stage: o.stage, detail: prose,
      pageReached: Boolean(o.pageReached), url: o.url ?? null, title: o.title ?? null,
      mismatches: Array.isArray(o.mismatches) ? o.mismatches : [],
    };
  } catch { return null; }
}

/**
 * The invariant, as a function: a SAFE_STOP always resolves to some record.
 *
 * When the runner recorded one, that one is authoritative — it was written
 * by the code that was actually there. When it did not, the run died in a
 * way it could not describe (SIGKILL at the timeout, a crash before the
 * handler, a process that never started), and the honest answer is to say
 * so and carry whatever the runner managed to print. It is deliberately not
 * a guess about the cause: RUNNER_DIED_WITHOUT_REASON means "we do not
 * know", which is a different and more useful claim than a plausible code.
 */
export function resolveStopRecord(input: {
  recorded: StopRecord | null;
  ok: boolean;
  tail: string;
  timedOut?: boolean;
}): StopRecord {
  if (input.recorded) return input.recorded;
  const tail = input.tail.trim();
  return {
    code: input.timedOut ? "TIMEOUT" : "RUNNER_DIED_WITHOUT_REASON",
    stage: "launch",
    pageReached: false,
    detail: input.timedOut
      ? `The run was killed at the wall clock before it recorded a stop reason. `
        + `Last output: ${tail || "(none)"}`
      : `The run ended ${input.ok ? "cleanly" : "with a failure"} without recording a stop `
        + `reason, so the cause is unknown rather than assumed. Last output: ${tail || "(none)"}`,
  };
}

/** Guard for callers: refuse to write a SAFE_STOP that carries no reason. */
export function assertStopRecorded(outcome: string, record: StopRecord | null): asserts record is StopRecord {
  if (outcome === "SAFE_STOP" && !record) {
    throw new Error("refusing to write SAFE_STOP with no stop record; that is the observability bug");
  }
}

/**
 * Map a fill adapter's own outcome word onto a stop code.
 *
 * The adapters have their own vocabulary and it is not going to be
 * rewritten to match this one; unknown words map to ADAPTER_REFUSED
 * rather than to a guess, and the adapter's word survives in the prose.
 */
export function fillStopCode(reason: string | null | undefined): StopCode {
  const r = String(reason ?? "").toUpperCase();
  if (/CAPTCHA|CHALLENGE|RECAPTCHA|TURNSTILE/.test(r)) return "CAPTCHA_WALL";
  if (/LOGIN|SIGN_?IN|AUTH/.test(r)) return "LOGIN_WALL";
  if (/VERIF|EMAIL_CODE|CODE_REQUIRED/.test(r)) return "EMAIL_VERIFICATION_REQUIRED";
  if (/NAVIGAT|NOT_FOUND|404|UNREACHABLE/.test(r)) return "NAVIGATION_FAILED";
  if (/SNAPSHOT|CHANGED|MISMATCH|READBACK/.test(r)) return "READBACK_MISMATCH";
  if (/CONTROL|FIELD_MISSING|NO_FIELD/.test(r)) return "CONTROL_NOT_FOUND";
  if (/UNEXPECTED|STATE/.test(r)) return "UNEXPECTED_PAGE_STATE";
  if (/BLOCKED|INCOMPLETE|PARTIAL/.test(r)) return "FILL_INCOMPLETE";
  return "ADAPTER_REFUSED";
}
