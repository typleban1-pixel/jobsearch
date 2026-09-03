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
 * No, when the main pass already filled it (its label is in the filled
 * set) or when its committed value or typed value is non-empty. A
 * react-select control that has committed clears its search input and
 * moves the value into a chip, so the input alone reads empty and would
 * wrongly re-queue a field that is done -- which is what stopped a real
 * Samsara submission one field short, after the resume was uploaded.
 * The main pass verified read-back for what it filled, so its identity
 * by label is authoritative across the react-select rerender.
 */
export function shouldReattempt(
  label: string, filledLabels: Set<string>, held: string | null, typed: string | null,
  labelUniqueInSnapshot: boolean = true,
): boolean {
  // A committed value, wherever it lives, means the field is done.
  if ((held ?? "").trim() || (typed ?? "").trim()) return false;
  // The label match only settles it when this label is the SOLE bearer
  // in the current snapshot -- the rerendered react-select. If two
  // fields now carry the same label, one is genuinely new, and skipping
  // by label would suppress a field that still needs filling. In that
  // case each is judged on its own committed state above, and a field
  // that reads empty is attempted. Greenhouse questions are distinct in
  // practice, so this only ever fires for the react-select rerender, but
  // it keeps dynamic field discovery intact by construction.
  if (filledLabels.has(label) && labelUniqueInSnapshot) return false;
  return true;
}
