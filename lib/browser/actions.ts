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
  // The React value-tracker trick. React caches the last value on the
  // element's _valueTracker; a bulk .fill() updates the tracker AND the
  // value together, so the input event React then hears looks like "no
  // change" and onChange never fires -- the DOM shows the text but the
  // form's state stays empty (Ashby's false HANDOFF). Resetting the
  // tracker to a stale value first makes the input event a real change,
  // firing onChange/react-hook-form's register and committing the value.
  await control.evaluate((el: any, v: string) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (el._valueTracker) el._valueTracker.setValue("");
    if (setter) setter.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }, value);
}

/** One reading of a controlled input's commit state: DOM value, the
 * framework's own props.value now and after a render tick, whether React
 * props exist at all, and the aria-invalid flag. */
export interface CommitReading {
  dom: string; react: string | undefined; afterReact: string | undefined;
  hasReact: boolean; invalid: string | null;
}

/**
 * The pure commit-contract verdict, given a reading and the intended value.
 * Encodes, in order: RERENDER_SURVIVED (framework state must still hold the
 * value on the next render), DOM_VALUE_PRESENT, hydration (React props must
 * exist -- no props means the value cannot be confirmed committed),
 * AUTHORITATIVE_STATE_UPDATED (framework state equals the value), then
 * validity. DOM_VALUE_PRESENT alone never passes. Kept pure so the ordering
 * is unit-tested without a browser.
 */
export function commitVerdict(r: CommitReading, value: string): { ok: boolean; why?: string } {
  const v = value.trim();
  if (r.hasReact && r.react !== undefined && String(r.afterReact).trim() !== v) {
    return { ok: false, why: `committed to the framework then reverted to ${JSON.stringify(String(r.afterReact).slice(0, 60))} on the next render, so it did not stick` };
  }
  if (String(r.dom).trim() !== v) {
    return { ok: false, why: `holds ${JSON.stringify(String(r.dom).slice(0, 60))} in the DOM after reconcile` };
  }
  if (!r.hasReact) {
    return { ok: false, why: "has no React props (the form is not hydrated), so the value cannot be confirmed as committed to the framework" };
  }
  if (r.react !== undefined && String(r.react).trim() !== v) {
    return { ok: false, why: `the framework's own state holds ${JSON.stringify(String(r.react).slice(0, 60))}, not the value written, so it was not committed` };
  }
  if (r.invalid === "true") return { ok: false, why: "is still flagged aria-invalid after filling" };
  return { ok: true };
}

/**
 * Proof the FRAMEWORK accepted the value, not just that the DOM shows it.
 *
 * The authoritative signal for a React controlled input is the value on its
 * React props (what the component was last rendered with) -- that is the
 * form's own state, updated only when onChange actually fired. It is read
 * twice, a render tick apart, so a value that commits and then reverts when
 * the form finishes mounting (Ashby's false HANDOFF) is caught. This is the
 * APPLICATION_STATE_COMMITTED + RERENDER_SURVIVED check, stricter than
 * DOM_VALUE_PRESENT. The verdict itself is delegated to the pure
 * commitVerdict above.
 */
export async function verifyCommitted(control: Locator, value: string): Promise<{ ok: boolean; why?: string }> {
  await control.page().waitForTimeout(200);
  const read = () => control.evaluate((el: any) => {
    const rk = Object.keys(el).find((k) => k.startsWith("__reactProps"));
    return { dom: el.value ?? "", react: rk ? el[rk]?.value : undefined, hasReact: !!rk,
             invalid: el.getAttribute("aria-invalid") };
  });
  const res = await read();
  await control.page().waitForTimeout(250);
  const after = await read();
  return commitVerdict({ dom: res.dom, react: res.react, afterReact: after.react,
                         hasReact: res.hasReact, invalid: res.invalid }, value);
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
