/**
 * Reading the options of a control that renders them lazily.
 *
 * Greenhouse's calling-country selector is a react-select combobox: it
 * has no `<option>` elements until it is opened, so a snapshot sees a
 * text input labelled only "Country" and cannot tell a dial-code
 * selector from a residence field. That ambiguity is the difference
 * between recording the right phone number and the wrong one.
 *
 * This opens ONE already-resolved combobox, reads what it offers, and
 * closes it again. It is an inspection, and the constraints are what
 * make it one:
 *
 *   - it never chooses an option, so nothing is entered by inspecting;
 *   - it never navigates, and any navigation is a stop;
 *   - it is not exported to the filling layer as a click primitive: it
 *     takes a Locator that has already been resolved to exactly one
 *     control, and can address nothing else;
 *   - the DOM is re-read afterwards, and any structural change beyond a
 *     listbox appearing and disappearing is a stop.
 *
 * The submission guards remain in force throughout. If opening a
 * combobox somehow submits a form, layer 2 cancels it and this stops.
 */
import type { Frame, Locator, Page } from "playwright";
import { Stop } from "./stopReasons.ts";
import { SubmitGuard } from "./submitGuard.ts";

export const COMBOBOX_INSPECTION_VERSION = 1;

/** What the page looked like before we touched it. */
async function fingerprint(frame: Frame): Promise<string> {
  return frame.evaluate(() => {
    const controls = Array.from(document.querySelectorAll("input,select,textarea"))
      .filter((e) => (e.getAttribute("type") ?? "") !== "hidden")
      .map((e) => `${e.tagName}:${(e as HTMLInputElement).name || e.id || ""}`)
      .sort()
      .join("|");
    return `${location.href}##${controls}`;
  });
}

export interface InspectionResult {
  options: string[];
  /** True when the control never opened, as opposed to opening empty. */
  neverOpened: boolean;
}

/**
 * Opens one combobox, reads its options, and closes it.
 *
 * `control` must already be resolved to exactly one element by the
 * caller. Nothing here searches the page for something to click.
 */
