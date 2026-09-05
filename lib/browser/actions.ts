/**
 * The closed action allow-list.
 *
 * Everything the filler can do to a page is here, and the answer-filling
 * layer deliberately has NO click primitive: option selection is scoped
 * to descendants of an already-resolved control, so it cannot reach a
 * form button however wrong the selector was.
 *
 * Exactly one function in this codebase clicks a page-level control, and
 * it is `advanceStep` in navigation.ts, which is subject to its own
 * evidence requirements. Adding a seventh entry to ACTION_ALLOW_LIST is
 * a failing test, not a code review someone might skim.
 */
import type { Frame, Locator } from "playwright";
import { Stop } from "./stopReasons.ts";

export const ACTION_ALLOW_LIST = [
  "fillText",
  "selectOption",
  "setChecked",
  "setFiles",
  "readBack",
  "advanceStep",
  // Read-only. Opens one already-resolved combobox to see what it
  // offers and closes it again; it never chooses an option, never
  // navigates, and cannot address anything the caller did not already
  // resolve. Named here because it does touch the page, and an action
  // the allow-list omits is an action nobody reviewed.
  "inspectOptions",
] as const;

export type ActionName = (typeof ACTION_ALLOW_LIST)[number];

/** Resolves to exactly one control, or stops. Never "the first match". */
export async function exactlyOne(_frame: Frame, locator: Locator, label: string): Promise<Locator> {
  const n = await locator.count();
  if (n === 1) return locator.first();
  throw new Stop("SELECTOR_AMBIGUOUS",
    `"${label}" matched ${n} controls; a value is never typed into a guess`, { label, matches: n });
}

export async function fillText(control: Locator, value: string): Promise<void> {
  await control.fill(value);
}

/**
 * Fill a controlled input so a React framework actually registers it.
 *
 * A bulk value-set (`.fill()`) sets the DOM value and dispatches one input
 * event, which Greenhouse's inputs accept but Ashby's do not: its form
 * state stays empty, the DOM shows the text, and submit-time validation
 * reports the field missing. Real keystrokes (`pressSequentially`) fire a
 * keydown/input per character that the framework's onChange reliably
 * catches, and an explicit change+blur commits and validates it. Slower, so
 * it is used only where the plain fill is known to be ignored.
 */
export async function fillTextCommitting(control: Locator, value: string): Promise<void> {
  await control.scrollIntoViewIfNeeded().catch(() => undefined);
  await control.click({ timeout: 8000 }).catch(() => undefined);
  await control.fill("").catch(() => undefined);            // clear (fires input)
  await control.pressSequentially(value, { delay: 12 });    // per-character input events
  await control.evaluate((el: any) => {
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    if (typeof el.blur === "function") el.blur();
  }).catch(() => undefined);
}

/**
 * Proof the framework accepted the value, not just that the DOM shows it.
 *
 * After a reconcile pause: the value must still be present (a re-render
 * driven by real state would keep it; a stale DOM-only value is reset), and
 * the control must not be left flagged invalid. This is the
 * APPLICATION_STATE_COMMITTED check, stricter than DOM_VALUE_PRESENT.
 */
export async function verifyCommitted(control: Locator, value: string): Promise<{ ok: boolean; why?: string }> {
  await control.page().waitForTimeout(300);
  const got = (await control.inputValue().catch(() => "")).trim();
  if (got !== value.trim()) {
    return { ok: false, why: `holds ${JSON.stringify(got.slice(0, 60))} after reconcile, so the framework did not accept ${JSON.stringify(value.slice(0, 60))}` };
  }
  const invalid = await control.getAttribute("aria-invalid").catch(() => null);
  if (invalid === "true") return { ok: false, why: "is still flagged aria-invalid after filling, so the framework did not accept it" };
  return { ok: true };
}

export async function readBack(control: Locator): Promise<string> {
  return control.inputValue();
}

export async function selectOption(control: Locator, optionText: string): Promise<void> {
  await control.selectOption({ label: optionText });
}

export async function setChecked(control: Locator, checked: boolean): Promise<void> {
  await control.setChecked(checked);
}

export async function setFiles(control: Locator, paths: string[]): Promise<void> {
  await control.setInputFiles(paths);
}

/**
 * Clicking an option INSIDE a resolved control.
 *
 * The only click available to the filling layer, and it is scoped to
 * descendants of a control that was already resolved by label. It cannot
 * address a page-level button because it never leaves that subtree.
 */
export async function clickOptionWithin(control: Locator, optionText: string): Promise<void> {
  const option = control.locator(`text="${optionText}"`);
  if (await option.count() !== 1) {
    throw new Stop("SELECTOR_AMBIGUOUS",
      `option "${optionText}" did not resolve to exactly one element inside its control`);
  }
  await option.first().click();
}

/**
 * Should the rescan re-attempt this field?
 *
 * No, when the main pass already processed a field with this label, or
 * when this field already holds a committed or typed value. The rescan
 * exists only to catch fields that did not exist during the main pass --
 * dynamically revealed after answering something -- and those carry a
 * label the main pass never saw. A label the main pass DID process is
 * the same question rerendered: react-select commits its value into a
 * chip and clears its input, and re-attempting it resolves a stale
 * selector to zero and stops the submission one field short. Matching on
 * the question text, which survives the rerender, is the point.
 */
export function shouldReattempt(
  label: string, processedLabels: Set<string>, held: string | null, typed: string | null,
): boolean {
  if ((held ?? "").trim() || (typed ?? "").trim()) return false;
  if (processedLabels.has(label)) return false;
  return true;
}
