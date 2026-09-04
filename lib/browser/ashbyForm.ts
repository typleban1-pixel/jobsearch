/**
 * Shared Ashby form normalization: reading the choice fieldsets, grouping
 * them into one question each, dropping the resume-dropzone file phantom,
 * revealing the form, and the multi-step check.
 *
 * This is the SINGLE definition used by BOTH preparation (ashbyPrepare.ts,
 * which snapshots the form for review) and submission (fill.ts, which fills
 * it). They must agree field-for-field, because the fill path checks the
 * live form against the snapshot that was reviewed: if the two grouped the
 * same form differently, every Ashby fill would read as FORM_CHANGED. One
 * definition, imported in both places, is what makes divergence impossible.
 *
 * Ashby renders a choice question as a <fieldset> of radio or checkbox
 * controls, each named "{uuid}_{uuid}" (a question id and an option id).
 * Those names are regenerated per page load, so they are never a stable
 * key: the stable identity is the question TEXT and the option TEXT, and a
 * selector is derived live at the moment of use.
 *
 * Imports Playwright types only; the pure grouping is testable without a
 * browser.
 */
import type { FormField } from "../applications/answer.ts";
import type { LiveField, LiveSnapshot } from "./liveSnapshot.ts";
import { snapshotLive } from "./liveSnapshot.ts";

/**
 * A discovered live field, projected onto the system's form vocabulary.
 *
 * snapshotLive already collapses a multi-checkbox question into one
 * "checkbox-group" field carrying its options. FormField has no
 * "checkbox-group" member, so that one runtime type maps onto "select",
 * which is what every downstream reader treats an options list as.
 */
export function toFormField(f: LiveField): FormField {
  const type: FormField["type"] =
    (f.type as string) === "checkbox-group" ? "select" : (f.type as FormField["type"]);
  return {
    key: f.key,
    label: f.label,
    type,
    required: f.required,
    ...(f.options && f.options.length ? { options: f.options } : {}),
  };
}

/** Does this snapshot look like an application form rather than a landing page? */
export function looksLikeForm(snap: Pick<LiveSnapshot, "fields">): boolean {
  const labelled = snap.fields.filter((f) => (f.label || "").trim().length > 0);
  const hasFile = snap.fields.some((f) => (f.type as string) === "file");
  return hasFile || labelled.length >= 3;
}

export interface RawChoiceInput {
  name: string; label: string; kind: "radio" | "checkbox"; required: boolean;
  /**
   * A selector that reaches THIS option's control, derived live. Ashby
   * gives each option a unique name (qid_optid) regenerated per page load,
   * so this is deterministic within one session and never stored.
   */
  selector: string;
}
export interface RawFieldset { questionText: string | null; inputs: RawChoiceInput[] }
export interface ChoiceGrouping { groups: LiveField[]; memberKeys: Set<string> }

/** Two UUIDs joined by an underscore: Ashby's option-control name. */
const ASHBY_OPTION_NAME = /^[0-9a-f-]{36}_[0-9a-f-]{36}$/i;
const clean = (s: string) => (s || "").replace(/\s+/g, " ").replace(/\s*\*\s*$/, "").trim();

/**
 * Collapse each Ashby choice fieldset into ONE question with its offered
 * options. Narrow and fail-safe by construction:
 *
 *  - a fieldset counts only through its Ashby option controls (uuid_uuid);
 *    anything else in it is left untouched;
 *  - it groups only with two or more such options AND a recoverable
 *    question label -- no legend, or fewer than two distinct options, and
 *    the options are left exactly as the generic discoverer produced them,
 *    rather than guessed into a group;
 *  - the question label and every option's text are preserved verbatim
 *    (only surrounding whitespace and a trailing required asterisk trimmed);
 *  - nothing is merged across fieldsets: one fieldset is one question.
 */
