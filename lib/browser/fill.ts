/**
 * Filling one prepared application, and stopping before submission.
 *
 * The state machine, in order. Every transition either advances or
 * stops; nothing here does its best.
 *
 *   READY        the application is approved and its posting is current
 *   OPEN         the live form is reachable, and is a form
 *   IDENTIFY     the form still matches what was reviewed
 *   UPLOAD       resume in, ordering decided by measured ATS behaviour
 *   RECONCILE    what the ATS parser did, compared with what we prepared
 *   FILL         only VERIFIED, DERIVED and HUMAN_CONFIRMED values
 *   READBACK     every written value is what the field now holds
 *   HANDOFF      guards torn down, browser left open, person submits
 *
 * The whole point is the absence of a ninth state.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BrowserContext, ElementHandle, Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Stop, HANDOFF, type FillOutcomeName } from "./stopReasons.ts";
import { SubmitGuard } from "./submitGuard.ts";
import { snapshotLive, type LiveField } from "./liveSnapshot.ts";
import { resolveFormContext, assertContextIntact, type FormContext } from "./formContext.ts";
import { exactlyOne, fillText, readBack, selectOption, setChecked, setFiles, clickOptionWithin } from "./actions.ts";
import { readLazyOptions, readFilteredOptions, exactOptions } from "./inspectCombobox.ts";
import { geoSearchTerm, exactGeoMatches, qualifiedGeoMatches, sameGeography } from "./geography.ts";
import { reconcileAll, answerFitsControl, type Reconciled } from "./reconcile.ts";
import { attachResume, type AttachmentEvidence } from "./upload.ts";
import { behaviourOf, recordObservation, uploadFirst, type Behaviour } from "./parserBehaviour.ts";
import { hashSnapshot } from "../applications/formSnapshot.ts";
import { resolveField, equivalents, type FormField, type ResolveContext } from "../applications/answer.ts";

export const FILL_VERSION = 1;

export interface PreparedAnswer {
  fieldKey: string | null;
  fieldLabel: string;
  answer: string | null;
  confidence: "VERIFIED" | "DERIVED" | "HUMAN_CONFIRMED" | "BLOCKED";
  isRequired: boolean;
}

export interface FillOutcome {
  reason: FillOutcomeName;
  message: string;
  filled: Array<{ field: string; value: string }>;
  leftBlank: Array<{ field: string; why: string }>;
  parserReconciliation: Array<{ field: string; parsed: string; prepared: string | null; action: string }>;
  /** Controls that existed only in the DOM and were resolved at fill time. */
  resolvedLive: Array<{ field: string; answer: string; confidence: string }>;
  /** Snapshot entries that turned out to be the same live control. */
  aliases: Array<{ field: string; sameAs: string }>;
  /** Lazily-rendered controls opened read-only to identify them. */
  inspections: Array<{ field: string; optionsFound: number; sample: string[]; resolvedAs: string;
    /** Every option the control offered, so a stop can show the real list. */
    allOptions?: string[] }>;
  /** How each live control was matched to the reviewed question. */
  reconciliation: Array<{ field: string; basis: string | null; apiKey: string | null; controlTypeDiffers: boolean; blocked: string | null }>;
  /** Proof the approved artifact is attached. */
  attachment: AttachmentEvidence | null;
  formContext: { kind: string; url: string } | null;
  screenshots: string[];
  guard: unknown;
}

const FILLABLE = new Set(["VERIFIED", "DERIVED", "HUMAN_CONFIRMED"]);

/** Options that are calling codes: "Poland +48", "+1", "United States (+1)". */
function optionsLookLikeDialCodes(options: string[] | undefined): boolean {
  if (!options || options.length < 2) return false;
  const withCode = options.filter((o) => /\+\d{1,4}\b/.test(o)).length;
  return withCode >= Math.max(2, options.length * 0.5);
}

/**
 * Whether filling `field` would mean something different depending on an
 * unresolved control.
 *
 * Three signals, all read off the DOM rather than assumed:
 *
 *   grouping      the two controls sit in one fieldset or role=group, so
 *                 the form asks them together
 *   association   one declares aria-controls / aria-owns / describedby
 *                 pointing at the other
 *   calling code  a telephone input next to an unresolved control whose
 *                 options are dial codes. Greenhouse labels that control
 *                 simply "Country", and typing a national number while
 *                 the calling country is unset records a different phone
 *                 number than the one intended.
 */
function dependsOnUnresolved(field: LiveField, unresolved: LiveField[]): LiveField | null {
  for (const u of unresolved) {
    if (field.groupKey && u.groupKey && field.groupKey === u.groupKey) return u;
    if (field.associated.includes(u.key) || u.associated.includes(field.key)) return u;
    // A telephone input depends on an unresolved country control, whether
    // that control announces itself through dial-code options or is a
    // bare combobox labelled only "Country". Typing a national number
    // while the calling country is unset records a different number.
    if (field.htmlType === "tel"
        && (optionsLookLikeDialCodes(u.options) || /\bcountry\b/i.test(u.label))) return u;
  }
  return null;
}

/**
 * The options a specific control is currently offering.
 *
 * Scoped to the control's own listbox. Reading the first listbox on the
 * page returns whichever one happens to be open, which during the school
 * search was the phone dial-code list.
 */
async function optionsForControl(frame: FormContext["frame"], selector: string): Promise<string[]> {
  return frame.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return [];
    const owned = el.getAttribute("aria-controls") ?? el.getAttribute("aria-owns");
    const byId = el.id ? document.getElementById(`react-select-${el.id}-listbox`) : null;
    const box = (owned && document.getElementById(owned)) || byId
      || el.closest("div,fieldset")?.querySelector("[role='listbox'], [class*='menu-list' i]") || null;
    if (!box || (box.textContent ?? "").includes("Loading")) return [];
    return Array.from(box.querySelectorAll("[role='option']"))
      .map((o) => (o.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  }, selector);
}

