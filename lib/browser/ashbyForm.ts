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
 * Ashby renders some free-answer questions -- location and demographic
 * self-ID among them -- as a react-select combobox: a role="combobox" input
 * with no id, name or label, whose options render into a detached listbox on
 * type. The generic discoverer can only key it by the nearby question text,
 * as a plain text field, and then cannot locate it to fill it.
 *
 * This reads which questions ARE such a combobox, anchoring each control to
 * the field container that holds it and requiring exactly one combobox in
 * that container. A container with two comboboxes, or none, is not returned,
 * so it is never marked and the fill path leaves it to fail closed rather
 * than guess. A choice fieldset (uuid_uuid radios) is not a combobox and is
 * excluded. The returned value is the question TEXT, the stable identity.
 */
export async function readAshbyComboboxes(page: any): Promise<string[]> {
  return page.mainFrame().evaluate(() => {
    const pair = /^[0-9a-f-]{36}_[0-9a-f-]{36}$/i;
    const norm = (s: string) => (s || "").replace(/\s+/g, " ").replace(/\s*\*\s*$/, "").trim();
    const out: string[] = [];
    const seen = new Set<Element>();
    for (const combo of Array.from(document.querySelectorAll("[role=combobox]"))) {
      const c = combo.closest('[class*="_fieldEntry_"], [class*="ashby-application-form-field"]');
      if (!c || seen.has(c)) continue;
      seen.add(c);
      if (c.querySelectorAll("[role=combobox]").length !== 1) continue;   // ambiguous container
      const radios = Array.from(c.querySelectorAll("input[type=radio],input[type=checkbox]"))
        .filter((el) => pair.test((el as HTMLInputElement).name || ""));
      if (radios.length) continue;                                        // a choice group, not a combobox
      // Collect EVERY leaf text label in the container, not just the first.
      // An Ashby field entry can carry a short heading ("Location") AND the
      // real question as a separate description ("Please list the city of your
      // current residence."). Ashby keys the field by the description, so
      // returning only the first text (the heading) left the field untagged
      // and, at fill, resolved as a plain text input -> 0 controls ->
      // SELECTOR_AMBIGUOUS. Leaf-only (skip wrappers that hold another
      // candidate) avoids concatenated "LocationPlease list..." noise; the
      // Set() at return dedups. markAshbyComboboxes then matches the field by
      // whichever of these its snapshot label happens to be.
      for (const n of Array.from(c.querySelectorAll("label,legend,h1,h2,h3,h4,p,div,span"))) {
        if ((n as HTMLElement).querySelector("input,textarea,[role=combobox]")) continue;
        if ((n as HTMLElement).querySelector("label,legend,h1,h2,h3,h4,p,div,span")) continue;
        const t = norm(n.textContent || "");
        if (t && t.length > 4) out.push(t);
      }
    }
    return [...new Set(out)];
  });
}

/**
 * Re-tag the generic text fields that are actually Ashby comboboxes, keyed
 * by their question text, so the fill path drives them as comboboxes rather
 * than typing into a control it cannot find. A field already grouped as a
 * choice question, or a file, is left alone.
 */