export function groupAshbyChoices(fieldsets: RawFieldset[]): ChoiceGrouping {
  const groups: LiveField[] = [];
  const memberKeys = new Set<string>();
  const usedKeys = new Set<string>();
  for (const fs of fieldsets) {
    // Single-select only. Ashby renders its choice questions as radios with
    // one unique name per option; a checkbox multi-select is a different
    // question shape and is deliberately left ungrouped (it surfaces as
    // individual controls and blocks for a person) rather than mishandled
    // here as if only one option could be chosen.
    const opts = fs.inputs.filter((i) => ASHBY_OPTION_NAME.test(i.name) && i.kind === "radio");
    if (opts.length < 2) continue;                 // not a proven choice set
    const label = clean(fs.questionText ?? "");
    if (label.length < 5) continue;                // no legend recovered -> leave separate
    // Exact offered option text, order preserved, deduped -- and its live
    // selector, keyed by that text. The text is the stable identity; the
    // selector is re-derived every session and never stored.
    const options: string[] = [];
    const optionSelectors: Record<string, string> = {};
    for (const o of opts) {
      const t = clean(o.label);
      if (!t || options.includes(t)) continue;
      options.push(t);
      optionSelectors[t] = o.selector;
    }
    if (options.length < 2) continue;              // options collapsed to <2 -> not a real choice
    let key = label;
    for (let n = 2; usedKeys.has(key); n++) key = `${label} (${n})`;
    usedKeys.add(key);
    // A LiveField the fill path can act on directly: type "select" so the
    // options vocabulary applies, htmlType "radio-group" so write() knows to
    // click one option by its own selector and read back exactly one.
    groups.push({
      key, label, type: "select", required: opts.some((o) => o.required), options,
      selector: optionSelectors[options[0]!]!, selectorKind: "name",
      unlabelled: false, groupKey: key, htmlType: "radio-group",
      associated: [], name: null, optionSelectors,
    });
    for (const o of opts) memberKeys.add(o.name);  // drop the per-option fields the generic read made
    memberKeys.add(label);                         // and any phantom text field carrying the question
  }
  return { groups, memberKeys };
}

/**
 * Replace the generic per-option fields with the grouped questions. A
 * generic field is dropped only when its key is one of the grouped option
 * control names, or its key/label is a grouped question's text; every other
 * field is kept exactly as discovered.
 */
export function mergeChoiceGroups(generic: LiveField[], grouping: ChoiceGrouping): LiveField[] {
  const kept = generic.filter((f) => !grouping.memberKeys.has(f.key) && !grouping.memberKeys.has(f.label));
  return [...kept, ...grouping.groups];
}

/**
 * Drop the header-artifact file "field" Ashby produces.
 *
 * An Ashby posting renders its resume control as a real <input type=file>
 * with an id and a label ("_systemfield_resume"), AND a second bare
 * <input type=file> with no id, no name, no label and no aria -- the
 * drag-drop zone's inner input. The generic discoverer can only reach that
 * bare input by borrowing nearby text, so it resolves to the page's section
 * headings ("Overview", "Application") and arrives as a phantom required-
 * looking file field that can never be answered.
 *
 * The structural proof it is an artifact and not a real control: it is
 * file-typed and reachable ONLY by a label selector (no name/id/testid),
 * AND a strongly-identified file field exists in the same form. Both halves
 * are required, so a form whose only resume input is itself label-only is
 * left untouched (never suppressed), and a real, identified file field is
 * never dropped. This mirrors dropContainerBlobs' rule for weak-selector
 * duplicates, scoped to the file case, and keys on DOM identity, not label
 * text, so it does not broadly suppress Ashby file fields.
 */
export function dropFileHeaderArtifacts<T extends { type: string; selectorKind: string }>(fields: T[]): T[] {
  const hasStrongFile = fields.some((f) => f.type === "file" && f.selectorKind !== "label");
  if (!hasStrongFile) return fields;
  return fields.filter((f) => !(f.type === "file" && f.selectorKind === "label"));
}

/**
 * Choose the single offered option an answer names, or fail closed.
 *
 * An exact (case-insensitive) match against the offered text, and nothing
 * looser: an answer that is not one of the options is refused, and two
 * identical options are an ambiguity rather than a tie to break. The chosen
 * value is the offered spelling, so the control receives exactly its own
 * text. Pure, so the rule is tested without a browser.
 */
export function chooseSingleOption(
  options: string[], value: string,
): { ok: true; option: string } | { ok: false; why: string } {
  const v = value.trim().toLowerCase();
  const hits = options.filter((o) => o.trim().toLowerCase() === v);
  if (hits.length === 1) return { ok: true, option: hits[0]! };
  if (hits.length > 1) return { ok: false, why: `the answer ${JSON.stringify(value)} matches ${hits.length} identical options` };
  return { ok: false, why: `${JSON.stringify(value)} is not one of the offered options: ${options.join(" | ")}` };
}

/**
 * After a single-select click, exactly one option in the group is selected
 * and it is the one chosen. Anything else -- nothing selected, or a second
 * option also on -- is a read-back failure, not a success.
 */
export function verifySingleSelected(
  state: Record<string, boolean>, chosen: string,
): { ok: boolean; ticked: string[] } {
  const ticked = Object.entries(state).filter(([, on]) => on).map(([l]) => l);
  return { ok: ticked.length === 1 && ticked[0] === chosen, ticked };
}

