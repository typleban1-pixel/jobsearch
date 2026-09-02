/**
 * Filling a Lever application.
 *
 * Same contract as the Greenhouse filler and the same terminal state:
 * HANDOFF means the form is filled and the submit control was not
 * touched. Nothing here submits, and there is no flag that makes it.
 *
 * Order is the design, and it comes from what Lever actually does:
 *
 *   1. stabilize   choose the office, because surveys depend on it
 *   2. snapshot    read the form that choice produced
 *   3. drift       compare against what was approved, and stop if it moved
 *   4. upload      the approved artifact, FIRST, because Lever parses the
 *                  PDF and writes name/email/phone/org from it
 *   5. reconcile   read back what the parser wrote and decide, per field,
 *                  whether the employer's inference or our prepared
 *                  answer stands
 *   6. fill        by field kind, with groups understood as groups
 *   7. rescan      because answering can reveal more questions
 *   8. readback    prove every value committed
 *
 * Steps 4 and 5 cannot be reordered. Filling before uploading means the
 * parser silently overwrites answers that were reviewed and approved,
 * and the applicant would never know which values were actually sent.
 */
import type { Page } from "playwright";
import { Stop } from "./stopReasons.ts";
import { HANDOFF, type FillOutcomeName } from "./stopReasons.ts";
import { snapshotLeverForm, stabilizeLeverForm, leverSnapshotShape, type LeverField, type LeverSnapshot } from "./providers/lever.ts";
import { exactGeoMatches, geoSearchTerm } from "./geography.ts";

export interface LeverAnswer {
  fieldKey: string;
  fieldLabel: string;
  answer: string | null;
  isRequired: boolean;
  confidence: string;
}

export interface LeverFillOutcome {
  reason: FillOutcomeName;
  message: string;
  filled: Array<{ field: string; value: string }>;
  leftBlank: Array<{ field: string; why: string }>;
  parserReconciliation: Array<{ field: string; parsed: string; prepared: string | null; action: string }>;
  handoffs: Array<{ field: string; why: string }>;
  snapshotHashAtFill: string;
  office: string | null;
}

/** Fields Lever's resume parser is known to write into. */
const PARSER_WRITES = new Set(["name", "email", "phone", "org"]);

const stop = (reason: FillOutcomeName, message: string): never => { throw new Stop(reason as any, message); };