export async function readLazyOptions(
  page: Page,
  frame: Frame,
  guard: SubmitGuard,
  control: Locator,
  label: string,
): Promise<InspectionResult> {
  const isCombobox = await control.evaluate((el: Element) =>
    el.getAttribute("role") === "combobox"
    || el.getAttribute("aria-haspopup") === "listbox"
    || el.getAttribute("aria-autocomplete") === "list");
  if (!isCombobox) return { options: [], neverOpened: true };

  const before = await fingerprint(frame);
  const mark = guard.mark();

  await control.click({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(500);

  // Options live either in the listbox this control owns, or in the
  // nearest rendered listbox. Both are read; neither is selected.
  const options = await frame.evaluate((sel: string) => {
    const el = document.querySelector(sel) ?? document.activeElement;
    const owned = el?.getAttribute("aria-controls") ?? el?.getAttribute("aria-owns");
    // Scoped to THIS control. Falling back to the first listbox on the
    // page returned the phone dial-code list when the school picker was
    // open, which would have fitted an answer against another control's
    // choices entirely.
    const box = (owned && document.getElementById(owned))
      || el?.closest("div,fieldset")?.querySelector("[role='listbox'], [class*='menu' i][class*='select' i], .select__menu")
      || null;
    if (!box) return [];
    // react-select renders its empty and loading states as notices whose
    // class contains "option" -- select__menu-notice--no-options. Reading
    // those as choices produced an option literally named "No options",
    // which then failed to match anything and reported the control as
    // offering it.
    return Array.from(box.querySelectorAll("[role='option'], [class*='option' i]"))
      .filter((o) => !/menu-notice/i.test(o.className || ""))
      .map((o) => (o.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((t) => t && !/^(no options|loading\.{0,3})$/i.test(t))
      .slice(0, 400);
  }, await control.evaluate((el: Element) => (el.id ? `#${CSS.escape(el.id)}` : "*:focus")));

  // Close it without choosing anything. Escape, then blur as a fallback.
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(250);
  await control.evaluate((el: Element) => (el as HTMLElement).blur?.()).catch(() => undefined);
  await page.waitForTimeout(250);

  if (await guard.sawSubmissionAttemptSince(frame, mark)) {
    throw new Stop("SUBMISSION_ATTEMPT_BLOCKED",
      `inspecting "${label}" triggered a submission attempt, which was blocked`);
  }

  const after = await fingerprint(frame);
  if (after !== before) {
    throw new Stop("FORM_CHANGED",
      `inspecting "${label}" changed the form; inspection must leave the page as it found it`,
      { before: before.slice(0, 120), after: after.slice(0, 120) });
  }

  // Nothing may have been entered by looking.
  const value = await control.inputValue().catch(() => "");
  if (value.trim() !== "") {
    throw new Stop("READBACK_MISMATCH",
      `inspecting "${label}" left a value in it (${JSON.stringify(value.slice(0, 40))}); inspection never chooses an option`);
  }

  return { options: [...new Set(options)], neverOpened: options.length === 0 };
}

/** Options equal to the answer, compared on trimmed case-folded text. */
export function exactOptions(options: string[], answer: string): string[] {
  const want = answer.replace(/\s+/g, " ").trim().toLowerCase();
  return options.filter((o) => o.replace(/\s+/g, " ").trim().toLowerCase() === want);
}

/**
 * Reading what an async combobox offers FOR a particular answer.
 *
 * Some Greenhouse controls are type-aheads rather than closed lists.
 * Its school picker renders the first hundred institutions
 * alphabetically -- Aalborg, Aalto, Aarhus -- and loads anything else
 * only once you type. Reading it unfiltered and concluding the answer is
 * not offered is wrong in the same way that reading the first page of a
 * dictionary and concluding a word does not exist is wrong.
 *
 * So the reviewed answer is typed in, purely as a search term, and what
 * comes back is read. The safety properties of the plain inspection are
 * unchanged and one is added: the typed text is removed afterwards, and
 * the control must be empty again before this returns. Typing to search
 * is not answering, and this still never chooses an option.
 */
export async function readFilteredOptions(
  page: Page, frame: Frame, guard: SubmitGuard,
  control: Locator, label: string, search: string,
): Promise<InspectionResult> {
  const isCombobox = await control.evaluate((el: Element) =>
    el.getAttribute("role") === "combobox"
    || el.getAttribute("aria-haspopup") === "listbox"
    || el.getAttribute("aria-autocomplete") === "list").catch(() => false);
  if (!isCombobox) return { options: [], neverOpened: true };

  const before = await fingerprint(frame);
  const mark = guard.mark();

  await control.click({ timeout: 5_000 }).catch(() => undefined);
  await control.fill(search, { timeout: 5_000 }).catch(() => undefined);

  // Async lists arrive after a request. Poll until the option set stops
  // changing rather than guessing a single delay.
  const readOnce = async (): Promise<string[]> => frame.evaluate((sel: string) => {
    const el = document.querySelector(sel) ?? document.activeElement;
    const owned = el?.getAttribute("aria-controls") ?? el?.getAttribute("aria-owns");
    // Scoped to THIS control. Falling back to the first listbox on the
    // page returned the phone dial-code list when the school picker was
    // open, which would have fitted an answer against another control's
    // choices entirely.
    const box = (owned && document.getElementById(owned))
      || el?.closest("div,fieldset")?.querySelector("[role='listbox'], [class*='menu' i][class*='select' i], .select__menu")
      || null;
    if (!box) return [];
    return Array.from(box.querySelectorAll("[role='option'], [class*='option' i]"))
      .filter((o) => !/menu-notice/i.test(o.className || ""))
      .map((o) => (o.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((t) => t && !/^(no options|loading\.{0,3})$/i.test(t))
      .slice(0, 400);
  }, await control.evaluate((el: Element) => (el.id ? `#${CSS.escape(el.id)}` : "*:focus")));

  let options: string[] = [];
  let previous = "";
  for (let attempt = 0; attempt < 30; attempt++) {
    await page.waitForTimeout(500);
    options = await readOnce();
    const signature = options.join(" ");
    if (options.length > 0 && signature === previous) break;
    previous = signature;
  }

  // Leave it exactly as it was found: no selection, no typed residue.
  await page.keyboard.press("Escape").catch(() => undefined);
  await control.fill("", { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(200);
  await control.evaluate((el: Element) => (el as HTMLElement).blur?.()).catch(() => undefined);
  await page.waitForTimeout(250);

  if (await guard.sawSubmissionAttemptSince(frame, mark)) {
    throw new Stop("SUBMISSION_ATTEMPT_BLOCKED",
      `searching "${label}" triggered a submission attempt, which was blocked`);
  }
  const after = await fingerprint(frame);
  if (after !== before) {
    throw new Stop("FORM_CHANGED",
      `searching "${label}" changed the form; inspection must leave the page as it found it`,
      { before: before.slice(0, 120), after: after.slice(0, 120) });
  }
  const residue = await control.inputValue().catch(() => "");
  if (residue.trim() !== "") {
    throw new Stop("READBACK_MISMATCH",
      `searching "${label}" left ${JSON.stringify(residue.slice(0, 40))} in it; a search term is not an answer`);
  }

  return { options: [...new Set(options)], neverOpened: options.length === 0 };
}
