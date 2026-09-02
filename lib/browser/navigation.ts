/**
 * The only function in this codebase that clicks a page-level control.
 *
 * A React "Continue" and a React "Submit application" can be
 * structurally identical: both `type="button"`, both wired to a
 * JavaScript handler, both indistinguishable from the DOM. This does not
 * pretend to tell them apart. It requires positive evidence that the
 * form has more steps, and when that evidence is absent it stops and
 * hands the form to a person.
 *
 * A partly filled multi-step form that someone finishes by hand is the
 * intended product of a system whose rule is "stop on uncertainty". It
 * is not a degraded outcome.
 */
import type { Page, Frame, ElementHandle } from "playwright";
import { Stop } from "./stopReasons.ts";
import { SubmitGuard, isSubmitCapable, nameLooksLikeSubmit } from "./submitGuard.ts";

/** Text that means the application already went somewhere. */
const TERMINAL_PAGE = [
  /thank you/i, /application (?:received|submitted|complete)/i,
  /we(?:'| ha)ve received/i, /successfully (?:applied|submitted)/i,
];

export interface StepEvidence {
  multiStep: boolean;
  why: string;
}

/**
 * Positive evidence that this form has more steps.
 *
 * Absence of evidence is not evidence of a single-step form; it is the
 * reason to stop.
 */
export async function stepEvidence(frame: Frame, expectedFieldKeys: string[]): Promise<StepEvidence> {
  const dom = await frame.evaluate(() => {
    const q = (s: string) => document.querySelector(s) !== null;
    const stepish = q("[aria-current='step']") || q("progress")
      || q("[role='progressbar']") || q("[class*='step' i][class*='indicator' i]")
      || q("ol[class*='step' i]") || q("[data-testid*='step' i]");
    const present = Array.from(document.querySelectorAll("input,select,textarea"))
      .map((e) => (e as HTMLInputElement).name || e.id).filter(Boolean);
    return { stepish, present };
  });

  if (dom.stepish) return { multiStep: true, why: "the page shows a step indicator" };

  // A field the snapshot says is required but which is not in the DOM
  // has to appear somewhere, which means there is another step.
  const missing = expectedFieldKeys.filter((k) => !dom.present.includes(k));
  if (missing.length > 0) {
    return { multiStep: true, why: `${missing.length} snapshotted field(s) are not on this page yet` };
  }
  return { multiStep: false, why: "no step indicator, and every snapshotted field is already on this page" };
}

/**
 * Advances one step, or stops.
 *
 * Every layer in submitGuard.ts is in force around this click. The probe
 * ordering matters: the guard is armed BEFORE the click, so a control
 * that turns out to submit produces a cancelled event rather than an
 * application.
 */
export async function advanceStep(
  frame: Frame,
  guard: SubmitGuard,
  candidate: ElementHandle<Element>,
  expectedFieldKeys: string[],
  /** Required controls on this step that have no answer. */
  unresolvedRequired: string[] = [],
): Promise<void> {
  // Before anything else: a step is never advanced while something
  // required on this one is unanswered. Moving on would either leave a
  // gap the person cannot see or let the ATS decide what the blank
  // means, and the guard belongs here rather than at the call site so it
  // cannot be forgotten by a future caller.
  if (unresolvedRequired.length > 0) {
    throw new Stop("REQUIRED_FIELD_BLOCKED",
      `cannot advance: ${unresolvedRequired.length} required field(s) on this step are unresolved: ` +
      unresolvedRequired.map((u) => `"${u}"`).join(", "));
  }

  // Layer 1: structure, before any text.
  const structural = await isSubmitCapable(candidate);
  if (structural.capable) {
    throw new Stop("AMBIGUOUS_NAVIGATION",
      `refusing to click a control that is structurally able to submit (${structural.why})`);
  }

  // Layer 4: defence in depth, expected to be redundant.
  const name = ((await candidate.getAttribute("aria-label"))
    ?? (await candidate.textContent()) ?? "").trim();
  if (nameLooksLikeSubmit(name)) {
    throw new Stop("AMBIGUOUS_NAVIGATION",
      `refusing to click a control named "${name.slice(0, 60)}"`);
  }

  // The evidence requirement. No evidence, no click.
  const evidence = await stepEvidence(frame, expectedFieldKeys);
  if (!evidence.multiStep) {
    throw new Stop("AMBIGUOUS_NAVIGATION",
      `cannot establish that "${name.slice(0, 40)}" advances a step rather than submitting: ${evidence.why}`);
  }

  const before = frame.url();
  // Baseline first: what matters is whether THIS click caused a blocked
  // request, not whether one was ever blocked in this browser.
  const mark = guard.mark();
  await candidate.click({ timeout: 10_000 }).catch((e) => {
    throw new Stop("BROWSER_ERROR", `clicking the step control failed: ${(e as Error).message}`);
  });
  await frame.waitForTimeout(1200);

  // Did anything the guards watch fire?
  if (await guard.sawSubmissionAttemptSince(frame, mark)) {
    const report = await guard.report(frame);
    throw new Stop("SUBMISSION_ATTEMPT_BLOCKED",
      "a control that looked like a step advance tried to submit; it was blocked", report);
  }

  // Did we land on something terminal?
  const body = (await frame.textContent("body").catch(() => "")) ?? "";
  if (TERMINAL_PAGE.some((r) => r.test(body))) {
    throw new Stop("SUBMISSION_ATTEMPT_BLOCKED",
      "the page after that click reads as a confirmation, so the click was not a step advance",
      { url: frame.url(), before });
  }
}
