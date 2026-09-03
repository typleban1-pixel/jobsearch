/**
 * Writing a text value and proving it arrived.
 *
 * Six Work Experience locations reached Review missing their first
 * letter -- "leveland, OH", "ighland Heights, OH" -- and a school name
 * was reduced to "We". None of it came from the write: each one passed
 * read-back when it was written.
 *
 * It came from a LATER "clear" aimed at a different control. Control+A
 * does not select all on macOS, it moves the caret to the start of the
 * line, so Control+A followed by Delete removes the first character of
 * whatever input happens to hold focus. When a click on a search box
 * missed, that pair landed on the field written moments earlier and ate
 * its first letter, silently, after it had been verified.
 *
 * So a value is never "cleared" with keystrokes, and a field is not
 * finished until the DOM says it holds exactly the intended string.
 */

export type TextFillOutcome = {
  ok: boolean;
  intended: string;
  read: string;
  attempts: number;
  why?: string;
};

/** True when what is there is the intended value with its head bitten off. */
export function firstCharacterLost(intended: string, actual: string): boolean {
  const i = String(intended ?? ""), a = String(actual ?? "");
  return i.length > 1 && a === i.slice(1);
}

/** A short account of how the two differ, for a person reading a log. */
export function describeMismatch(intended: string, actual: string): string {
  if (firstCharacterLost(intended, actual)) {
    return `the first character was lost: expected ${JSON.stringify(intended)}, found ${JSON.stringify(actual)}`;
  }
  if (String(actual ?? "") === "") return `the field is empty; expected ${JSON.stringify(intended)}`;
  if (String(intended ?? "").startsWith(String(actual ?? ""))) {
    return `the value is truncated: expected ${JSON.stringify(intended)}, found ${JSON.stringify(actual)}`;
  }
  return `expected ${JSON.stringify(intended)}, found ${JSON.stringify(actual)}`;
}

/**
 * Focus, clear, verify empty, write, fire the events a framework needs,
 * blur, read back, and require exact equality. Retries once by typing,
 * because a control that ignores a programmatic value usually accepts
 * keystrokes; never a third time, because by then something is wrong
 * that a retry will not fix.
 */
export async function fillTextExact(page: any, locator: any, intended: string): Promise<TextFillOutcome> {
  const value = String(intended ?? "");
  let read = "", attempts = 0;

  for (const mode of ["fill", "type"] as const) {
    attempts++;
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.click({ timeout: 8000 }).catch(() => undefined);

    // Cleared through the element itself. Never a keyboard shortcut:
    // that is what removed the first character of other fields.
    await locator.fill("").catch(() => undefined);
    const empty = String(await locator.inputValue().catch(() => ""));
    if (empty !== "") {
      read = empty;
      continue;                       // it would not clear; try the other mode
    }

    if (mode === "fill") await locator.fill(value).catch(() => undefined);
    else await locator.type(value, { delay: 25 }).catch(() => undefined);

    // Frameworks listen for these; fill() alone can leave the model stale.
    await locator.evaluate((el: any) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.blur();
    }).catch(() => undefined);
    await page.waitForTimeout(250);

    read = String(await locator.inputValue().catch(() => ""));
    if (read === value) return { ok: true, intended: value, read, attempts };
  }

  return { ok: false, intended: value, read, attempts, why: describeMismatch(value, read) };
}