export function markAshbyComboboxes(fields: LiveField[], comboQuestions: string[]): LiveField[] {
  if (!comboQuestions.length) return fields;
  const set = new Set(comboQuestions.map((q) => q.trim().toLowerCase()));
  return fields.map((f) => {
    if ((f.htmlType as string) === "radio-group" || (f.type as string) === "file") return f;
    if (!set.has((f.label || "").trim().toLowerCase())) return f;
    return { ...f, type: "select" as FormField["type"], htmlType: "ashby-combobox" };
  });
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

/**
 * Ashby's custom Yes/No (and similar) button groups.
 *
 * These are NOT radios: a field's _fieldEntry_ container holds two or more
 * <button aria-pressed>, backed by a hidden single-name checkbox that the
 * generic radio/checkbox discovery (which keys on the qid_optid name
 * pattern) never sees. So work-authorization, sponsorship, prior-employment,
 * relatives and Terms consent all went undiscovered, reached a false
 * HANDOFF, and were reported missing at submit. This reads them as one
 * semantic field with the button labels as options; the fill clicks the
 * matching button and proves it reads back aria-pressed.
 */
export interface AshbyButtonGroup { label: string; options: string[]; required: boolean }

export async function readAshbyButtonGroups(page: any): Promise<AshbyButtonGroup[]> {
  return page.mainFrame().evaluate(() => {
    const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim();
    const out: any[] = [];
    const seen = new Set<string>();
    for (const el of Array.from(document.querySelectorAll("[class*=_fieldEntry_]"))) {
      const btns = Array.from(el.querySelectorAll("button")).filter((b) => b.getAttribute("aria-pressed") !== null);
      if (btns.length < 2) continue;
      const labelNode = el.querySelector("[class*=_label_], [class*=_heading_], label, legend");
      let label = norm(labelNode?.textContent || "");
      if (!label) {
        let t = norm((el as HTMLElement).innerText || "");
        for (const b of btns) t = t.replace(norm((b as HTMLElement).innerText || ""), "");
        label = norm(t);
      }
      label = label.replace(/\s*\*\s*$/, "").trim();
      if (label.length < 4 || seen.has(label)) continue;
      seen.add(label);
      out.push({
        label,
        options: btns.map((b) => norm((b as HTMLElement).innerText || "")).filter(Boolean),
        // Requiredness is not reliably marked on these; fail closed so a
        // genuinely required one is never treated as skippable.
        required: true,
      });
    }
    return out;
  });
}

/**
 * Fold discovered button groups into the field list as single "select"
 * fields tagged ashby-button-group, and drop any generic artifact the raw
 * snapshot produced for the same question (the backing checkbox, or a
 * phantom "Yes"/"No" field).
 */
export function mergeAshbyButtonGroups(fields: LiveField[], groups: AshbyButtonGroup[]): LiveField[] {
  if (!groups.length) return fields;
  const groupLabels = new Set(groups.map((g) => g.label));
  const optionTexts = new Set(groups.flatMap((g) => g.options.map((o) => o.toLowerCase())));
  const kept = fields.filter((f) => {
    if (groupLabels.has(f.label)) return false;                         // the backing checkbox carrying the question
    if (optionTexts.has((f.label || "").trim().toLowerCase())) return false; // a phantom "Yes"/"No" field
    return true;
  });
  let n = 0;
  for (const g of groups) {
    let key = g.label;
    while (kept.some((f) => f.key === key)) key = `${g.label} (${++n})`;
    kept.push({
      key, label: g.label, type: "select", required: g.required, options: g.options,
      selector: g.label, selectorKind: "label", unlabelled: false,
      groupKey: g.label, htmlType: "ashby-button-group", associated: [], name: null,
    });
  }
  return kept;
}

/**
 * Wait until Ashby's React form has hydrated enough to accept input.
 *
 * Ashby server-renders the form, so the controls exist and can be typed
 * into before react-hook-form has attached its onChange handlers. Filling
 * in that window sets the DOM value but never reaches the form's state, so
 * every field -- text, buttons, radios -- submits as "missing" while the
 * page visibly shows the values. An onChange handler is attached before that
 * window closes, so its mere presence is a FALSE ready signal (proven live:
 * a text input reported onChange yet a written value neither committed nor
 * survived the next render). This instead drives the real commit path on a
 * throwaway probe and returns ready only once the value reaches React's own
 * state and survives a render tick.
 */
export async function waitForAshbyHydration(page: any, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  while (Date.now() < deadline) {
    // Non-mutating readiness: onChange-present alone is a FALSE ready (proven
    // live -- a value written then neither committed nor survived the next
    // render, because the control is REPLACED when the form finishes
    // mounting). Rather than write a probe value (which can leave residue in
    // field state), tag the first text input with a data attribute and watch
    // whether the SAME node persists across polls: a data-* attribute
    // survives React re-renders but not a re-mount, so a node that keeps its
    // tag for two polls in a row has finished mounting and its onChange is
    // wired. Never touches the input's value or the form's state.
    const state = await page.mainFrame().evaluate(() => {
      const input = document.querySelector(
        "input[type=text], input[type=email], input:not([type])",
      ) as HTMLInputElement | null;
      if (!input) return "none";
      const rk = Object.keys(input).find((k) => k.startsWith("__reactProps"));
      if (!rk || typeof (input as any)[rk]?.onChange !== "function") return "nohandler";
      if (input.getAttribute("data-ashby-hydration-seen") !== "1") {
        input.setAttribute("data-ashby-hydration-seen", "1");
        return "tagged";                 // first sighting of this node
      }
      return "stable";                   // same node still here, re-mount done
    }).catch(() => "err");
    if (state === "stable") { stable++; if (stable >= 2) return true; }
    else stable = 0;
    await page.waitForTimeout(250);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Field entries: the structure Ashby actually renders.
//
// Every question on an Ashby form lives in one `_fieldEntry_` container that
// carries the question's label (a <label class="_label_ ..."> whose class
// list says whether it is required), an optional description, and the
// controls: one text/textarea/file input; two or more radios (named
// "{qid}_{optid}", each option its own name); two or more checkboxes for a
// pick-many (each NAMED BY ITS OPTION TEXT, so "Other" and "I prefer not to
// answer" recur across questions and the name alone reaches several boxes);
// two or more <button aria-pressed> for Ashby's Yes/No; or one anonymous
// react-select combobox. The generic DOM walk sees every one of those
// controls as its own field and names it by whatever text is nearest, which
// is how "Where did you hear about Fieldguide?" arrived as thirteen
// unrelated yes/no questions called "LinkedIn", "Indeed", "Other"... and a
// label-less combobox arrived not at all. Reading the entries directly is
// the fix: one entry, one question, options and selectors attached.
// ---------------------------------------------------------------------------

export interface AshbyEntryOption {
  label: string;
  /** A plain-CSS selector reaching exactly this control, or "" when none is unique. */
  selector: string;
}
export interface AshbyEntry {
  label: string;
  description: string | null;
  required: boolean;
  kind: "radio" | "checkbox" | "buttons" | "combobox" | "other";
  options: AshbyEntryOption[];
  /** Every name and id of a control inside the entry, for dropping the generic duplicates. */
  memberNames: string[];
  memberIds: string[];
  /** The shared name when the options are Ashby system EEO radios, else null. */
  systemName: string | null;
}

export async function readAshbyEntries(page: any): Promise<AshbyEntry[]> {
  return page.mainFrame().evaluate(() => {
    const norm = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").replace(/\s*\*\s*$/, "").trim();
    const attr = (s: string) => s.replace(/["\\]/g, "\\$&");
    const uniqueSel = (el: Element, type: string): string => {
      const id = el.id;
      if (id && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) return `#${CSS.escape(id)}`;
      const name = el.getAttribute("name") || "";
      const value = el.getAttribute("value") || "";
      if (name && value) {
        const s = `input[type=${type}][name="${attr(name)}"][value="${attr(value)}"]`;
        if (document.querySelectorAll(s).length === 1) return s;
      }
      if (name) {
        const s = `input[type=${type}][name="${attr(name)}"]`;
        if (document.querySelectorAll(s).length === 1) return s;
      }
      return "";
    };
    const optionLabel = (el: Element): string => {
      const id = el.id;
      if (id) {
        const ls = Array.from(document.querySelectorAll(`label[for="${CSS.escape(id)}"]`));
        // Duplicate ids make label[for] ambiguous; prefer the label that
        // actually contains or follows this control.
        const own = ls.find((l) => l.contains(el) || l === el.nextElementSibling || l.parentElement === el.parentElement);
        const t = norm((own ?? ls[0])?.textContent);
        if (t) return t;
      }
      const wrap = el.closest("label"); if (wrap) return norm(wrap.textContent);
      const sib = el.nextElementSibling; if (sib && sib.tagName === "LABEL") return norm(sib.textContent);
      return norm(el.parentElement?.textContent);
    };
    const out: any[] = [];
    for (const e of Array.from(document.querySelectorAll("[class*=_fieldEntry_]"))) {
      const labelNode = e.querySelector("[class*=_label_], [class*=_heading_], label, legend");
      const label = norm(labelNode?.textContent);
      if (!label) continue;
      const required = /_required_/.test(labelNode?.getAttribute("class") || "")
        || Array.from(e.querySelectorAll("input,select,textarea")).some((c) => c.hasAttribute("required") || c.getAttribute("aria-required") === "true");
      const description = norm(e.querySelector("[class*=_description_]")?.textContent) || null;
      const radios = Array.from(e.querySelectorAll("input[type=radio]"));
      const buttons = Array.from(e.querySelectorAll("button[aria-pressed]"));
      const checkboxes = Array.from(e.querySelectorAll("input[type=checkbox]"))
        // A button group's backing checkbox has no label of its own.
        .filter((c) => buttons.length < 2 || optionLabel(c).length > 0);
      const combos = Array.from(e.querySelectorAll("[role=combobox]"));
      const controls = Array.from(e.querySelectorAll("input,select,textarea,button[aria-pressed],[role=combobox]"));
      const memberNames = controls.map((c) => c.getAttribute("name") || "").filter(Boolean);
      const memberIds = controls.map((c) => c.id || "").filter(Boolean);
      let kind: string = "other";
      let options: any[] = [];
      let systemName: string | null = null;
      if (radios.length >= 2) {
        kind = "radio";
        options = radios.map((r) => ({ label: optionLabel(r), selector: uniqueSel(r, "radio") }));
        const names = new Set(radios.map((r) => r.getAttribute("name") || ""));
        if (names.size === 1 && /_systemfield_eeoc_/i.test([...names][0]!)) systemName = [...names][0]!;
      } else if (checkboxes.length >= 2) {
        kind = "checkbox";
        options = checkboxes.map((c) => ({ label: optionLabel(c), selector: uniqueSel(c, "checkbox") }));
      } else if (buttons.length >= 2) {
        kind = "buttons";
        options = buttons.map((b) => ({ label: norm((b as HTMLElement).innerText), selector: "" }));
      } else if (combos.length === 1 && !e.querySelector("input[type=text],input[type=email],input[type=tel],textarea,select")) {
        kind = "combobox";
      }
      out.push({ label, description, required, kind, options, memberNames, memberIds, systemName });
    }
    return out;
  });
}

/**
 * The Ashby form as questions: the generic field list with every control
 * that belongs to a grouped entry replaced by the one question it is part
 * of, and every question the generic walk could not see added.
 *
 * Pure, given the entries and the raw fields, so the rule is testable
 * without a browser. Rules, in order:
 *  - a radio entry with two or more labelled options is one single-select
 *    question (radio-group); its key is the question text, except Ashby's
 *    system EEO groups, which keep their shared control name as key so the
 *    fill's rule about those fields keeps applying;
 *  - a checkbox entry with two or more labelled options is one pick-many
 *    question (checkbox-group), keyed by its text;
 *  - a button entry is one Yes/No question (ashby-button-group);
 *  - a combobox entry is one option-picker question (ashby-combobox);
 *  - every generic field whose name or id belongs to such an entry, or
 *    whose only identity is the entry's own text, an option's text or the
 *    entry's description, is dropped as the duplicate it is;
 *  - everything else is kept exactly as discovered.
 * Option text and question text are preserved verbatim (whitespace and a
 * trailing asterisk trimmed). Two questions with identical text are keyed
 * apart with "(2)", never merged.
 */
export function assembleAshbyFields(raw: LiveField[], entries: AshbyEntry[]): LiveField[] {
  const built: LiveField[] = [];
  const dropNames = new Set<string>();
  const dropIds = new Set<string>();
  const dropTexts = new Set<string>();
  const usedKeys = new Set<string>(raw.map((f) => f.key));
  const keyFor = (base: string): string => {
    let key = base;
    for (let n = 2; usedKeys.has(key); n++) key = `${base} (${n})`;
    usedKeys.add(key);
    return key;
  };
  for (const e of entries) {
    const opts = e.options.filter((o) => o.label);
    const labels: string[] = [];
    const optionSelectors: Record<string, string> = {};
    for (const o of opts) { if (labels.includes(o.label)) continue; labels.push(o.label); optionSelectors[o.label] = o.selector; }
    const common = {
      label: e.label, type: "select" as FormField["type"], required: e.required, options: labels,
      unlabelled: false, groupKey: e.label, associated: [] as string[], name: null,
    };
    if ((e.kind === "radio" || e.kind === "checkbox") && labels.length >= 2) {
      const key = e.systemName ? keyFor(e.systemName) : keyFor(e.label);
      built.push({ ...common, key, htmlType: e.kind === "radio" ? "radio-group" : "checkbox-group",
        selector: optionSelectors[labels[0]!] || e.label, selectorKind: optionSelectors[labels[0]!] ? "name" : "label", optionSelectors });
    } else if (e.kind === "buttons" && labels.length >= 2) {
      built.push({ ...common, key: keyFor(e.label), htmlType: "ashby-button-group", selector: e.label, selectorKind: "label" });
    } else if (e.kind === "combobox") {
      built.push({ ...common, key: keyFor(e.label), options: [], htmlType: "ashby-combobox", selector: e.label, selectorKind: "label" });
    } else {
      continue;                                    // a plain control: the generic field stands
    }
    for (const n of e.memberNames) dropNames.add(n);
    for (const i of e.memberIds) dropIds.add(i);
    dropTexts.add(e.label);
    if (e.description) dropTexts.add(e.description);
    for (const l of labels) dropTexts.add(l);
  }
  const kept = raw.filter((f) => {
    const keyName = String(f.key).split("=")[0]!;
    if (f.name && dropNames.has(f.name)) return false;
    if (dropNames.has(keyName) || dropIds.has(keyName)) return false;
    // Weakly identified (label-only, or a checkbox named by its own option
    // text) and carrying nothing but text an entry already owns.
    const weak = f.selectorKind === "label" || (f.name != null && f.name === f.label);
    if (weak && (dropTexts.has(f.label) || dropTexts.has(String(f.key)))) return false;
    if ((f.type as string) === "checkbox-group" && dropTexts.has(String(f.key))) return false;
    return true;
  });
  return [...kept, ...built];
}

/**
 * The one normalization both preparation and filling apply to an Ashby
 * form: the file-dropzone phantom dropped, then the field entries read from
 * the live page and assembled over the generic snapshot.
 */
export async function normalizeAshbyFields(page: any, raw: LiveField[]): Promise<LiveField[]> {
  return assembleAshbyFields(dropFileHeaderArtifacts(raw), await readAshbyEntries(page));
}
