/**
 * Confirmation reconciliation for the assisted Lever flow.
 *
 * A person solves Lever's hCaptcha and clicks Submit in a controlled browser
 * this module keeps open. It then decides, from the page's OWN state, whether
 * the employer genuinely received the application. The discipline is the same
 * one the Greenhouse submitter uses: a 200 is not a confirmation, a form that
 * re-rendered with errors is not a confirmation, and an outcome that cannot be
 * proven is AMBIGUOUS -- never SUBMITTED and never retried.
 *
 * The classification is a pure function of two page snapshots (before the
 * human acts, and after), so it is unit-testable against real Lever markup
 * without submitting anything.
 */

/** Wording a genuine confirmation page shows. Same family the Greenhouse
 *  submitter accepts; Lever's own thanks page reads "Thank you for applying". */
export const CONFIRM_SUCCESS = /thank you for applying|thank you|application (?:has been )?(?:received|submitted)|we[’']?ve received|successfully submitted|your application (?:was|has been) (?:received|submitted)/i;
const DUPLICATE = /already (?:applied|submitted)|duplicate application/i;
const VALIDATION = /please (?:enter|select|complete|correct)|this field is required|is required\b/i;
/** Lever's confirmation route. Posting apply pages are /{org}/{id}/apply;
 *  a received application lands on /{org}/{id}/thanks (or a /thanks* variant). */
export const LEVER_THANKS_URL = /jobs\.lever\.co\/[^/]+\/[0-9a-f-]+\/thanks/i;

export interface PageSnapshot {
  url: string;
  text: string;
  /** count of form controls still on the page (inputs/selects/textareas/submit) */
  controls: number;
  /** true if an application <form> with a submit control is still present */
  formPresent: boolean;
  /** visible error elements' text, if any */
  errors: string[];
  /** an anti-bot challenge is visibly displayed */
  captchaVisible: boolean;
}

export type LeverOutcome = "CONFIRMED" | "AMBIGUOUS" | "NOT_SUBMITTED";

export interface OutcomeVerdict {
  outcome: LeverOutcome;
  reason: string;
  /** signals that fed the decision, for the audit record */
  signals: Record<string, unknown>;
}

/**
 * Decide the outcome from the before/after snapshots.
 *
 *   CONFIRMED     the page moved to a Lever thanks URL, OR shows explicit
 *                 success wording the apply form was NOT already showing, AND
 *                 the application form is gone / controls dropped, AND no
 *                 captcha / duplicate / validation / error is blocking.
 *   NOT_SUBMITTED the apply form is still present and unchanged and no
 *                 confirmation appeared: the person did not (successfully)
 *                 submit. Also the "closed the window while still on the
 *                 untouched form" case (navigated=false).
 *   AMBIGUOUS     everything else: navigation happened but no clear success
 *                 (unexpected redirect, hang, network error, window closed
 *                 after leaving the form). Never SUBMITTED, never retried.
 *
 * `after` is null when the browser/page closed before any confirmation could
 * be read; `navigatedAway` records whether the form was ever left.
 */
export function classifyLeverOutcome(before: PageSnapshot, after: PageSnapshot | null, opts: { navigatedAway: boolean; timedOut: boolean } = { navigatedAway: false, timedOut: false }): OutcomeVerdict {
  const introduced = (re: RegExp) => Boolean(after) && re.test(after!.text) && !re.test(before.text);

  // The window closed (no readable final state).
  if (!after) {
    if (opts.navigatedAway) {
      return { outcome: "AMBIGUOUS", reason: "the window closed after leaving the application form, with no confirmation observed", signals: { navigatedAway: true, after: null } };
    }
    return { outcome: "NOT_SUBMITTED", reason: "the window closed while still on the unchanged application form; no submission was made", signals: { navigatedAway: false, after: null } };
  }

  const onThanks = LEVER_THANKS_URL.test(after.url);
  const successText = CONFIRM_SUCCESS.test(after.text) && !CONFIRM_SUCCESS.test(before.text);
  const formGone = !after.formPresent || after.controls < before.controls;

  // Blocking conditions: never CONFIRMED while any of these hold.
  const blockers: string[] = [];
  if (after.captchaVisible) blockers.push("an anti-bot challenge is displayed");
  if (introduced(DUPLICATE)) blockers.push("the page mentions an existing or duplicate application");
  if (introduced(VALIDATION)) blockers.push("the page introduced validation text");
  if (after.errors.length) blockers.push(`error elements present: ${after.errors.join(" | ").slice(0, 160)}`);

  if ((onThanks || successText) && formGone && blockers.length === 0) {
    return { outcome: "CONFIRMED", reason: onThanks ? "Lever navigated to its application-received (thanks) page" : "the page shows an application-received confirmation and the form is gone", signals: { onThanks, successText, formGone, url: after.url } };
  }

  // The form is still present, unchanged, no success, nothing left: not submitted.
  if (after.formPresent && !onThanks && !successText && !opts.navigatedAway && !opts.timedOut) {
    return { outcome: "NOT_SUBMITTED", reason: "the application form is still present and no confirmation appeared; no submission was completed", signals: { formPresent: true, blockers } };
  }

  // A validation error / captcha kept the form: the click did not go through.
  if (after.formPresent && blockers.length > 0) {
    return { outcome: "NOT_SUBMITTED", reason: `the submission did not complete: ${blockers.join("; ")}`, signals: { blockers } };
  }

  // Anything else -- navigation without a clear confirmation, a hang/timeout,
  // an unexpected redirect -- is genuinely uncertain.
  return { outcome: "AMBIGUOUS", reason: opts.timedOut ? "timed out without a confirmation being observed" : "the page left the form but no application-received confirmation could be proven", signals: { onThanks, successText, formGone, blockers, timedOut: opts.timedOut, url: after.url } };
}

/** Read the current page into a snapshot. Best-effort; never throws. */
export async function readLeverSnapshot(page: any): Promise<PageSnapshot> {
  try {
    const url = page.url();
    const data = await page.evaluate(() => {
      const text = (document.body?.innerText || "").slice(0, 20000);
      const controls = document.querySelectorAll("form input, form select, form textarea, form button[type=submit], form input[type=submit]").length;
      const formPresent = Array.from(document.querySelectorAll("form")).some((f) => f.querySelector("input,select,textarea"));
      const errs = Array.from(document.querySelectorAll("[class*=error i], [role=alert], .field-error, .form-error"))
        .map((e) => (e.textContent || "").trim()).filter((t) => t && t.length < 200).slice(0, 6);
      const captchaVisible = Array.from(document.querySelectorAll(".h-captcha, .g-recaptcha, iframe[src*='hcaptcha'], iframe[src*='recaptcha']"))
        .some((el) => { const r = (el as HTMLElement).getBoundingClientRect?.(); return r && r.width > 0 && r.height > 0; });
      return { text, controls, formPresent, errors: errs, captchaVisible };
    });
    return { url, ...data };
  } catch {
    return { url: "", text: "", controls: 0, formPresent: false, errors: [], captchaVisible: false };
  }
}

/**
 * Keep the page open and watch for the human to submit. Returns as soon as a
 * CONFIRMED state is proven, or when the page closes, or on timeout.
 */
export async function watchForHumanSubmit(page: any, before: PageSnapshot, opts: { timeoutMs?: number; pollMs?: number; onState?: (s: PageSnapshot) => void } = {}): Promise<{ verdict: OutcomeVerdict; after: PageSnapshot | null; navigatedAway: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const pollMs = opts.pollMs ?? 2000;
  const started = Date.now();
  let navigatedAway = false;
  let last: PageSnapshot | null = null;
  const sameUrl = (a: string, b: string) => a.split("?")[0] === b.split("?")[0];

  while (Date.now() - started < timeoutMs) {
    let closed = false;
    try { if (page.isClosed?.()) closed = true; } catch { closed = true; }
    if (closed) return { verdict: classifyLeverOutcome(before, null, { navigatedAway, timedOut: false }), after: null, navigatedAway };

    const s = await readLeverSnapshot(page);
    last = s;
    opts.onState?.(s);
    if (s.url && !sameUrl(s.url, before.url)) navigatedAway = true;
    if (!s.formPresent || s.controls < before.controls) navigatedAway = true;

    const v = classifyLeverOutcome(before, s, { navigatedAway, timedOut: false });
    if (v.outcome === "CONFIRMED") return { verdict: v, after: s, navigatedAway };
    // A definite NOT_SUBMITTED with the form untouched just means the human
    // has not acted yet -- keep waiting rather than concluding.
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { verdict: classifyLeverOutcome(before, last, { navigatedAway, timedOut: true }), after: last, navigatedAway };
}