export async function fillLeverApplication(input: {
  page: Page;
  answers: LeverAnswer[];
  /** The approved artifact on disk. Never re-rendered here. */
  resumePath: string;
  /** The snapshot shape approval was bound to. */
  approvedShape: string;
  /** The reviewed location, in structured form, e.g. "Cleveland, OH, US". */
  reviewedLocation: string | null;
  preferOffice?: string;
}): Promise<LeverFillOutcome> {
  const { page, answers, resumePath, approvedShape } = input;
  const filled: LeverFillOutcome["filled"] = [];
  const leftBlank: LeverFillOutcome["leftBlank"] = [];
  const handoffs: LeverFillOutcome["handoffs"] = [];
  const parserReconciliation: LeverFillOutcome["parserReconciliation"] = [];

  // 1 + 2. Deterministic setup, then read what it produced.
  const setup = await stabilizeLeverForm(page, { preferLocation: input.preferOffice });
  if (!setup.chose && /a person must choose/.test(setup.reason)) {
    stop("AMBIGUOUS_NAVIGATION", `office selection is ambiguous: ${setup.reason}`);
  }
  const live = await snapshotLeverForm(page);
  const shapeAtFill = leverSnapshotShape(live);

  // 3. Drift. A required question that was not approved must never be
  //    answered opportunistically, and a form that moved is not the form
  //    the applicant read.
  if (approvedShape && shapeAtFill !== approvedShape) {
    const approved = new Set<string>(JSON.parse(approvedShape).map((r: any[]) => String(r[0])));
    const now = new Set(live.fields.map((f) => f.key));
    const appeared = live.fields.filter((f) => !approved.has(f.key) && f.required);
    const vanished = [...approved].filter((k) => !now.has(k));
    if (appeared.length) {
      stop("FORM_CHANGED",
        `${appeared.length} required question(s) appeared that were not in the approved snapshot: `
        + appeared.map((f) => `"${f.label.slice(0, 50)}"`).join(", "));
    }
    // A field that disappeared is legitimate conditional behaviour, not
    // corruption: answering a question can remove a follow-up. Recorded
    // rather than treated as a stop.
    for (const key of vanished) leftBlank.push({ field: key, why: "no longer rendered; a conditional question that does not apply" });
  }

  if (live.captchaChallengeVisible) stop("CAPTCHA", "a CAPTCHA challenge is displayed");

  // 4. Upload FIRST. Lever reads the PDF and fills fields from it.
  const fileField = live.fields.find((f) => f.kind === "file");
  if (!fileField) stop("NO_FORM_FOUND", "the form has no resume control");
  const beforeUpload = await readValues(page, live.fields);
  await page.locator(`input[name="${cssEscape(fileField!.key)}"]`).setInputFiles(resumePath);
  await page.waitForTimeout(3500);

  // 5. Reconcile what the parser wrote.
  const afterUpload = await readValues(page, live.fields);
  for (const f of live.fields) {
    if (!PARSER_WRITES.has(f.key)) continue;
    const before = beforeUpload[f.key] ?? "";
    const after = afterUpload[f.key] ?? "";
    if (after === before) continue;
    const prepared = answers.find((a) => a.fieldKey === f.key)?.answer ?? null;
    if (prepared === null) {
      // Nothing was prepared, so the employer's own inference stands and
      // is recorded as theirs rather than silently adopted as ours.
      parserReconciliation.push({ field: f.key, parsed: after, prepared: null, action: "KEPT_PARSER_VALUE" });
      continue;
    }
    if (norm(after) === norm(prepared)) {
      parserReconciliation.push({ field: f.key, parsed: after, prepared, action: "AGREES" });
      continue;
    }
    // The reviewed answer wins, and the disagreement is recorded. A
    // parser that overwrites a reviewed answer is exactly the case the
    // applicant needs to be able to audit afterwards.
    parserReconciliation.push({ field: f.key, parsed: after, prepared, action: "OVERWRITTEN_BY_PREPARED" });
  }

  // 6 + 7. Fill, then rescan, because answering reveals questions.
  const done = new Set<string>();
  for (let pass = 1; pass <= 4; pass++) {
    const current = pass === 1 ? live : await snapshotLeverForm(page);
    let acted = false;

    for (const f of current.fields) {
      if (done.has(f.key) || f.kind === "file") continue;

      if (f.kind === "signature") {
        done.add(f.key);
        handoffs.push({ field: f.key, why: "a signature or attestation; only you may make it" });
        continue;
      }

      const answer = answers.find((a) => a.fieldKey === f.key);
      if (!answer || answer.answer === null) {
        if (f.required && f.kind !== "location") {
          done.add(f.key);
          handoffs.push({ field: f.key, why: `required and unanswered: "${f.label.slice(0, 60)}"` });
        }
        continue;
      }
      if (answer.confidence === "BLOCKED") {
        done.add(f.key);
        handoffs.push({ field: f.key, why: "the prepared answer is BLOCKED" });
        continue;
      }

      const ok = await fillOne(page, f, answer.answer, input.reviewedLocation);
      done.add(f.key);
      acted = true;
      if (ok.ok) filled.push({ field: f.key, value: ok.committed });
      else handoffs.push({ field: f.key, why: ok.why });
    }
    if (!acted && pass > 1) break;
    await page.waitForTimeout(1200);
  }

  // 8. Readback. Nothing is trusted because it was typed.
  const finalValues = await readValues(page, (await snapshotLeverForm(page)).fields);
  for (const f of filled) {
    const held = finalValues[f.field] ?? "";
    if (norm(held) !== norm(f.value)) {
      stop("READBACK_MISMATCH",
        `"${f.field}" holds ${JSON.stringify(held.slice(0, 40))} but ${JSON.stringify(f.value.slice(0, 40))} was entered`);
    }
  }

  if (handoffs.length) {
    return {
      reason: "REQUIRED_FIELD_BLOCKED", office: setup.chose, snapshotHashAtFill: shapeAtFill,
      message: `${handoffs.length} field(s) need you: ${handoffs.slice(0, 3).map((h) => h.why).join("; ")}`,
      filled, leftBlank, parserReconciliation, handoffs,
    };
  }
  return {
    reason: HANDOFF, office: setup.chose, snapshotHashAtFill: shapeAtFill,
    message: "the form is filled and waiting for you; the submit control was not touched",
    filled, leftBlank, parserReconciliation, handoffs,
  };
}

/**
 * The application's submit control, scoped to the form.
 *
 * Lever pages carry cookie-consent Deny/Accept buttons outside the form,
 * and resolving "the button that looks like submit" across the page finds
 * them. Nothing outside the form element is a candidate.
 */
