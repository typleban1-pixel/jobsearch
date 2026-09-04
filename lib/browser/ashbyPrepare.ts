/**
 * Snapshotting an Ashby application form during preparation, in a browser.
 *
 * Greenhouse publishes its form, so a snapshot is an API call and
 * preparation never opens a page. Ashby does not: its posting API returns
 * 401 for the application-form endpoint without an employer key, and this
 * system holds none. The form exists only as rendered HTML behind the
 * public posting page. So, exactly as with Lever, preparation opens the
 * page, reveals the form if the landing page gates it behind an "Apply for
 * this job" button, and snapshots what actually renders. The invariant is
 * unchanged: the questions approved are the questions the system is allowed
 * to answer and submit against.
 *
 * This is prepare/snapshot only. It never fills, never clicks Submit, and
 * fails closed -- with a specific, honest reason -- on the cases we do not
 * safely support (a sign-in wall, an SSO prompt, a CAPTCHA challenge, or a
 * multi-step form). A fail-closed result parks the application for a person;
 * it never guesses at a form it could not read.
 *
 * Lives under lib/browser because it imports Playwright. The portal must
 * never reach this file, which is why prepareApplication takes it as an
 * injected function rather than importing it.
 */
import type { Frame } from "playwright";
import type { FormField } from "../applications/answer.ts";
import { hashSnapshot, type FormSnapshot } from "../applications/formSnapshot.ts";
import { snapshotLive, type LiveField, type LiveSnapshot } from "./liveSnapshot.ts";
import { isDemographicField, isDisabilityField } from "./eeo.ts";
import { launchBrowser, newPreparedPage } from "./launch.ts";

export interface AshbyLiveResult {
  ok: boolean;
  reason?: string;
  snapshot?: FormSnapshot;
  hash?: string;
}

/**
 * A discovered live field, projected onto the system's form vocabulary.
 *
 * snapshotLive already collapses a multi-checkbox question into one
 * "checkbox-group" field carrying its options, and already dedupes a radio
 * group to a single field keyed by its shared DOM name. FormField has no
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

/**
 * Ashby renders a choice question as a <fieldset> of radio or checkbox
 * options, and names each option control "{uuid}_{uuid}" -- a question id
 * and an option id. The generic discoverer, which has no provider
 * knowledge, emits one boolean field per option, so a five-option question
 * arrives as five separate yes/no fields labelled by their option text.
 *
 * These types describe what an Ashby-specific DOM read returns, and the
 * grouping below is pure so the rule is testable without a browser.
 */
