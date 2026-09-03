/**
 * Typing resolved answers into a Workday page, and proving they landed.
 *
 * Discovery and resolution produced answers in our database; nothing had
 * ever put them in the employer's form. Save and Continue then failed
 * validation on empty required inputs, which is how the gap surfaced.
 *
 * THE RULES THIS ENFORCES
 *
 * Only resolved answers are typed. A BLOCKED field is an unanswered
 * question, and clicking past it would leave the employer's form holding
 * a blank nobody mentioned.
 *
 * Every value is read back from the control after writing. A fill that
 * is not verified is a guess about what the page did, and React-backed
 * inputs routinely discard a programmatic write.
 *
 * Anything unrecognised stops the run. An unfamiliar control type, a
 * missing selector, a CAPTCHA, a page that navigated: none of these are
 * conditions to work around.
 */
import type { Page } from "playwright";

export interface FillTarget {
  /** The control's selector, as discovery recorded it. */
  selector: string;
  label: string;
  value: string;
  /** BLOCKED fields never reach here; carried for the report. */
  confidence: string;
  required: boolean;
}

export type FillOutcome =
  | { status: "FILLED"; readBack: string }
  | { status: "ALREADY"; readBack: string }
  | { status: "SKIPPED_BLANK" }
  | { status: "FAILED"; why: string };

export interface FillReport {
  target: FillTarget;
  outcome: FillOutcome;
}

/** Controls this knows how to write. Anything else stops the run. */
const KNOWN = new Set(["text", "email", "tel", "textarea", "checkbox", "radio", "select-one", "search"]);

/**
 * Selects one option of a radio group by its visible LABEL.
 *
 * The stored answer is the label a person chose -- "No" -- while the
 * DOM's value attribute is whatever the application uses internally.
 * Northern Trust's are "true" and "false", so a selector built from the
 * label matched nothing at all.
 *
 * The mapping is read from the live page rather than assumed, because
 * every tenant is free to choose its own encoding.
 */
export async function selectRadioByLabel(
  page: Page, groupName: string, label: string,
): Promise<FillOutcome> {
  const options = await page.evaluate((name: string) =>
    [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)]
      .filter((e) => e.getClientRects().length > 0)
      .map((e: any) => ({
        value: e.value,
        label: (e.closest("label")?.textContent
          || document.querySelector(`label[for="${e.id}"]`)?.textContent || "").trim(),
        checked: e.checked,
      })), groupName);

  if (!options.length) return { status: "FAILED", why: `no visible radio group named "${groupName}"` };
  const want = options.filter((o: any) => o.label.toLowerCase() === label.trim().toLowerCase());
  if (want.length === 0) {
    return { status: "FAILED",
      why: `no option labelled ${JSON.stringify(label)} in "${groupName}"; it offers `
        + JSON.stringify(options.map((o: any) => o.label)) };
  }
  if (want.length > 1) return { status: "FAILED", why: `${want.length} options labelled ${JSON.stringify(label)}` };

  const value = want[0]!.value;
  const sel = `input[type="radio"][name="${groupName}"][value="${value}"]`;
  const el = page.locator(sel).first();
  try { await el.check({ timeout: 10_000 }); }
  catch (e) { return { status: "FAILED", why: `could not select: ${String(e).split("\n")[0]!.slice(0, 110)}` }; }

  const checked = await el.isChecked().catch(() => false);
  if (!checked) return { status: "FAILED", why: `read-back: the option did not stay selected` };
  return { status: "FILLED", readBack: `${label} (value=${value})` };
}

/**
 * Fills one control and reads it back.
 *
 * The read-back is from the DOM, not from what we intended, so a value
 * the page rejected or transformed shows up as a mismatch rather than
 * being assumed to have worked.
 */
export async function fillOne(page: Page, t: FillTarget): Promise<FillOutcome> {
  const loc = page.locator(`${t.selector}:visible`);
  const n = await loc.count().catch(() => 0);
  if (n === 0) return { status: "FAILED", why: "no visible control matches this selector" };
  if (n > 1) return { status: "FAILED", why: `${n} visible controls match; refusing to choose` };

  const el = loc.first();
  const kind = await el.evaluate((e: any) => (e.type || e.tagName || "").toLowerCase()).catch(() => "");
  if (!KNOWN.has(kind)) return { status: "FAILED", why: `unfamiliar control type "${kind}"` };

  // A deliberate blank is an answer, and writing "" over an empty field
  // is a no-op, so it is recorded rather than performed.
  if (t.value === "") {
    const cur = String(await readValue(el, kind));
    return cur === "" ? { status: "SKIPPED_BLANK" }
      : { status: "FAILED", why: `the field should be blank but holds ${JSON.stringify(cur)}` };
  }

  const before = String(await readValue(el, kind));
  if (before === t.value) return { status: "ALREADY", readBack: before };

  try {
    if (kind === "checkbox" || kind === "radio") {
      const want = /^(yes|true)$/i.test(t.value);
      want ? await el.check({ timeout: 10_000 }) : await el.uncheck({ timeout: 10_000 });
    } else if (kind === "select-one") {
      await el.selectOption({ label: t.value }, { timeout: 10_000 });
    } else {
      await el.fill(t.value, { timeout: 10_000 });
    }
  } catch (e) {
    return { status: "FAILED", why: `write failed: ${String(e).split("\n")[0]!.slice(0, 110)}` };
  }

  const after = String(await readValue(el, kind));
  const expected = (kind === "checkbox" || kind === "radio")
    ? (/^(yes|true)$/i.test(t.value) ? "true" : "false") : t.value;
  if (after !== expected) {
    return { status: "FAILED", why: `read-back mismatch: wrote ${JSON.stringify(t.value)}, control holds ${JSON.stringify(after)}` };
  }
  return { status: "FILLED", readBack: after };
}

async function readValue(el: any, kind: string): Promise<string> {
  if (kind === "checkbox" || kind === "radio") {
    return String(await el.isChecked().catch(() => false));
  }
  return String(await el.inputValue().catch(() => ""));
}

/** True when every target either landed or was a correct deliberate blank. */
export const allVerified = (reports: FillReport[]): boolean =>
  reports.every((r) => r.outcome.status !== "FAILED");

export const failures = (reports: FillReport[]): FillReport[] =>
  reports.filter((r) => r.outcome.status === "FAILED");