/**
 * What a react-select control actually kept after a choice.
 *
 * Its text input empties on commit, so reading the input says a field is
 * blank when it is answered. The chosen value lives in the control's own
 * single-value node.
 */
async function committedValue(frame: FormContext["frame"], selector: string): Promise<string | null> {
  return frame.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const shell = el.closest("[class*='select__control']")?.parentElement
      ?? el.closest("div,fieldset");
    const single = shell?.querySelector("[class*='single-value']");
    return single ? (single.textContent ?? "").replace(/\s+/g, " ").trim() : null;
  }, selector);
}

/** Greenhouse's school list, searched for one institution. */
async function greenhouseSchoolOptions(provider: string, boardToken: string | null, institution: string): Promise<string[]> {
  if (provider !== "GREENHOUSE" || !boardToken) return [];
  try {
    const res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/education/schools`
      + `?term=${encodeURIComponent(institution)}`, { headers: { accept: "application/json" } });
    if (!res.ok) return [];
    const body = await res.json();
    return (body.items ?? []).map((i: any) => String(i.text)).filter(Boolean);
  } catch { return []; }
}

async function shot(page: Page, dir: string, name: string, into: string[]): Promise<void> {
  const path = join(dir, `${name}.png`);
  await page.screenshot({ path, fullPage: true }).catch(() => undefined);
  into.push(path);
}

/**
 * Locate a control inside the resolved form context, or stop.
 *
 * The frame is the form's, which for an embedded Greenhouse application
 * is the iframe rather than the employer's page. The selector hierarchy
 * is unchanged; only where it is applied moved.
 */
async function control(ctx: FormContext, f: LiveField) {
  if (!f.selector) {
    throw new Stop("UNLABELLED_REQUIRED_FIELD", `a control has no label and no usable selector`);
  }
  const locator = f.selectorKind === "label"
    ? ctx.frame.getByLabel(f.selector, { exact: true })
    : ctx.frame.locator(f.selector);
  return exactlyOne(ctx.frame, locator, f.label || f.key);
}

export interface FillInput {
  db: SupabaseClient;
  context: BrowserContext;
  applicationId: string;
  provider: string;
  applyUrl: string;
  storedHash: string | null;
  storedFields: FormField[];
  answers: PreparedAnswer[];
  resumePdfPath: string | null;
  runDir: string;
  /**
   * The same evidence the preparation step used.
   *
   * Some controls exist only in the DOM. Greenhouse's board API does not
   * mention its dial-code selector at all, so no prepared answer can
   * exist for it, and without this every such control would be a
   * permanent block regardless of whether the profile could answer it.
   * Resolving here uses the SAME resolver and the same four confidence
   * states; nothing is relaxed because the field was discovered late.
   */
  resolveContext?: ResolveContext;
  /** The board token, for looking up school and degree vocabularies. */
  boardToken?: string | null;
  /** Verified education, newest first, for the repeatable section. */
  educationRecords?: Array<{ institution: string; degree: string }>;
  /** The degree vocabulary this board offers. */
  degreeOptions?: string[];
  /**
   * How to look up a school's offered spellings.
   *
   * Injectable so the repeatable-education behaviour can be tested
   * against fixtures without calling a real board. Production leaves it
   * unset and the Greenhouse lookup is used.
   */
  schoolOptionsFor?: (institution: string) => Promise<string[]>;
}

export async function fillApplication(input: FillInput): Promise<FillOutcome> {
  const { db, context, provider, applyUrl, storedHash, storedFields, answers, resumePdfPath, runDir, resolveContext } = input;
  const boardToken = input.boardToken ?? null;
  const educationRecords = input.educationRecords ?? [];
  const degreeOptions = input.degreeOptions ?? [];
  const screenshots: string[] = [];
  const filled: FillOutcome["filled"] = [];
  const leftBlank: FillOutcome["leftBlank"] = [];
  const reconciliation2: FillOutcome["parserReconciliation"] = [];
  const resolvedLive: FillOutcome["resolvedLive"] = [];
  const aliases: FillOutcome["aliases"] = [];
  const inspections: FillOutcome["inspections"] = [];
  const reconciliation: FillOutcome["reconciliation"] = [];
  let attachment: AttachmentEvidence | null = null;
  let contextInfo: FillOutcome["formContext"] = null;
  await mkdir(runDir, { recursive: true });

  const guard = await SubmitGuard.install(context);
  const page = await context.newPage();
  const runMark = guard.mark();
  // Set once the form context is resolved, so the guard report reads the
  // frame that would actually have carried a submission.
  let formFrame: import("playwright").Frame | null = null;
  let formMark = runMark;
  const behaviour: Behaviour = await behaviourOf(db, provider);

  const finish = async (reason: FillOutcomeName, message: string): Promise<FillOutcome> => ({
    reason, message, filled, leftBlank, parserReconciliation: reconciliation2, resolvedLive, aliases, inspections,
    reconciliation, attachment, formContext: contextInfo,
    screenshots, guard: await guard.report(formFrame ?? page),
  });

  try {
    // -- OPEN ---------------------------------------------------------
    guard.arm(applyUrl);
    await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    await shot(page, runDir, "01-loaded", screenshots);

    // The form may not be in the top document. SpotHero's careers page
    // carries the description and embeds Greenhouse one frame down.
    const ctx = await resolveFormContext(page, provider);
    formFrame = ctx.frame;
    contextInfo = { kind: ctx.kind, url: ctx.url };
    // The form's origin, not the employer page's, is the one a
    // submission would post to.
    guard.protectOrigin(ctx.url);
    // Re-baseline. Requests blocked before this point were judged
    // against the employer page's origin, not the form's: an embedded
    // application makes the top page's analytics POSTs same-origin under
    // the old policy and cross-origin under the new one. Counting those
    // as submission attempts stopped a run in which nothing had been
    // submitted and nothing had even been filled yet.
    formMark = guard.mark();
    let live = await snapshotLive(ctx.frame);
    if (live.captcha) throw new Stop("CAPTCHA", "a challenge is present; it is never solved or worked around");
    if (live.loginWall) throw new Stop("LOGIN_WALL", `sign in to ${provider} in the browser profile, then re-run`);
    if (live.ssoPrompt) throw new Stop("SSO_PROMPT", "granting access is your decision, not this system's");
    if (live.fields.length === 0) throw new Stop("NO_FORM_FOUND", "no fillable controls are present on this page");

    // -- IDENTIFY -----------------------------------------------------
    const liveAsFields: FormField[] = live.fields.map((f) => ({
      key: f.key, label: f.label, type: f.type, required: f.required, options: f.options,
    }));
    const liveHash = hashSnapshot({ provider, fields: liveAsFields, sensitiveKeys: [], fetchedAt: "" });

    // FORM_CHANGED asks one question: has a required field you reviewed
    // GONE from the page?
    //
    // The reviewed snapshot comes from the board API and the live one
    // from the DOM, and the DOM is always the richer description: it
    // exposes a country selector beside a phone input, a location
    // autocomplete, a label-keyed duplicate of a control with no name.
    // Comparing the two sets in both directions read every Greenhouse
    // form as changed and filled nothing. A control the DOM has and the
    // API does not is not evidence the employer edited anything; it is
    // simply unmapped, and an unmapped REQUIRED control is caught at
    // fill time as a blocked field, which is the honest outcome.
    const storedRequired = new Set(storedFields.filter((f) => f.required).map((f) => f.key));
    const liveKeys = new Set(live.fields.map((f) => f.key));
    const missing = [...storedRequired].filter((k) => !liveKeys.has(k));
    if (missing.length > 0) {
      throw new Stop("FORM_CHANGED",
        `${missing.length} required field(s) you reviewed are no longer on this form`, { missing });
    }
    // A reviewed required field whose options no longer include the
    // answer is the same failure as it disappearing: an answer that is
    // not offered is not an answer.
    for (const stored of storedFields.filter((f) => f.required && (f.options?.length ?? 0) > 0)) {
      const now = live.fields.find((f) => f.key === stored.key);
      if (!now || (now.options?.length ?? 0) === 0) continue;
      const before = new Set((stored.options ?? []).map((o) => o.trim().toLowerCase()));
      const gone = (stored.options ?? []).filter((o) => !(now.options ?? []).some(
        (n) => n.trim().toLowerCase() === o.trim().toLowerCase()));
      const prepared = answers.find((a) => a.fieldKey === stored.key)?.answer;
      if (prepared && gone.some((o) => o.trim().toLowerCase() === prepared.trim().toLowerCase())) {
        throw new Stop("FORM_CHANGED",
          `"${stored.label}" no longer offers the reviewed answer ${JSON.stringify(prepared)}`,
          { field: stored.key, gone });
      }
      if (before.size > 0 && gone.length > before.size / 2) {
        throw new Stop("FORM_CHANGED",
          `"${stored.label}" replaced most of its options since it was reviewed`,
          { field: stored.key, gone });
      }
    }
    for (const f of live.fields) {
      if (f.required && f.unlabelled) {
        throw new Stop("UNLABELLED_REQUIRED_FIELD", `a required control (${f.key}) has no resolvable label`);
      }
    }

    // The reviewed question and the live control are separate things.
    // Greenhouse renders the same field as a native select on its own
    // board and as a react-select combobox inside an embed, so identity
    // is established from provider key, wording or intent, never from
    // control type or position.
    const matches = reconcileAll(live.fields, storedFields);
    const matchFor = new Map(matches.map((m) => [m.live.key, m]));
    for (const m of matches) {
      reconciliation.push({
        field: m.live.label || m.live.key,
        basis: m.basis, apiKey: m.api?.key ?? null,
        controlTypeDiffers: m.controlTypeDiffers, blocked: m.blocked,
      });
    }

    const byApiKey = new Map(answers.filter((a) => a.fieldKey).map((a) => [a.fieldKey!, a]));
    const byKey = new Map<string, PreparedAnswer>();
    for (const m of matches) {
      const a = m.api ? byApiKey.get(m.api.key) : undefined;
      if (a) byKey.set(m.live.key, a);
    }
    // Greenhouse labels both its file inputs "Attach", so the label says
    // nothing about which is the resume. The control's own key does.
    const fileFields = live.fields.filter((f) => f.type === "file");
    let resumeField = fileFields.find((f) => /resume|cv\b/i.test(f.key))
      ?? fileFields.find((f) => /resume|cv\b/i.test(f.label))
      ?? (fileFields.length === 1 ? fileFields[0] : undefined);

    // Provider identity beats whatever the live snapshot captured.
    //
    // Greenhouse renders the two uploads as input#resume and
    // input#cover_letter, carrying no name attribute, hidden behind
    // styled buttons, and both labelled "Attach". Those ids are the same
    // strings the boards API publishes as field names, so they are the
    // one stable link between the reviewed answer and the control.
    //
    // The snapshot does not always capture them. These inputs are
    // React-rendered and a snapshot taken mid-hydration can see the
    // element before its id is set, which leaves the field keyed and
    // selected by its label -- "Attach" on both -- and the upload then
    // fails as ambiguous or resolves to nothing at all. Asking the page
    // directly, at the moment of use, removes that race. Order is never
    // used: two controls that differ only in position are two controls
    // this refuses to tell apart.
    if (provider === "GREENHOUSE") {
      // Wait for it rather than sampling once. The inputs are React-
      // rendered and a count taken before hydration reports zero, which
      // silently leaves the control identified by its label.
      // Wait for the widget, not just the input. Greenhouse mounts the
      // bare input first and its label and buttons a moment later, and a
      // file offered in that window is taken by a control that then
      // re-renders and drops it: the input disappears and nothing
      // acknowledges the file. Waiting for the label means waiting for
      // the uploader to actually be ready to receive one.
      await ctx.frame.locator("input#resume[type=file]")
        .waitFor({ state: "attached", timeout: 15_000 }).catch(() => undefined);
      await ctx.frame.locator('label[for="resume"]')
        .waitFor({ state: "attached", timeout: 15_000 }).catch(() => undefined);
      const byId = await ctx.frame.locator("input#resume[type=file]").count().catch(() => 0);
      if (byId === 1 && resumeField) {
        resumeField = { ...resumeField, key: "resume", selector: "#resume", selectorKind: "id" };
      } else if (byId === 1 && !resumeField) {
        // The snapshot missed it entirely, which is the hydration race
        // described above. The page has it, and its identity is known.
        const shape = live.fields.find((f) => f.type === "file");
        if (shape) resumeField = { ...shape, key: "resume", selector: "#resume", selectorKind: "id" };
      } else if (byId > 1) {
        throw new Stop("SELECTOR_AMBIGUOUS",
          `${byId} elements match input#resume, so the resume control cannot be identified`);
      }
    }

    /**
     * One logical answer, one live control.
     *
     * A snapshot can describe the same element twice: Greenhouse's phone
     * input appears once keyed by its id and once keyed by its label,
     * and both selectors resolve to the identical node. Writing through
     * both put the same value in twice, which is harmless here and is
     * exactly the pattern that stops being harmless when the two entries
     * are NOT the same element.
     *
     * So identity is established structurally, by comparing the resolved
     * DOM nodes, never by comparing labels or values. Same node: an
     * alias, written once. Different nodes carrying the same answer:
     * ambiguous, and the run stops rather than guessing which was meant.
     */
    const writtenNodes: Array<{ key: string; label: string; handle: ElementHandle<Node> }> = [];

    const identifyAgainstWritten = async (
      f: LiveField, handle: ElementHandle<Node>, value: string,
    ): Promise<{ alias: string } | null> => {
      for (const prior of writtenNodes) {
        // Node identity, compared inside the page. Playwright marshals
        // each handle back to the element it points at, so this is a
        // real "are these the same node" test rather than a comparison
        // of anything we chose to describe them with.
        const same = await page.evaluate(
          (pair: any) => pair[0] === pair[1],
          [handle, prior.handle] as any,
        ).catch(() => false);
        if (same) return { alias: prior.label || prior.key };
        // Same question, same answer, different control. One of them is
        // not the field we think it is.
        if ((f.label && f.label === prior.label) && value === (filled.find((x) => x.field === (prior.label || prior.key))?.value)) {
          throw new Stop("SELECTOR_AMBIGUOUS",
            `"${f.label}" resolves to two different controls that would both receive the same answer; which one the form means is not established`,
            { keys: [f.key, prior.key] });
        }
      }
      return null;
    };

    // -- write one field, and read it back ----------------------------
    /**
     * A confirmed answer is what the person said. It is not proof that
     * an arbitrary control accepts it. Where the live control offers
     * choices they are read first, and the answer has to be one of them.
     */
    /** A place-picker, which is matched geographically rather than as text. */
    const locationField = (f: LiveField): boolean =>
      /^candidate-location$/i.test(f.key) || /^location\b/i.test(f.label ?? "");

    const proveAnswerFits = async (f: LiveField, value: string): Promise<string> => {
      const m = matchFor.get(f.key);
      let options: string[] | null = f.options?.length ? f.options : null;

      // A place is not a string, and this is the wrong place to decide it.
      //
      // This ran before the write path and compared "Cleveland, OH" to the
      // offered "Cleveland, Ohio, United States" as text, found no exact
      // equality, and stopped the whole submission — while the write path
      // below already knew how to match a place componentwise. Deciding it
      // here twice, with the weaker rule winning, is what turned a
      // fillable field into a dead run. The write path still proves the
      // answer and still refuses anything but a single exact place.
      if (locationField(f)) return value;

      if (!options && (f.htmlType === "text" || f.type === "text")) {
        const looksCombobox = await (await control(ctx, f))
          .evaluate((el: Element) => el.getAttribute("role") === "combobox"
            || el.getAttribute("aria-haspopup") === "true"
            || el.getAttribute("aria-autocomplete") === "list")
          .catch(() => false);
        if (looksCombobox) {
          const seen = await readLazyOptions(page, ctx.frame, guard, await control(ctx, f), f.label || f.key);
          if (seen.options.length) {
            options = seen.options;
            inspections.push({ field: f.label || f.key, optionsFound: seen.options.length,
              sample: seen.options.slice(0, 3), resolvedAs: "live choices read for answer fitting" });
          }

          // An async type-ahead shows a first page, not its whole list.
          //
          // Greenhouse's school picker offers the first hundred
          // institutions alphabetically and loads the rest only when
          // searched. Concluding from that page that the answer is not
          // offered is a false negative, so the answer is used as the
          // search term and the result is read again.
          //
          // The rules on what may then be chosen are strict, because a
          // search box will happily return near misses: only an exactly
          // equal option counts, the first result means nothing, and
          // more than one exact match is an ambiguity rather than a
          // tie to break.
          // The same answer as this control words it, before concluding
          // it is absent. "Not Hispanic or Latino" is offered here as
          // "No"; searching a closed Yes/No list for the long spelling
          // matches nothing and reported the control as offering none.
          if (options) {
            for (const spelling of equivalents(value)) {
              const hit = exactOptions(options, spelling);
              if (hit.length === 1) { options = hit; value = hit[0]!; break; }
            }
          }

          if (!options || exactOptions(options, value).length !== 1) {
            const filtered = await readFilteredOptions(
              page, ctx.frame, guard, await control(ctx, f), f.label || f.key, value);
            if (filtered.options.length) {
              const hits = exactOptions(filtered.options, value);
              inspections.push({ field: f.label || f.key, optionsFound: filtered.options.length,
                sample: filtered.options.slice(0, 3),
                resolvedAs: `searched for ${JSON.stringify(value)}, ${hits.length} exact match(es)` });
              if (hits.length === 1) {
                options = hits;
              } else if (hits.length > 1) {
                throw new Stop("READBACK_MISMATCH",
                  `"${f.label || f.key}": searching for ${JSON.stringify(value)} returned ${hits.length} identical options, `
                  + "so which one is meant cannot be decided here");
              } else {
                throw new Stop("READBACK_MISMATCH",
                  `"${f.label || f.key}": searching for ${JSON.stringify(value)} returned no exact match `
                  + `(offers ${filtered.options.slice(0, 6).join(", ")}${filtered.options.length > 6 ? ", ..." : ""})`);
              }
            }
          }
        }
      }

      const fit = answerFitsControl(value, f, m?.api ?? null, options);
      if (!fit.ok) throw new Stop("READBACK_MISMATCH", `"${f.label || f.key}": ${fit.why}`);
      return fit.value;
    };

    const write = async (f: LiveField, rawValue: string): Promise<void> => {
      const value = await proveAnswerFits(f, rawValue);
      const c = await control(ctx, f);
      const handle = await c.elementHandle();
      if (handle) {
        const alias = await identifyAgainstWritten(f, handle, value);
        if (alias) {
          aliases.push({ field: f.label || f.key, sameAs: alias.alias });
          return;
        }
        writtenNodes.push({ key: f.key, label: f.label, handle });
      }
      const isCombobox = await c.evaluate((el: Element) =>
        el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list")
        .catch(() => false);

      const isLocation = locationField(f);

      if (isCombobox && isLocation) {
        // A place, not a string.
        //
        // The profile says "Cleveland, OH, US" and this control offers
        // "Cleveland, Ohio, United States". Typing the profile's form
        // returns no options at all, so the old path left the typed text
        // sitting uncommitted: the field ended up empty and the form
        // said "Please enter your location" with the resume attached
        // above it.
        //
        // The list this returns is a minefield. Searching "Cleveland"
        // offers City of Cleveland, Cleveland Ohio, Cleveland Tennessee,
        // Cleveland Heights, East Cleveland and Cleveland Mississippi.
        // Taking the first, or matching on substring, picks a different
        // real municipality and states something untrue about where he
        // lives. So the search term is the place name, and the option is
        // chosen by componentwise geographic equality.
        const term = geoSearchTerm(value);
        await c.click({ timeout: 8000 });
        await fillText(c, term);

        let offered: string[] = [];
        for (let attempt = 0; attempt < 20; attempt++) {
          await page.waitForTimeout(600);
          offered = await optionsForControl(ctx.frame, f.selector);
          if (offered.length) break;
        }
        // Exact equality first. Only if the answer states less than the
        // options do is the profile allowed to supply the remainder, and
        // only components the profile independently states.
        let hits = exactGeoMatches(offered, value);
        let how = "exact";
        if (hits.length === 0) {
          const prof = (resolveContext as any)?.profile ?? {};
          hits = qualifiedGeoMatches(offered, value, { state: prof.state, country: prof.country });
          how = "qualified by profile state/country";
        }
        inspections.push({ field: f.label || f.key, optionsFound: offered.length,
          sample: offered.slice(0, 3),
          resolvedAs: `searched ${JSON.stringify(term)}, ${hits.length} geographic match(es) [${how}]`,
          allOptions: offered });

        if (hits.length !== 1) {
          throw new Stop("READBACK_MISMATCH",
            `"${f.label || f.key}": searching ${JSON.stringify(term)} gave ${hits.length} places equal to `
            + `${JSON.stringify(value)}. The control offered: ${offered.join(" | ") || "(nothing)"}`);
        }
        await clickOptionWithin(ctx.frame.locator("body"), hits[0]!);
        await page.waitForTimeout(600);
        // Commit is what matters, so leave the control and read what it
        // kept. react-select stores the chosen value in its own node;
        // the input goes empty and proves nothing either way.
        await page.keyboard.press("Tab").catch(() => undefined);
        await page.waitForTimeout(600);
        const held = await committedValue(ctx.frame, f.selector);
        // Read back against the option that was actually clicked, not
        // against the answer. The answer may legitimately state less than
        // the control does -- "Cleveland, OH" against a control that only
        // speaks in "Cleveland, Ohio, United States" -- and comparing to
        // it failed a field that was holding precisely the right place.
        // hits[0] is not a weaker standard: it was already proved to be
        // the single option equal to the answer, so requiring the control
        // to hold exactly that is the strictest check available here.
        if (!held || !sameGeography(held, hits[0]!)) {
          throw new Stop("READBACK_MISMATCH",
            `"${f.label || f.key}" holds ${JSON.stringify(held ?? "")} after selecting ${JSON.stringify(hits[0])}; `
            + "the location was not committed");
        }
        filled.push({ field: f.label || f.key, value: held });
        return;
      }

      if (isCombobox) {
        // Open it, narrow it, and choose the option that was already
        // proven to exist. clickOptionWithin is scoped to descendants of
        // this control and cannot reach a page-level button.
        await c.click({ timeout: 8000 });
        await fillText(c, value);
        await page.waitForTimeout(600);
        await clickOptionWithin(ctx.frame.locator("body"), value).catch(async () => {
          await page.keyboard.press("Enter");
        });
        await page.waitForTimeout(400);
      } else if (f.type === "select") {
        await selectOption(c, value);
      } else if (f.type === "boolean") {
        await setChecked(c, /^(yes|true|i acknowledge|acknowledge)$/i.test(value));
      } else {
        await fillText(c, value);
        const got = await readBack(c);
        if (!isCombobox && got.trim() !== value.trim()) {
          throw new Stop("READBACK_MISMATCH",
            `"${f.label}" holds ${JSON.stringify(got.slice(0, 60))} after writing ${JSON.stringify(value.slice(0, 60))}`);
        }
      }
      filled.push({ field: f.label || f.key, value });
    };

    /**
     * Fills everything independently supported, then stops.
     *
     * An unresolved required field does NOT halt filling. Stopping at
     * the first one left a barely-filled form when every other field was
     * answerable, and a half-filled form is worse for the person who has
     * to finish it. So unresolved required controls are COLLECTED, every
     * independently supported field is filled and read back, and the run
     * ends on REQUIRED_FIELD_BLOCKED naming all of them.
     *
     * Two things that must not happen anyway: a field whose meaning
     * depends on an unresolved control is never filled, and no step is
     * ever advanced while anything required is unresolved.
     */
    const fillAll = async (): Promise<void> => {
      const unresolved: LiveField[] = [];
      const deferred: Array<{ f: LiveField; a: PreparedAnswer }> = [];
      const done = new Set<string>();

      // First pass: decide the status of every control, and collect the
      // unresolved required ones before filling anything, so dependency
      // is judged against the complete picture rather than in field order.
      for (const f of live.fields) {
        if (f.type === "file") continue;
        let a = byKey.get(f.key);

        // A control the reviewed snapshot never mentioned. Resolve it
        // now, against the same frozen evidence, rather than treating
        // "discovered late" as "unanswerable".
        if (!a && resolveContext) {
          const r = resolveField(
            { key: f.key, label: f.label, type: f.type, required: f.required, options: f.options },
            resolveContext,
          );

          // A bare "Country" control on a form that also carries a
          // telephone input is ambiguous, and answering it from the
          // residence country is the conflation this system is not
          // allowed to make. Greenhouse's dial-code selector is a
          // combobox with no <option> elements, so the options test that
          // normally identifies it sees nothing, and the label alone
          // says only "Country".
          //
          // This is decided here rather than in the resolver because
          // only the browser sees the whole live form. Over-blocking is
          // the safe direction: a person answers it in a second, and a
          // wrong calling country is a wrong phone number.
          const looksResidence = /\b(residence|reside|live|home|mailing|address|citizenship)\b/i.test(f.label);
          const formHasTelephone = live.fields.some((x) => x.htmlType === "tel");
          if (r.intentKey === "country" && !looksResidence && formHasTelephone && (f.options ?? []).length === 0) {
            // The options exist, they are just not rendered yet. Look,
            // without choosing anything, and let what the control
            // actually offers settle what it is.
            const inspected = await readLazyOptions(page, ctx.frame, guard, await control(ctx, f), f.label || f.key);
            if (inspected.options.length > 0) {
              const withOptions = { key: f.key, label: f.label, type: f.type, required: f.required, options: inspected.options };
              const r2 = resolveField(withOptions, resolveContext);
              inspections.push({ field: f.label || f.key, optionsFound: inspected.options.length,
                sample: inspected.options.slice(0, 3), resolvedAs: r2.intentKey ?? "unmatched" });
              if (r2.confidence !== "BLOCKED" && r2.answer !== null) {
                a = { fieldKey: f.key, fieldLabel: f.label, answer: r2.answer,
                      confidence: r2.confidence, isRequired: f.required };
                resolvedLive.push({ field: f.label || f.key, answer: r2.answer, confidence: r2.confidence });
                // The options identify it; fall through and fill it.
                live.fields[live.fields.indexOf(f)] = { ...f, options: inspected.options };
                deferred.push({ f: { ...f, options: inspected.options }, a });
                continue;
              }
              leftBlank.push({ field: f.label || f.key, why: r2.blockedReason ?? "its options did not identify it" });
              if (f.required) unresolved.push(f);
              continue;
            }
            leftBlank.push({
              field: f.label || f.key,
              why: "a bare \"Country\" control beside a telephone input, and inspecting it revealed no options: this may be the phone's calling country rather than residence, and the two are never assumed to be the same",
            });
            if (f.required) unresolved.push(f);
            continue;
          }

          if (r.confidence !== "BLOCKED" && r.answer !== null) {
            a = { fieldKey: f.key, fieldLabel: f.label, answer: r.answer,
                  confidence: r.confidence, isRequired: f.required };
            resolvedLive.push({ field: f.label || f.key, answer: r.answer, confidence: r.confidence });
          } else {
            leftBlank.push({ field: f.label || f.key, why: r.blockedReason ?? "could not be resolved from the profile" });
            if (f.required) unresolved.push(f);
            continue;
          }
        }

        if (!a) {
          const why = storedFields.some((s) => s.key === f.key)
            ? "no prepared answer maps to this control"
            : "required on the page but not in the reviewed snapshot";
          leftBlank.push({ field: f.label || f.key, why });
          if (f.required) unresolved.push(f);
          continue;
        }
        if (!FILLABLE.has(a.confidence)) {
          leftBlank.push({ field: f.label || f.key, why: `${a.confidence}: never filled` });
          if (a.isRequired || f.required) unresolved.push(f);
          continue;
        }
        if (a.answer === null) {
          leftBlank.push({ field: f.label || f.key, why: "you chose to leave this blank" });
          continue;
        }
        deferred.push({ f, a });
      }

      // Second pass: fill what is independently supported.
      for (let i = 0; i < deferred.length; i++) {
        const { f, a } = deferred[i]!;
        if (done.has(f.key)) continue;
        const blocker = dependsOnUnresolved(f, unresolved);
        if (blocker) {
          leftBlank.push({
            field: f.label || f.key,
            why: `depends on "${blocker.label || blocker.key}", which is required and unresolved`,
          });
          continue;
        }
        await write(f, a.answer!);
        done.add(f.key);

        // Filling can change the form. Re-read, and if the shape moved,
        // work from what is on the page now rather than from a stale
        // description of it.
        await assertContextIntact(ctx);
        const after = await snapshotLive(ctx.frame);
        const beforeKeys = new Set(live.fields.map((x) => x.key));
        const appeared = after.fields.filter((x) => !beforeKeys.has(x.key));
        if (appeared.length > 0) {
          live = after;
          for (const n of appeared) {
            if (n.type === "file") continue;
            const na = byKey.get(n.key);
            if (!na || !FILLABLE.has(na.confidence) || na.answer === null) {
              leftBlank.push({
                field: n.label || n.key,
                why: na ? `${na.confidence}: never filled` : "appeared after filling and has no prepared answer",
              });
              if (n.required) unresolved.push(n);
              continue;
            }
            deferred.push({ f: n, a: na });
          }
        }
      }

      if (unresolved.length > 0) {
        throw new Stop("REQUIRED_FIELD_BLOCKED",
          `${unresolved.length} required field(s) could not be answered: ` +
          unresolved.map((u) => `"${u.label || u.key}"`).join(", "),
          { unresolved: unresolved.map((u) => u.label || u.key) });
      }
    };

    // -- UPLOAD and RECONCILE, ordered by measured behaviour ----------
    const doUpload = async (): Promise<void> => {
      if (!resumeField || !resumePdfPath) return;
      // Acknowledgement is read from the input itself rather than from
      // page text: this uploader renders no filename, and a form that
      // does not say so is not thereby a form that did not attach.
      const { readFile } = await import("node:fs/promises");
      const { createHash } = await import("node:crypto");
      const bytes = await readFile(resumePdfPath);
      const basename = resumePdfPath.split("/").pop()!;
      attachment = await attachResume({
        page, frame: ctx.frame, field: resumeField, path: resumePdfPath,
        expectedName: basename, expectedBytes: bytes.length,
        expectedSha256: createHash("sha256").update(bytes).digest("hex"),
      });
      await page.waitForTimeout(1200);
      await shot(page, runDir, "02-uploaded", screenshots);
    };

    /** What the ATS put in fields after parsing our resume. */
    const readAll = async (): Promise<Map<string, string>> => {
      const snap = await snapshotLive(ctx.frame);
      const out = new Map<string, string>();
      for (const f of snap.fields) {
        if (f.type === "file" || !f.selector) continue;
        const c = await control(ctx, f).catch(() => null);
        if (!c) continue;
        const v = await c.inputValue().catch(() => "");
        if (v) out.set(f.key, v);
      }
      return out;
    };

    if (uploadFirst(behaviour)) {
      await doUpload();
      live = await snapshotLive(ctx.frame);
      const parsed = await readAll();

      for (const [key, parsedValue] of parsed) {
        const a = byKey.get(key);
        const field = live.fields.find((f) => f.key === key);
        const label = field?.label || key;

        if (!a) {
          // The employer's own reading of a resume we wrote. Not a claim
          // this system is making, and blanking it would be an edit
          // nobody asked for.
          reconciliation2.push({ field: label, parsed: parsedValue, prepared: null, action: "left as parsed, reported" });
          continue;
        }
        if (a.confidence === "BLOCKED") {
          throw new Stop("PARSER_FILLED_BLOCKED_FIELD",
            `the ATS filled "${label}" from the resume, but that field's answer is BLOCKED`,
            { field: label, parsed: parsedValue });
        }
        if (a.answer !== null && parsedValue.trim() !== a.answer.trim()) {
          reconciliation2.push({ field: label, parsed: parsedValue, prepared: a.answer, action: "overwritten with the prepared answer" });
        } else {
          reconciliation2.push({ field: label, parsed: parsedValue, prepared: a.answer, action: "matched" });
        }
      }
      // Evidence, recorded whether or not the parser did anything. Under
      // upload-first ordering "moved" means the parser populated a field
      // that was empty, since nothing had been filled yet.
      await recordObservation(db, provider, {
        fieldsMoved: [...parsed.keys()],
        fieldsChecked: live.fields.filter((f) => f.type !== "file").length,
      });
      await fillAll();
    } else {
      // Treated as inert, and measured. If anything moves after the
      // upload, that is the first evidence this provider parses, and it
      // is recorded rather than worked around.
      await fillAll();
      const before = await readAll();
      await doUpload();
      const after = await readAll();
      const moved: string[] = [];
      for (const [k, v] of before) if ((after.get(k) ?? "") !== v) moved.push(k);
      await recordObservation(db, provider, { fieldsMoved: moved, fieldsChecked: before.size });
      if (moved.length > 0) {
        throw new Stop("PARSER_BEHAVIOUR_LEARNED",
          `${provider} rewrote ${moved.length} field(s) after the resume upload; recorded, re-run to fill in the correct order`,
          { moved });
      }
    }

    // -- education is a list, not a field -----------------------------
    //
    // The section carries an "Add another" button, and the first row is
    // not the whole of it: filling row 0 and stopping recorded one
    // degree for someone who holds two. Each further verified record
    // gets its own row, in the order the profile holds them.
    //
    // A row is added only when BOTH its school and its degree resolve to
    // exactly one offered option. Adding a row and leaving a required
    // control in it empty makes the form invalid, which is worse than
    // recording one degree, so an unresolvable record is reported and
    // skipped rather than half-entered. Nothing is substituted: a school
    // the board does not list is a school this cannot enter.
    if (provider === "GREENHOUSE" && educationRecords.length > 1) {
      const addAnother = ctx.frame.locator("button.add-another-button");
      const canRepeat = await addAnother.count().catch(() => 0);

      for (let row = 1; row < educationRecords.length; row++) {
        const rec = educationRecords[row]!;
        if (!canRepeat) {
          leftBlank.push({ field: `Education ${row + 1}`,
            why: `the form offers no way to add a second education entry, so ${rec.institution} is not recorded` });
          continue;
        }

        // Resolve BEFORE touching the form, so a record that cannot be
        // entered never creates an empty row.
        const lookup = input.schoolOptionsFor
          ?? ((i: string) => greenhouseSchoolOptions(provider, boardToken, i));
        const schools = await lookup(rec.institution);
        const schoolHit = exactOptions(schools, rec.institution);
        const degreeHit = exactOptions(degreeOptions, rec.degree);

        if (schoolHit.length !== 1 || degreeHit.length !== 1) {
          leftBlank.push({ field: `Education ${row + 1}`,
            why: schoolHit.length !== 1
              ? `${JSON.stringify(rec.institution)} is not offered by this board's school list `
                + `(${schools.length} results for that search), so the entry is not recorded rather than substituted`
              : `${JSON.stringify(rec.degree)} is not one of the offered degrees (${degreeOptions.join(", ")})` });
          continue;
        }

        await addAnother.first().click({ timeout: 8000 });
        await page.waitForTimeout(1200);
        const after = await snapshotLive(ctx.frame);
        const schoolField = after.fields.find((f) => f.key === `school--${row}`);
        const degreeField = after.fields.find((f) => f.key === `degree--${row}`);
        if (!schoolField || !degreeField) {
          leftBlank.push({ field: `Education ${row + 1}`,
            why: "adding a row did not produce the expected school and degree controls" });
          continue;
        }
        await write(schoolField, schoolHit[0]!);
        await write(degreeField, degreeHit[0]!);
      }
    }

    // -- the form is not the form it was when we started --------------
    //
    // Answering can create controls. Selecting "No" on Stripe's
    // "Are you Hispanic/Latino?" renders "Please identify your race",
    // which no snapshot could contain because it did not exist when the
    // snapshot was taken. Reconciling once and treating that as the
    // whole form left a control the applicant can see and the filler
    // never knew about.
    //
    // So the page is rescanned until a pass finds nothing new. Each new
    // control is resolved through the SAME resolver and the same four
    // confidence states; nothing is relaxed because a field arrived
    // late, and a demographic control with no reviewed answer is left
    // alone rather than guessed at.
    //
    // Bounded on purpose. A form that keeps producing controls is a form
    // this stops on rather than one it chases forever.
    // Keyed on "still empty", not on "newly seen".
    //
    // Tracking only unseen keys missed the case that motivated this: the
    // race control appears the moment the ethnicity question is
    // answered, so an earlier re-snapshot had already seen it and
    // recorded it as unanswerable. It was known about and still blank,
    // which is the state that matters.
    const attempted = new Set<string>();
    for (const pass of [1, 2, 3, 4]) {
      await page.waitForTimeout(900);
      await assertContextIntact(ctx);
      const now = await snapshotLive(ctx.frame);

      const fresh: LiveField[] = [];
      for (const f of now.fields) {
        if (f.type === "file" || attempted.has(f.key) || !f.selector) continue;
        const held = await committedValue(ctx.frame, f.selector).catch(() => null);
        const typed = await ctx.frame.locator(f.selector).inputValue().catch(() => "");
        if ((held ?? "").trim() || (typed ?? "").trim()) continue;
        fresh.push(f);
      }
      if (!fresh.length) break;

      for (const f of fresh) {
        // A reviewed answer for this exact control, if the package has
        // one. Approved answers first; the resolver only where it does
        // not.
        const reviewed = byApiKey.get(f.key);
        let value: string | null = reviewed && FILLABLE.has(reviewed.confidence) ? reviewed.answer : null;
        let confidence = reviewed?.confidence ?? null;

        if (value === null && resolveContext) {
          const withOptions: FormField = {
            key: f.key, label: f.label, type: f.type as FormField["type"],
            required: f.required, options: f.options?.length ? f.options : undefined,
          };
          const r = resolveField(withOptions, resolveContext);
          if (r.confidence !== "BLOCKED" && r.answer !== null) { value = r.answer; confidence = r.confidence; }
        }

        attempted.add(f.key);
        if (value === null) continue;   // already reported by the main pass

        resolvedLive.push({ field: f.label || f.key, answer: value, confidence: confidence ?? "DERIVED" });
        await write(f, value);
        // It is answered now, so drop the earlier "left blank" note.
        const stale = leftBlank.findIndex((b) => b.field === (f.label || f.key));
        if (stale >= 0) leftBlank.splice(stale, 1);
      }
      if (pass === 4 && fresh.length) {
        throw new Stop("FORM_CHANGED",
          "the form kept producing new controls after four passes; it is changing faster than it can be filled");
      }
    }

    // -- guards must not have fired anywhere along the way ------------
    if (await guard.sawSubmissionAttemptSince(ctx.frame, formMark)) {
      throw new Stop("SUBMISSION_ATTEMPT_BLOCKED", "a submission was attempted and blocked during filling");
    }

    await shot(page, runDir, "03-filled", screenshots);
    return await finish(HANDOFF, "the form is filled and waiting for you; the submit control was not touched");
  } catch (e) {
    const stop = e instanceof Stop ? e : new Stop("BROWSER_ERROR", (e as Error).message);
    await shot(page, runDir, `99-stop-${stop.reason}`, screenshots).catch(() => undefined);
    return await finish(stop.reason, stop.message);
  } finally {
    // The browser is never closed. You see the state it reached, and a
    // released page behaves normally so you can finish or submit.
    await guard.handoff(page).catch(() => undefined);
  }
}