/**
 * Reveal the application form if the landing page gates it.
 *
 * Ashby renders the posting first and the form only after "Apply for this
 * Job" is pressed. Pressing it is safe -- it reveals fields, it does not
 * submit anything -- and is the only control this touches. If the form is
 * already present, nothing is pressed.
 */
export async function revealAshbyForm(page: any): Promise<void> {
  if (looksLikeForm(await snapshotLive(page.mainFrame()))) return;
  const trigger = page.locator("button, a")
    .filter({ hasText: /apply for this job|apply now|^\s*apply\s*$/i }).first();
  if (await trigger.count().catch(() => 0)) {
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.click({ timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(2_500);
  }
}

/**
 * Is this a form we cannot safely read one page of? A "Next"/"Continue"
 * primary with no submit control is a multi-step flow; the snapshot reads a
 * single page state, so a later step would arrive unseen and unapproved.
 */
export async function ashbyMultiStep(page: any): Promise<boolean> {
  return page.evaluate(() => {
    const texts = Array.from(document.querySelectorAll("button, [role='button'], input[type='submit']"))
      .filter((el) => {
        const s = window.getComputedStyle(el as Element);
        const r = (el as HTMLElement).getBoundingClientRect();
        return s.display !== "none" && s.visibility !== "hidden" && (r.width > 0 || r.height > 0);
      })
      .map((el) => ((el as HTMLElement).innerText || (el as HTMLInputElement).value || "").trim().toLowerCase());
    const hasSubmit = texts.some((t) => /submit application|submit$|^submit\b/.test(t));
    const hasNext = texts.some((t) => /^next\b|continue$|^continue\b|next step/.test(t));
    return hasNext && !hasSubmit;
  });
}

/**
 * Read the Ashby choice fieldsets from the live page. Looks only at radio /
 * checkbox controls named the Ashby way, groups them by the fieldset that
 * contains them, and takes the question text from the first non-input text
 * in that fieldset (which is where Ashby renders it, ahead of the options).
 */
export async function readChoiceFieldsets(page: any): Promise<RawFieldset[]> {
  return page.mainFrame().evaluate(() => {
    const pair = /^[0-9a-f-]{36}_[0-9a-f-]{36}$/i;
    const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim();
    const labelForInput = (el: Element): string => {
      const id = (el as HTMLInputElement).id;
      if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l?.textContent?.trim()) return norm(l.textContent); }
      const al = el.getAttribute("aria-label"); if (al?.trim()) return norm(al);
      const lab = el.closest("label"); if (lab?.textContent?.trim()) return norm(lab.textContent);
      const sib = el.nextElementSibling as HTMLElement | null; if (sib?.textContent?.trim()) return norm(sib.textContent);
      const p = el.parentElement; if (p?.textContent?.trim()) return norm(p.textContent);
      return "";
    };
    const containers = new Set<Element>();
    for (const el of Array.from(document.querySelectorAll("input[type=radio],input[type=checkbox]"))) {
      if (!pair.test((el as HTMLInputElement).name || "")) continue;
      const c = el.closest("fieldset") || el.closest("[role=group],[role=radiogroup]");
      if (c) containers.add(c);
    }
    const out: any[] = [];
    for (const c of Array.from(containers)) {
      const inputs = Array.from(c.querySelectorAll("input[type=radio],input[type=checkbox]"))
        .filter((el) => pair.test((el as HTMLInputElement).name || ""));
      if (!inputs.length) continue;
      let questionText: string | null = null;
      for (const n of Array.from(c.querySelectorAll("label,legend,h1,h2,h3,h4,p,div,span"))) {
        if ((n as HTMLElement).querySelector("input")) continue;   // skip anything wrapping a control
        const t = norm(n.textContent || "");
        if (t && t.length > 4) { questionText = t; break; }        // first real text = the question
      }
      out.push({
        questionText,
        inputs: inputs.map((el) => {
          const name = (el as HTMLInputElement).name;
          const id = (el as HTMLInputElement).id;
          // Each Ashby option has a UNIQUE name (qid_optid), so the name
          // alone reaches exactly one control; an id, when present, is used
          // in preference. Never the shared group name -- there isn't one.
          const selector = id ? `#${CSS.escape(id)}` : `input[name="${CSS.escape(name)}"]`;
          return {
            name, selector,
            label: labelForInput(el),
            kind: (el.getAttribute("type") || "").toLowerCase() === "checkbox" ? "checkbox" : "radio",
            required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
          };
        }),
      });
    }
    return out;
  });
}