export async function leverSubmitControl(page: Page) {
  // Scoped to the form, and then chosen by what it SAYS.
  //
  // Two traps, both observed live. Lever pages carry cookie Deny/Accept
  // buttons outside the form, so nothing outside it is a candidate. And
  // Spotify's form holds two buttons: an empty `type=submit` and the real
  // `type=button` labelled "Submit application". Selecting on type alone
  // resolved to exactly one control and it was the wrong one, which is
  // the worst possible outcome: unambiguous and incorrect.
  const candidates = await page.locator("form button, form input[type=submit]").evaluateAll((els) =>
    els.map((el, index) => {
      const r = el.getBoundingClientRect();
      const text = ((el.textContent ?? "") + " " + (el.getAttribute("value") ?? "")).replace(/\s+/g, " ").trim();
      return {
        index, text,
        type: el.getAttribute("type") ?? "",
        visible: r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden",
        disabled: (el as HTMLButtonElement).disabled === true,
      };
    }));

  const usable = candidates.filter((c) => c.visible && !c.disabled);
  const named = usable.filter((c) => /submit application|submit your application/i.test(c.text));
  const chosen = named.length === 1
    ? named[0]
    : usable.filter((c) => c.type === "submit" && c.text.length > 0).length === 1
      ? usable.filter((c) => c.type === "submit" && c.text.length > 0)[0]
      : null;

  if (!chosen) {
    stop("SELECTOR_AMBIGUOUS",
      `the application submit control could not be identified uniquely inside the form; `
      + `candidates: ${JSON.stringify(usable.map((c) => ({ type: c.type, text: c.text.slice(0, 30) })))}`);
  }
  return page.locator("form button, form input[type=submit]").nth(chosen!.index);
}

// ---- helpers -----------------------------------------------------------

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const cssEscape = (s: string) => s.replace(/["\\]/g, "\\$&");

async function readValues(page: Page, fields: LeverField[]): Promise<Record<string, string>> {
  return page.evaluate((keys) => {
    const out: Record<string, string> = {};
    for (const k of keys) {
      const els = [...document.querySelectorAll(`[name="${k.replace(/["\\]/g, "\\$&")}"]`)];
      if (!els.length) continue;
      const first = els[0] as HTMLInputElement;
      if (first.type === "checkbox" || first.type === "radio") {
        out[k] = els.filter((e) => (e as HTMLInputElement).checked)
          .map((e) => {
            const id = e.getAttribute("id");
            const l = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : e.nextElementSibling;
            return (l?.textContent ?? "").replace(/\s+/g, " ").trim();
          }).join(", ");
      } else if (first.tagName === "SELECT") {
        const sel = first as unknown as HTMLSelectElement;
        out[k] = (sel.selectedOptions[0]?.textContent ?? "").replace(/\s+/g, " ").trim();
      } else {
        out[k] = first.value ?? "";
      }
    }
    return out;
  }, fields.map((f) => f.key));
}

async function fillOne(page: Page, f: LeverField, value: string, reviewedLocation: string | null): Promise<
  { ok: true; committed: string } | { ok: false; why: string }
> {
  const sel = `[name="${cssEscape(f.key)}"]`;

  if (f.kind === "location") {
    // Typed text is not an answer. Lever commits the choice to a hidden
    // input, and a location left uncommitted fails validation while
    // looking filled.
    const structured = reviewedLocation ?? value;
    const term = geoSearchTerm(structured);
    await page.locator(sel).click();
    await page.locator(sel).fill(term);
    await page.waitForTimeout(1800);
    const options = await page.locator(".dropdown-location .dropdown-item, [class*='dropdown'] li")
      .allInnerTexts().catch(() => [] as string[]);
    const hits = exactGeoMatches(options.map((o) => o.trim()).filter(Boolean), structured);
    if (hits.length !== 1) {
      return { ok: false, why: `location "${structured}" matched ${hits.length} of ${options.length} offered places exactly` };
    }
    await page.locator("[class*='dropdown'] li, .dropdown-location .dropdown-item")
      .filter({ hasText: new RegExp(`^${hits[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).first().click();
    await page.waitForTimeout(600);
    const committed = await page.locator("input[name='selectedLocation']").inputValue().catch(() => "");
    if (!committed.trim()) return { ok: false, why: "the location did not commit to selectedLocation" };
    return { ok: true, committed: hits[0]! };
  }

  if (f.kind === "checkbox_group" || f.kind === "radio_group") {
    // Exact option match only. "Yes" and "Yes, I consent" are different
    // answers and nearest-match between them is a fabricated statement.
    const wanted = f.kind === "checkbox_group" ? value.split(/\s*,\s*/) : [value];
    const chosen: string[] = [];
    for (const w of wanted) {
      const idx = f.options.findIndex((o) => norm(o) === norm(w));
      if (idx === -1) {
        return { ok: false, why: `"${w}" is not offered; the choices are ${f.options.slice(0, 6).join(" / ")}` };
      }
      await page.locator(sel).nth(idx).check();
      chosen.push(f.options[idx]!);
    }
    return { ok: true, committed: chosen.join(", ") };
  }

  if (f.kind === "select") {
    const idx = f.options.findIndex((o) => norm(o) === norm(value));
    if (idx === -1) return { ok: false, why: `"${value}" is not among the ${f.options.length} options offered` };
    await page.locator(sel).selectOption({ label: f.options[idx]! });
    return { ok: true, committed: f.options[idx]! };
  }

  await page.locator(sel).fill(value);
  return { ok: true, committed: value };
}
