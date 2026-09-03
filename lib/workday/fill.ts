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
  // Yes/No radios sometimes carry no label element at all: Northern
  // Trust's previous-worker group labels the FIELDSET and leaves each
  // option bare, so matching on the visible label found nothing. The
  // value attribute still says which is which.
  const BOOLEAN_VALUE: Record<string, string> = { yes: "true", no: "false", true: "true", false: "false" };

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
  let want = options.filter((o: any) => o.label.toLowerCase() === label.trim().toLowerCase());
  if (want.length === 0 && options.every((o: any) => !o.label)) {
    // Nothing is labelled, so the value carries the meaning. Only the
    // boolean pair is resolved this way; anything else stays a failure,
    // because guessing which unlabelled option means what is the thing
    // this refuses to do.
    const v = BOOLEAN_VALUE[label.trim().toLowerCase()];
    if (v) want = options.filter((o: any) => String(o.value).toLowerCase() === v);
  }
  if (want.length === 0) {
    return { status: "FAILED",
      why: `no option labelled ${JSON.stringify(label)} in "${groupName}"; it offers `
        + JSON.stringify(options.map((o: any) => o.label || `(unlabelled, value=${o.value})`)) };
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

/**
 * Picks an option from a Workday dropdown that is not a <select>.
 *
 * Country, State/Province and "How Did You Hear About Us?" are all
 * rendered as a button that opens a listbox whose options do not exist
 * in the DOM until it is opened. fillOne cannot write to them -- there is
 * nothing to write to -- so it reported "unfamiliar control type
 * button" and the page could not be completed at all.
 *
 * The option is matched exactly, then by country name, and never by
 * containment: "Ireland" sits inside "Northern Ireland", and among US
 * states "Virginia" sits inside "West Virginia". More than one match is
 * an ambiguity to report rather than a tie to break.
 */
export async function selectListboxOption(
  page: Page, selector: string, wanted: string,
): Promise<FillOutcome> {
  const button = page.locator(`${selector}:visible`);
  const n = await button.count().catch(() => 0);
  if (n === 0) return { status: "FAILED", why: "no visible control matches this selector" };
  if (n > 1) return { status: "FAILED", why: `${n} visible controls match; refusing to choose` };

  // Two shapes wear the same hat. Country and State are BUTTONS that
  // open a listbox; "How Did You Hear About Us?" is an INPUT with
  // role=combobox that filters as you type. Typing into the second and
  // stopping there leaves the text in the box and nothing chosen, so the
  // control reads back correctly while Workday still calls it empty --
  // which is exactly what happened here.
  const isInput = await button.first().evaluate((el: any) => el.tagName === "INPUT").catch(() => false);
  const readCurrent = async () => isInput
    ? String(await button.first().inputValue().catch(() => "")).trim()
    : (await button.first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();

  const already = await readCurrent();
  if (already && already.toLowerCase() === wanted.trim().toLowerCase() && !isInput) {
    return { status: "ALREADY", readBack: already };
  }

  await button.first().click({ timeout: 10_000 }).catch(() => undefined);
  if (isInput) {
    // Filtering narrows a long list to the option we are looking for.
    await button.first().fill("").catch(() => undefined);
    await button.first().type(wanted.slice(0, 40), { delay: 25 }).catch(() => undefined);
    await page.waitForTimeout(900);
  }
  // The options are rendered into a popup after the click.
  const OPTIONS = '[role="option"], [data-automation-id="promptOption"], [data-automation-id*="promptOption"]';
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300);
    if (await page.locator(`${OPTIONS}:visible`).count().catch(() => 0)) break;
  }
  // Only the popup this control opened. Reading every visible option on
  // the page swept in the phone-code dropdown's entries, so the State
  // list arrived led by two copies of "United States of America (+1)".
  const owns = await button.first().getAttribute("aria-controls").catch(() => null)
    ?? await button.first().getAttribute("aria-owns").catch(() => null);
  const scope = owns ? `#${owns.replace(/[^A-Za-z0-9_-]/g, "\\$&")} ` : "";
  let labels = (await page.locator(`${scope}${OPTIONS}:visible`).allInnerTexts().catch(() => []))
    .map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!labels.length) {
    labels = (await page.locator(`${OPTIONS}:visible`).allInnerTexts().catch(() => []))
      .map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
  }
  if (!labels.length) return { status: "FAILED", why: "the dropdown opened no options" };

  const want = wanted.trim().toLowerCase();
  let hits = labels.filter((l) => l.toLowerCase() === want);

  /**
   * The same choice, worded the tenant's way.
   *
   * Workday qualifies EEO options by country -- "White (United States of
   * America)" -- and renders a two-way question as Yes/No while the
   * stored answer is spelled out, so "Not Hispanic or Latino" met a
   * control offering only "Yes" and "No". Both are the same answer
   * written differently, and neither is a different answer.
   */
  const unqualify = (l: string) => l.replace(/\s*\((?:[^()]*)\)\s*$/, "").trim().toLowerCase();
  if (!hits.length) {
    hits = labels.filter((l) => unqualify(l) === want);
  }
  if (!hits.length) {
    const yesNo = labels.filter((l) => /^(yes|no)$/i.test(l.trim()));
    // Only where the control genuinely offers just Yes and No.
    if (yesNo.length === 2) {
      const negative = /^(not\b|no\b|i am not\b|i do not\b|i don't\b|decline)/i.test(wanted.trim());
      const positive = /^(yes\b|i am\b|i do\b)/i.test(wanted.trim());
      if (negative) hits = labels.filter((l) => /^no$/i.test(l.trim()));
      else if (positive) hits = labels.filter((l) => /^yes$/i.test(l.trim()));
    }
  }
  if (!hits.length) {
    const { normalizeCountryName, normalizeRegionName } = await import("../browser/geography.ts");
    const wc = normalizeCountryName(wanted);
    hits = labels.filter((l) => normalizeCountryName(l) === wc);
    if (!hits.length) {
      const wr = normalizeRegionName(wanted);
      hits = labels.filter((l) => normalizeRegionName(l) === wr);
    }
  }
  if (hits.length !== 1) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return { status: "FAILED",
      why: hits.length > 1
        ? `${hits.length} options equal ${JSON.stringify(wanted)}; which is meant cannot be decided here`
        : `no option equals ${JSON.stringify(wanted)}. Offered: ${labels.slice(0, 12).join(" | ")}${labels.length > 12 ? " ..." : ""}` };
  }

  await page.locator(`${OPTIONS}:visible`).filter({ hasText: new RegExp(`^\\s*${hits[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) })
    .first().click({ timeout: 10_000 })
    .catch(async () => { await page.getByRole("option", { name: hits[0]!, exact: true }).first().click({ timeout: 10_000 }).catch(() => undefined); });
  await page.waitForTimeout(600);

  // Committed, read from the control itself.
  const readBack = await readCurrent();
  if (readBack.toLowerCase() !== hits[0]!.toLowerCase()) {
    return { status: "FAILED", why: `selected ${JSON.stringify(hits[0])} but the control reads ${JSON.stringify(readBack)}` };
  }
  return { status: "FILLED", readBack };
}

/**
 * Walks a Workday prompt tree and commits the leaf.
 *
 * The commit is verified from the control's own selected-item list, not
 * from the search box: typing "Northern Trust Web Site" into the box and
 * reading it straight back looked like success while Workday still held
 * nothing at all.
 */
export async function selectPromptPath(
  page: Page, selector: string, answer: string,
): Promise<FillOutcome> {
  const { parseOptionPath, nextStep, formatOptionPath } = await import("./prompt.ts");
  const control = page.locator(`${selector}:visible`).first();
  if (!(await control.count().catch(() => 0))) return { status: "FAILED", why: "no visible control matches this selector" };

  const committed = async (): Promise<string[]> => await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    const box = el?.closest('[data-automation-id="multiSelectContainer"]') ?? el?.parentElement;
    return [...(box?.querySelectorAll('[data-automation-id="selectedItem"]') ?? [])]
      .map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim()).filter(Boolean);
  }, selector);

  const path = parseOptionPath(answer);
  const already = await committed();
  if (already.some((a) => a.toLowerCase() === (path[path.length - 1] ?? answer).trim().toLowerCase())) {
    return { status: "ALREADY", readBack: already.join(", ") };
  }

  await control.click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(1200);

  const readLevel = async () => await page.evaluate(() => {
    const c = document.querySelector('[data-automation-id="activeListContainer"]');
    if (!c) return [];
    return [...c.querySelectorAll('[data-automation-id="menuItem"]')]
      .filter((e) => e.getClientRects().length > 0)
      .map((e) => {
        const n = e.querySelector('[data-automation-id="promptLeafNode"], [data-automation-id="promptOption"]');
        return {
          label: (e as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
          instanceId: n?.getAttribute("data-uxi-multiselectlistitem-instanceid") ?? null,
          hasSideCharm: n?.getAttribute("data-uxi-multiselectlistitem-hassidecharm") === "true",
        };
      }).filter((o) => o.label);
  });

  const walked: string[] = [];
  let remaining = [...path];
  for (let depth = 0; depth < 5; depth++) {
    let options = await readLevel();
    for (let i = 0; !options.length && i < 8; i++) { await page.waitForTimeout(400); options = await readLevel(); }

    const step = nextStep(options as any, remaining);
    if (step.action === "STOP") {
      await page.keyboard.press("Escape").catch(() => undefined);
      return { status: "FAILED",
        why: `${step.why}${walked.length ? ` (after ${formatOptionPath(walked)})` : ""}. `
          + `This level offers: ${step.offered.join(" | ")}` };
    }

    const item = page.locator(`[data-automation-id="activeListContainer"] [data-automation-id="menuItem"]`)
      .filter({ hasText: new RegExp(`^\\s*${step.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) }).first();
    await item.click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
    walked.push(step.label);
    if (remaining[0]?.toLowerCase() === step.label.toLowerCase()) remaining = remaining.slice(1);

    // Checked after EVERY click, not only where a selection was
    // predicted. Workday's own markup called the second-level entry a
    // category, yet clicking it committed the value -- so the outcome,
    // read from the control, is the authority rather than the
    // classification. Reading only on a predicted SELECT reported a
    // failure for a field that was correctly filled.
    const now = await committed();
    const target = (walked[walked.length - 1] ?? "").toLowerCase();
    if (now.some((c) => c.toLowerCase() === target)) {
      await page.keyboard.press("Escape").catch(() => undefined);
      return { status: "FILLED", readBack: `${formatOptionPath(walked)} (committed: ${now.join(", ")})` };
    }
    if (step.action === "SELECT") {
      return { status: "FAILED",
        why: `selected ${JSON.stringify(step.label)} but the control holds ${JSON.stringify(now.join(", "))}` };
    }
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  return { status: "FAILED", why: `the prompt did not reach a selectable option within 5 levels (walked ${formatOptionPath(walked)})` };
}