export interface RawChoiceInput { name: string; label: string; kind: "radio" | "checkbox"; required: boolean }
export interface RawFieldset { questionText: string | null; inputs: RawChoiceInput[] }
export interface ChoiceGrouping { groups: FormField[]; memberKeys: Set<string> }

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
  const groups: FormField[] = [];
  const memberKeys = new Set<string>();
  const usedKeys = new Set<string>();
  for (const fs of fieldsets) {
    const opts = fs.inputs.filter((i) => ASHBY_OPTION_NAME.test(i.name));
    if (opts.length < 2) continue;                 // not a proven choice set
    const label = clean(fs.questionText ?? "");
    if (label.length < 5) continue;                // no legend recovered -> leave separate
    const options: string[] = [];
    for (const o of opts) { const t = clean(o.label); if (t && !options.includes(t)) options.push(t); }
    if (options.length < 2) continue;              // options collapsed to <2 -> not a real choice
    let key = label;
    for (let n = 2; usedKeys.has(key); n++) key = `${label} (${n})`;
    usedKeys.add(key);
    groups.push({ key, label, type: "select", required: opts.some((o) => o.required), options });
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
export function mergeChoiceGroups(generic: FormField[], grouping: ChoiceGrouping): FormField[] {
  const kept = generic.filter((f) => !grouping.memberKeys.has(f.key) && !grouping.memberKeys.has(f.label));
  return [...kept, ...grouping.groups];
}

export type AshbyDecision = { ok: true } | { ok: false; reason: string };

/**
 * The fail-closed decision, pure so the rule is testable without a browser.
 *
 * Order is certainty: a sign-in wall, then SSO, then a CAPTCHA, then "no
 * form here", then multi-step. Each carries the honest reason a person
 * needs, and each ends in a manual handoff -- "finished by hand" -- rather
 * than a guess at a form that could not be read one page of.
 */
export function decideAshby(live: LiveSnapshot, isMultiStep: boolean): AshbyDecision {
  if (live.loginWall) {
    return { ok: false, reason: "a sign-in wall is displayed on the Ashby apply page, so the form cannot be read without signing in. This one has to be finished by hand." };
  }
  if (live.ssoPrompt) {
    return { ok: false, reason: "the Ashby apply page requires single sign-on before the form is shown. This one has to be finished by hand." };
  }
  if (live.captcha) {
    return { ok: false, reason: "a CAPTCHA challenge is displayed on the Ashby apply page. This one has to be finished by hand." };
  }
  if (!looksLikeForm(live)) {
    return { ok: false, reason: "no Ashby application form was found at the apply URL. This one has to be finished by hand." };
  }
  if (isMultiStep) {
    return { ok: false, reason: "this Ashby application is multi-step, which is not yet supported for assisted preparation. This one has to be finished by hand." };
  }
  return { ok: true };
}

/**
 * Reveal the application form if the landing page gates it.
 *
 * Ashby renders the posting first and the form only after "Apply for this
 * Job" is pressed. Pressing it is safe -- it reveals fields, it does not
 * submit anything -- and is the only control this function ever clicks. If
 * the form is already present, nothing is pressed.
 */
async function revealForm(page: any): Promise<void> {
  if (looksLikeForm(await snapshotLive(page.mainFrame() as Frame))) return;
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
 * primary with no submit control is a multi-step flow; snapshotLive reads a
 * single page state, so a later step would arrive unseen and unapproved.
 */
async function multiStep(page: any): Promise<boolean> {
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
 * Read the Ashby choice fieldsets from the live page. Provider-specific and
 * deliberately kept out of the generic discoverer: it looks only at radio /
 * checkbox controls named the Ashby way, groups them by the fieldset that
 * contains them, and takes the question text from the first non-input text
 * in that fieldset (which is where Ashby renders it, ahead of the options).
 */
async function readChoiceFieldsets(page: any): Promise<RawFieldset[]> {
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
        inputs: inputs.map((el) => ({
          name: (el as HTMLInputElement).name,
          label: labelForInput(el),
          kind: (el.getAttribute("type") || "").toLowerCase() === "checkbox" ? "checkbox" : "radio",
          required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
        })),
      });
    }
    return out;
  });
}

export async function snapshotAshbyLive(input: {
  applyUrl: string;
  /** Kept for signature parity with the Lever path; Ashby does not gate on office. */
  reviewedOffice?: string | null;
  timeoutMs?: number;
}): Promise<AshbyLiveResult> {
  const browser = await launchBrowser();
  try {
    const page = await newPreparedPage(browser, { viewport: { width: 1440, height: 1000 } });
    const res = await page.goto(input.applyUrl, { waitUntil: "domcontentloaded", timeout: input.timeoutMs ?? 45_000 });
    if (!res || res.status() >= 400) {
      return { ok: false, reason: `the apply page returned ${res?.status() ?? "no response"}` };
    }
    await page.waitForTimeout(2_500);

    // Reveal FIRST. A snapshot taken before the form is shown describes the
    // posting, not the application.
    await revealForm(page);
    // Nudge lazily-rendered questions into the DOM before reading it, so the
    // field set is the whole form rather than what happened to be in view.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(800);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

    const live = await snapshotLive(page.mainFrame() as Frame);

    // Fail closed on the cases we do not safely support, each with the
    // honest reason a person needs. multiStep is read from the page only
    // when the snapshot itself looks like a form, so a landing page is
    // never mistaken for a step.
    const isMultiStep = looksLikeForm(live) ? await multiStep(page) : false;
    const decision = decideAshby(live, isMultiStep);
    if (!decision.ok) return { ok: false, reason: decision.reason };

    // Collapse Ashby choice fieldsets into one question each, then drop the
    // per-option fields the generic read produced. Anything not proven to be
    // a grouped option is left exactly as discovered.
    const grouping = groupAshbyChoices(await readChoiceFieldsets(page));
    const fields = mergeChoiceGroups(live.fields.map(toFormField), grouping);
    const snapshot: FormSnapshot = {
      provider: "ASHBY",
      fields,
      sensitiveKeys: fields
        .filter((f) => isDemographicField(f.label) || isDisabilityField(f.label))
        .map((f) => f.key),
      fetchedAt: new Date().toISOString(),
    };
    return { ok: true, snapshot, hash: hashSnapshot(snapshot) };
  } catch (err) {
    return { ok: false, reason: `could not snapshot the live Ashby form: ${(err as Error).message}` };
  } finally {
    await browser.close();
  }
}
