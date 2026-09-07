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
import { exactlyOne, fillText, fillTextCommitting, verifyCommitted, readBack, readAshbyCommitted, selectOption, setChecked, setFiles, clickOptionWithin, shouldReattempt } from "./actions.ts";
import { readLazyOptions, readFilteredOptions, exactOptions } from "./inspectCombobox.ts";
import { geoSearchTerm, exactGeoMatches, qualifiedGeoMatches, sameGeography } from "./geography.ts";
import { matchCountryOption } from "../applications/workCountry.ts";
import { isDemographicField, resolveEeoOption } from "./eeo.ts";
import { reconcileAll, answerFitsControl, type Reconciled } from "./reconcile.ts";
import { attachResume, type AttachmentEvidence } from "./upload.ts";
import {
  revealAshbyForm, ashbyMultiStep, readChoiceFieldsets, groupAshbyChoices,
  mergeChoiceGroups, dropFileHeaderArtifacts, chooseSingleOption, verifySingleSelected,
  readAshbyComboboxes, markAshbyComboboxes, readAshbyButtonGroups, mergeAshbyButtonGroups,
  waitForAshbyHydration,
} from "./ashbyForm.ts";
import { behaviourOf, recordObservation, uploadFirst, type Behaviour } from "./parserBehaviour.ts";
import { hashSnapshot } from "../applications/formSnapshot.ts";
import { resolveField, equivalents, institutionSpellings, disciplineSpellings, type FormField, type ResolveContext } from "../applications/answer.ts";

export const FILL_VERSION = 1;

export interface PreparedAnswer {
  fieldKey: string | null;
  fieldLabel: string;
  answer: string | null;
  confidence: "VERIFIED" | "DERIVED" | "HUMAN_CONFIRMED" | "LOW_STAKES_SURVEY" | "AI_DRAFTED_GROUNDED" | "BLOCKED";
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

const FILLABLE = new Set(["VERIFIED", "DERIVED", "HUMAN_CONFIRMED", "LOW_STAKES_SURVEY", "AI_DRAFTED_GROUNDED"]);

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

/**
 * A control that asks which institution someone attended. Greenhouse keys
 * its education rows school--N; elsewhere the label says so. Only such a
 * field is offered the institution-level spelling of a school record.
 */
const institutionField = (f: { key: string; label?: string | null }): boolean =>
  /^school--\d+$/.test(f.key) || /\b(school|university|college|institution|alma mater)\b/i.test(f.label ?? "");

/** A control that asks what was studied: Greenhouse's discipline--N, or a label that says so. */
const disciplineField = (f: { key: string; label?: string | null }): boolean =>
  /^discipline--\d+$/.test(f.key) || /\b(discipline|field of study|major|area of study|concentration)\b/i.test(f.label ?? "");

/** Every spelling this control may offer for the answer (see equivalents, institutionSpellings, disciplineSpellings). */
function spellingsFor(f: { key: string; label?: string | null }, value: string): string[] {
  const extra = institutionField(f) ? institutionSpellings(value) : disciplineField(f) ? disciplineSpellings(value) : [];
  return [...new Set([...equivalents(value), ...extra])];
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
  // Every field label the main pass iterated, filled or not. The
  // rescan uses it to tell a rerendered field (same label, seen
  // already) from a genuinely new dynamic one (label never seen).
  const processedLabels = new Set<string>();
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
    // Ashby loads its form with same-origin GraphQL POSTs
    // (/api/non-user-graphql). Layer 3 of the guard aborts non-GET requests
    // to the form origin while armed, so arming BEFORE the load aborts those
    // and the form never renders. For Ashby the request-blocking layer is
    // therefore armed AFTER the form has loaded, below. This is a timing
    // change, not a weakening: layer 2 -- the capture-phase submit-event
    // cancel and the programmatic form.submit()/requestSubmit() block, which
    // is the layer that actually carries the no-submission guarantee -- is
    // installed on the context and active throughout, load included; and
    // layer 3 then guards the ENTIRE fill phase, Ashby's own submit endpoint
    // included. The only window it is off is the pristine load, when nothing
    // is filled and nothing is clicked. Every other provider arms as before.
    const armLayer3Early = provider !== "ASHBY";
    if (armLayer3Early) guard.arm(applyUrl);
    await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    await shot(page, runDir, "01-loaded", screenshots);

    // Ashby renders the form only after "Apply for this Job" is pressed, so
    // reveal it before the form context is resolved -- otherwise the top
    // document has no controls and resolves to NO_FORM_FOUND. Pressing that
    // one control reveals fields; it never submits. Shared with preparation.
    if (provider === "ASHBY") {
      await revealAshbyForm(page);
      // Do not fill until react-hook-form has attached: a fill before
      // hydration sets DOM values the form's state never sees, and every
      // field submits as "missing" while visibly filled.
      await waitForAshbyHydration(page);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
      await page.waitForTimeout(800);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
    }

    // The form may not be in the top document. SpotHero's careers page
    // carries the description and embeds Greenhouse one frame down.
    const ctx = await resolveFormContext(page, provider);
    formFrame = ctx.frame;
    contextInfo = { kind: ctx.kind, url: ctx.url };
    // The form's origin, not the employer page's, is the one a
    // submission would post to.
    guard.protectOrigin(ctx.url);
    // Ashby: the form has now loaded, so arm the request-blocking layer for
    // the whole fill phase that follows (snapshot, fill, read-back, up to the
    // handoff disarm). Layer 2 has been guarding since the context was built.
    if (!armLayer3Early) guard.arm(ctx.url);
    // Re-baseline. Requests blocked before this point were judged
    // against the employer page's origin, not the form's: an embedded
    // application makes the top page's analytics POSTs same-origin under
    // the old policy and cross-origin under the new one. Counting those
    // as submission attempts stopped a run in which nothing had been
    // submitted and nothing had even been filled yet.
    formMark = guard.mark();

    // Every discovery snapshot goes through here so the Ashby normalization
    // -- the SAME shared grouping preparation used -- is applied not only to
    // the first read but to every re-read during filling. Filling reveals
    // controls (a choice appears after an earlier answer), and a raw
    // re-snapshot would rediscover Ashby's choice options UNGROUPED, drop the
    // grouped questions the snapshot was reviewed against, and leave them
    // unfilled. One definition, one code path, every read.
    const snapForm = async () => {
      const s = await snapshotLive(ctx.frame);
      if (provider !== "ASHBY") return s;
      const grouping = groupAshbyChoices(await readChoiceFieldsets(page));
      let fields = mergeChoiceGroups(dropFileHeaderArtifacts(s.fields), grouping);
      fields = markAshbyComboboxes(fields, await readAshbyComboboxes(page));
      fields = mergeAshbyButtonGroups(fields, await readAshbyButtonGroups(page));
      return { ...s, fields };
    };
    let live = await snapForm();
    if (live.captcha) throw new Stop("CAPTCHA", "a challenge is present; it is never solved or worked around");
    if (live.loginWall) throw new Stop("LOGIN_WALL", `sign in to ${provider} in the browser profile, then re-run`);
    if (live.ssoPrompt) throw new Stop("SSO_PROMPT", "granting access is your decision, not this system's");
    if (live.fields.length === 0) throw new Stop("NO_FORM_FOUND", "no fillable controls are present on this page");
    // A multi-step Ashby form we cannot safely progress fails closed rather
    // than filling one page of many.
    if (provider === "ASHBY" && await ashbyMultiStep(page)) {
      throw new Stop("AMBIGUOUS_NAVIGATION",
        "this Ashby application is multi-step, which is not supported for assisted submission; finish it by hand");
    }

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

      // A checkbox group decides its own option, once, below. Fitting
      // the answer to the group's option list here would mean matching
      // "United States" against a list that spells it "US" and stopping
      // before the code that knows how to map the two ever runs.
      if (f.htmlType === "checkbox-group") return value;

      // An Ashby single-select group likewise decides its own option in the
      // write path (exact offered match), so it is not fitted here.
      if (f.htmlType === "radio-group") return value;
      // An Ashby combobox reads its own live options and matches there.
      if (f.htmlType === "ashby-combobox") return value;

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
          // For a school field, the institution itself is one more spelling
          // (see institutionSpellings): "Western Governors University,
          // Leavitt School of Health" is entered as "Western Governors
          // University" when that is what the board lists.
          const spellings = spellingsFor(f, value);
          if (options) {
            for (const spelling of spellings) {
              const hit = exactOptions(options, spelling);
              if (hit.length === 1) { options = hit; value = hit[0]!; break; }
            }
          }

          // A demographic self-ID field is matched to the employer's own
          // vocabulary: the exact option, then a standard synonym
          // (Male -> Man), then the form's decline-to-answer option.
          // Only for a field recognised as demographic; everything else
          // still requires an exact match and fails closed below.
          if (options && isDemographicField(f.label || f.key) && exactOptions(options, value).length !== 1) {
            const choice = resolveEeoOption(value, options, f.label || f.key);
            if (choice.kind !== "NONE") {
              inspections.push({ field: f.label || f.key, optionsFound: options.length,
                sample: options.slice(0, 3),
                resolvedAs: `demographic ${choice.kind.toLowerCase()}: ${JSON.stringify(value)} -> ${JSON.stringify(choice.option)}` });
              options = [choice.option];
              value = choice.option;
            }
          }

          if (!options || exactOptions(options, value).length !== 1) {
            // Each spelling is a search of its own: the type-ahead returns
            // nothing at all for a string it does not know, so a later
            // spelling can only be tried by asking again.
            const asked = value;
            let resolved = false;
            let lastOffered: string[] = [];
            for (const term of spellings) {
              const filtered = await readFilteredOptions(
                page, ctx.frame, guard, await control(ctx, f), f.label || f.key, term);
              if (!filtered.options.length) continue;
              lastOffered = filtered.options;
              const hits = exactOptions(filtered.options, term);
              inspections.push({ field: f.label || f.key, optionsFound: filtered.options.length,
                sample: filtered.options.slice(0, 3),
                resolvedAs: `searched for ${JSON.stringify(term)}, ${hits.length} exact match(es)` });
              if (hits.length > 1) {
                throw new Stop("READBACK_MISMATCH",
                  `"${f.label || f.key}": searching for ${JSON.stringify(term)} returned ${hits.length} identical options, `
                  + "so which one is meant cannot be decided here");
              }
              if (hits.length === 1) {
                if (term !== asked) {
                  inspections.push({ field: f.label || f.key, optionsFound: 1, sample: hits,
                    resolvedAs: `${JSON.stringify(asked)} is not offered; entered as ${JSON.stringify(hits[0])}` });
                }
                options = hits; value = hits[0]!; resolved = true;
                break;
              }
            }
            if (!resolved && lastOffered.length) {
              throw new Stop("READBACK_MISMATCH",
                `"${f.label || f.key}": searching for ${JSON.stringify(asked)} returned no exact match `
                + `(offers ${lastOffered.slice(0, 6).join(", ")}${lastOffered.length > 6 ? ", ..." : ""})`);
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

      /**
       * An Ashby single-select group is one question with one radio per
       * option. The answer must be one of the offered options exactly; the
       * option's OWN selector is clicked (Ashby gives each a unique name),
       * never the group's; and read-back requires that exactly one option in
       * the group is selected and it is the chosen one. A styled radio that
       * hides its native input is checked via its label, but the read-back
       * is what proves the state either way.
       */
      if (f.htmlType === "radio-group") {
        const offered = f.options ?? [];
        const chosen = chooseSingleOption(offered, value);
        inspections.push({ field: f.label || f.key, optionsFound: offered.length,
          sample: offered.slice(0, 3), allOptions: offered,
          resolvedAs: chosen.ok ? `matched ${JSON.stringify(chosen.option)}` : chosen.why });
        if (!chosen.ok) {
          throw new Stop("READBACK_MISMATCH", `"${f.label || f.key}": ${chosen.why}`);
        }
        const sel = f.optionSelectors?.[chosen.option];
        if (!sel) {
          throw new Stop("SELECTOR_AMBIGUOUS",
            `"${f.label || f.key}": ${JSON.stringify(chosen.option)} has no selector of its own`);
        }
        const box = ctx.frame.locator(sel);
        const cnt = await box.count();
        if (cnt !== 1) {
          throw new Stop("SELECTOR_AMBIGUOUS", `"${f.label || f.key}": ${JSON.stringify(sel)} matched ${cnt} controls`);
        }
        if (!(await box.isChecked().catch(() => false))) {
          await box.check({ timeout: 8000 }).catch(async () => {
            const id = await box.getAttribute("id").catch(() => null);
            if (id) await ctx.frame.locator(`label[for="${id}"]`).click({ timeout: 8000 }).catch(() => {});
            else await box.click({ force: true, timeout: 8000 }).catch(() => {});
          });
        }
        await page.waitForTimeout(300);
        const state = await ctx.frame.evaluate((sels: Record<string, string>) =>
          Object.fromEntries(Object.entries(sels).map(([label, s]) =>
            [label, Boolean((document.querySelector(s) as HTMLInputElement | null)?.checked)])),
          f.optionSelectors ?? {});
        const rb = verifySingleSelected(state, chosen.option);
        if (!rb.ok) {
          throw new Stop("READBACK_MISMATCH",
            `"${f.label || f.key}" reads back as ${rb.ticked.length ? rb.ticked.join(" + ") : "nothing selected"} `
            + `after selecting ${JSON.stringify(chosen.option)}`);
        }
        filled.push({ field: f.label || f.key, value: chosen.option });
        return;
      }

      /**
       * An Ashby anonymous react-select combobox (location or demographic
       * self-ID). It has no id/name/label, so it is reached by anchoring to
       * the ONE field container holding this question and the ONE combobox
       * inside it -- both must be unique or the run fails closed. The menu's
       * options are read from the live rendered listbox and the answer must
       * be one of them exactly, or an equivalence our existing resolvers
       * already sanction: geographic equality for a location field, the EEO
       * option map for a demographic field (which never infers an answer --
       * only a HUMAN_CONFIRMED value reaches here). Read-back confirms the
       * control committed the chosen option.
       */
      if (f.htmlType === "ashby-combobox") {
        const container = ctx.frame.locator('[class*="_fieldEntry_"], [class*="ashby-application-form-field"]')
          .filter({ hasText: f.label });
        const cc = await container.count();
        if (cc !== 1) {
          throw new Stop("SELECTOR_AMBIGUOUS", `"${f.label}": ${cc} Ashby field containers match this question, so the control is not uniquely identified`);
        }
        const combo = container.locator("[role=combobox]");
        const nc = await combo.count();
        if (nc !== 1) {
          throw new Stop("SELECTOR_AMBIGUOUS", `"${f.label}": ${nc} comboboxes in its container`);
        }
        const isLoc = /\b(city|town|location|residence|reside|current city|metro|country|state|province)\b/i.test(f.label);
        const term = isLoc ? geoSearchTerm(value) : value;
        await combo.click({ timeout: 8000 });
        await combo.fill("").catch(() => undefined);
        await combo.type(term, { delay: 30 });
        // The single open listbox is this combobox's (only one is open at a
        // time). More than one, or none, and the menu cannot be tied back to
        // the question: fail closed rather than read the wrong list.
        let offered: string[] = [];
        for (let attempt = 0; attempt < 20; attempt++) {
          await page.waitForTimeout(400);
          offered = await ctx.frame.evaluate(() => {
            const boxes = Array.from(document.querySelectorAll("[role=listbox]"))
              .filter((b) => (b as HTMLElement).getClientRects().length > 0);
            if (boxes.length !== 1) return [];
            return Array.from(boxes[0]!.querySelectorAll("[role=option]"))
              .map((o) => (o.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
          });
          if (offered.length) break;
        }
        inspections.push({ field: f.label || f.key, optionsFound: offered.length, sample: offered.slice(0, 3),
          allOptions: offered, resolvedAs: `ashby combobox (${isLoc ? "location" : isDemographicField(f.label) ? "demographic" : "exact"})` });
        if (!offered.length) {
          throw new Stop("READBACK_MISMATCH", `"${f.label}": the Ashby combobox offered no options for ${JSON.stringify(term)}`);
        }
        let chosen: string | null = null;
        let why = "";
        if (isLoc) {
          // Location uses only verified/approved location truth, matched
          // geographically: the exact place, then a place qualified by the
          // profile's own state/country. Nothing looser.
          let hits = exactGeoMatches(offered, value);
          if (hits.length === 0) {
            const prof = (resolveContext as any)?.profile ?? {};
            hits = qualifiedGeoMatches(offered, value, { state: prof.state, country: prof.country });
          }
          if (hits.length === 1) chosen = hits[0]!;
          else why = `searching ${JSON.stringify(term)} gave ${hits.length} places equal to ${JSON.stringify(value)} among ${offered.join(" | ")}`;
        } else if (isDemographicField(f.label)) {
          // A self-ID field: only the exact option or an approved synonym
          // our EEO resolver already sanctions. Its decline path is NOT
          // used here -- declining a HUMAN_CONFIRMED answer would refuse a
          // question the person actually answered -- so DECLINE/NONE are
          // treated as unmatched and the field is left for them.
          const c = resolveEeoOption(value, offered, f.label);
          if (c.kind === "EXACT" || c.kind === "SYNONYM") chosen = c.option;
          else why = `the confirmed answer ${JSON.stringify(value)} is not an offered self-ID option (${offered.join(" | ")}); a self-ID answer is never guessed or auto-declined`;
        } else {
          const c = chooseSingleOption(offered, value);
          if (c.ok) chosen = c.option; else why = c.why;
        }

        if (chosen === null) {
          // Never write a guess. A required field cannot be left unanswered,
          // so it fails closed and halts; a non-required one is left for the
          // person (an unresolved HUMAN_ONLY field stays blocked) and the run
          // continues to the handoff.
          await page.keyboard.press("Escape").catch(() => undefined);
          if (f.required) throw new Stop("READBACK_MISMATCH", `"${f.label}": ${why}`);
          leftBlank.push({ field: f.label || f.key, why });
          return;
        }

        // Commit via the keyboard, not a click. react-select selects the
        // HIGHLIGHTED option on Enter; a synthetic click on the option element
        // does not reach its selection handler, so the menu closes with the
        // DOM showing a choice that never enters the field's state (the empty
        // read-back that dropped Chartis' Location, five retries deep). Drive
        // the highlight to the chosen option by matching the input's
        // aria-activedescendant to the option's text, then press Enter.
        {
          const activeText = () => combo.evaluate((el: any) => {
            const id = el.getAttribute("aria-activedescendant");
            const opt = id ? document.getElementById(id) : null;
            return opt ? (opt.textContent || "").replace(/\s+/g, " ").trim() : null;
          }).catch(() => null);
          let landed = false;
          for (let step = 0; step < offered.length + 3; step++) {
            const at = await activeText();
            if (at && at.toLowerCase() === chosen.toLowerCase()) { landed = true; break; }
            await combo.press("ArrowDown").catch(() => undefined);
            await page.waitForTimeout(90);
          }
          // Fall back to a click only if the highlight never reached it, so a
          // menu that ignores arrow keys still has a chance rather than a
          // silent miss.
          if (landed) await combo.press("Enter").catch(() => undefined);
          else await clickOptionWithin(ctx.frame.locator("body"), chosen);
        }
        await page.waitForTimeout(500);
        await page.keyboard.press("Tab").catch(() => undefined);
        await page.waitForTimeout(400);
        // Read-back against the value the control actually committed. The
        // authoritative source is Ashby's own field state
        // (fieldEntry.fieldValue.value), read from the combobox's fiber: a
        // react-select location commits an OBJECT there ({ text, provider
        // LocationId }) and renders NO singleValue node, so a DOM read saw the
        // selection as empty and dropped a committed required field. Fall back
        // to the rendered single-value / container text only when the store
        // read is unavailable.
        // Read from the CONTAINER, not the combobox: react-select replaces
        // its [role=combobox] node on selection/blur, so evaluating the old
        // combo handle throws and reads empty; the field container is stable.
        // Retry briefly -- the store update lands a beat after the click.
        let storeHeld = "";
        for (let i = 0; i < 5 && !storeHeld; i++) {
          storeHeld = (await readAshbyCommitted(container).catch(() => null)) ?? "";
          if (!storeHeld) await page.waitForTimeout(300);
        }
        const sv = container.locator('[class*="singleValue" i], [class*="single-value" i]').first();
        let held = storeHeld;
        if (!held && await sv.count().catch(() => 0)) held = (await sv.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (!held) held = (await container.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        // The store value for a place is its full display string ("Cleveland,
        // Ohio, United States"); the chosen option text matches it directly.
        const committed = held.toLowerCase().includes(chosen.toLowerCase())
          || chosen.toLowerCase().includes(held.toLowerCase()) && held.length > 0;
        if (!committed) {
          // A required combobox that will not read back its selection fails
          // closed and halts. A non-required one is left for the person to
          // confirm at handoff -- like every other unverifiable optional field
          // (never a guess, never a hard stop that denies the handoff). Some
          // Ashby react-select location controls accept the click but do not
          // surface the committed value where it can be read; that is left for
          // the person rather than asserted as filled.
          await page.keyboard.press("Escape").catch(() => undefined);
          if (f.required) {
            throw new Stop("READBACK_MISMATCH", `"${f.label}" holds ${JSON.stringify(held.slice(0, 80))} after selecting ${JSON.stringify(chosen)}`);
          }
          leftBlank.push({ field: f.label || f.key, why: `selected ${JSON.stringify(chosen)} but the control did not read it back; left for you to confirm on the form` });
          return;
        }
        filled.push({ field: f.label || f.key, value: chosen });
        return;
      }

      /**
       * A group of checkboxes is one question with many controls.
       *
       * Selection is by the option's OWN selector, never by the group's:
       * the shared name matches every box in the group, which is exactly
       * how "Australia" came to match 30 controls. Read-back then checks
       * the whole group, because the risk here is not only that the
       * intended box failed to tick but that another one is ticked too.
       */
      if (f.htmlType === "checkbox-group") {
        const offered = f.options ?? [];
        const chosen = matchCountryOption(offered, value);
        inspections.push({ field: f.label || f.key, optionsFound: offered.length,
          sample: offered.slice(0, 3), allOptions: offered,
          resolvedAs: chosen.ok ? `matched ${JSON.stringify(chosen.option)} by ${chosen.how}` : chosen.why });
        if (!chosen.ok) {
          throw new Stop("READBACK_MISMATCH",
            `"${f.label || f.key}": ${chosen.why}. The control offered: ${offered.join(" | ")}`);
        }
        const oneSelector = f.optionSelectors?.[chosen.option];
        if (!oneSelector) {
          throw new Stop("SELECTOR_AMBIGUOUS",
            `"${f.label || f.key}": ${JSON.stringify(chosen.option)} has no selector of its own, `
            + "and the group's selector reaches every option");
        }
        const box = ctx.frame.locator(oneSelector);
        if (await box.count() !== 1) {
          throw new Stop("SELECTOR_AMBIGUOUS",
            `"${f.label || f.key}": ${JSON.stringify(oneSelector)} matched ${await box.count()} controls`);
        }
        if (!(await box.isChecked().catch(() => false))) await box.check({ timeout: 8000 });
        await page.waitForTimeout(300);

        // Read the whole group back: exactly the intended option, and
        // nothing else.
        const state = await ctx.frame.evaluate((sels: Record<string, string>) =>
          Object.fromEntries(Object.entries(sels).map(([label, sel]) =>
            [label, Boolean((document.querySelector(sel) as HTMLInputElement | null)?.checked)])),
          f.optionSelectors ?? {});
        const ticked = Object.entries(state).filter(([, on]) => on).map(([l]) => l);
        if (ticked.length !== 1 || ticked[0] !== chosen.option) {
          throw new Stop("READBACK_MISMATCH",
            `"${f.label || f.key}" reads back as ${ticked.length ? ticked.join(" + ") : "nothing selected"} `
            + `after selecting ${JSON.stringify(chosen.option)}`);
        }
        filled.push({ field: f.label || f.key, value: chosen.option });
        return;
      }

      // Ashby button group (custom Yes/No): click the button whose text is
      // the answer, inside this question's own _fieldEntry_ container, and
      // prove it commits by reading aria-pressed. No single input control
      // exists, so this runs before control() is resolved.
      if (f.htmlType === "ashby-button-group") {
        const container = ctx.frame.locator("[class*=_fieldEntry_]").filter({ hasText: f.label }).first();
        const btn = container.getByRole("button", { name: value, exact: true }).first();
        if (await btn.count() === 0) {
          throw new Stop("SELECTOR_AMBIGUOUS", `"${f.label || f.key}": no ${JSON.stringify(value)} button found in the field`);
        }
        await btn.scrollIntoViewIfNeeded().catch(() => undefined);
        await btn.click({ timeout: 8000 });
        await page.waitForTimeout(300);
        const pressed = await btn.getAttribute("aria-pressed").catch(() => null);
        if (pressed !== "true") {
          throw new Stop("READBACK_MISMATCH",
            `"${f.label || f.key}" button ${JSON.stringify(value)} reads aria-pressed=${JSON.stringify(pressed)} after the click, so it did not commit`);
        }
        filled.push({ field: f.label || f.key, value });
        return;
      }

      // Resolved only now. A checkbox group's selector reaches every box
      // in it by design, so asking for the single control first would
      // refuse the group before the code that handles it ever ran.
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
      } else if (provider === "ASHBY") {
        // Ashby's controlled inputs ignore a bulk value-set, so it is typed
        // and committed through the framework, then proven ACCEPTED (value
        // survives reconcile and the control is not left invalid) rather
        // than merely present in the DOM.
        await fillTextCommitting(c, value);
        const committed = await verifyCommitted(c, value);
        if (!committed.ok) {
          throw new Stop("READBACK_MISMATCH", `"${f.label || f.key}" ${committed.why}`);
        }
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
        // Ashby EEO self-identification (voluntary, protected-class: gender,
        // race, veteran, disability -- keyed _systemfield_eeoc_*) is always
        // left for the person to complete on the form at handoff, never
        // auto-set by the program. Even with a HUMAN_CONFIRMED answer on file,
        // the system does not check a protected-class box on someone's behalf;
        // these fields are voluntary and optional, so leaving them blank never
        // blocks handoff. Generic to Ashby's EEO key naming, not one form.
        if (/_systemfield_eeoc_/i.test(f.key)) {
          leftBlank.push({ field: f.label || f.key, why: "EEO self-identification is voluntary and left for you to complete on the employer's form" });
          processedLabels.add(f.label || f.key);
          continue;
        }
        processedLabels.add(f.label || f.key);
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
        const after = await snapForm();
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
      // Open the resume-upload window around THIS upload only, so an Ashby
      // provider's ApiCreateFileUploadHandle + ApiSetFormValueToFile are
      // permitted solely as the finalize of this approved-artifact upload.
      // Closed in finally, after a settle for the finalize op to land, so no
      // later request can ride on it. Harmless for providers that never
      // emit those ops.
      guard.beginResumeUpload();
      try {
        attachment = await attachResume({
          page, frame: ctx.frame, field: resumeField, path: resumePdfPath,
          expectedName: basename, expectedBytes: bytes.length,
          expectedSha256: createHash("sha256").update(bytes).digest("hex"),
        });
        await page.waitForTimeout(2500);
        // Ashby round-trips the attach through an ApiSetFormValueToFile
        // finalize that it often fires (or retries) LATE -- after a fixed
        // settle would have closed the window, leaving the finalize to be
        // blocked and, worse, misread as a submission. When an upload handle
        // was created (Ashby), keep the window open until the finalize
        // actually lands, so the approved artifact truly attaches. Bounded, so
        // a finalize that never comes still closes the window and fails closed
        // downstream. Providers that create no handle are unaffected.
        if (guard.uploadHandleCreated() && !guard.resumeAttachSeen()) {
          const deadline = Date.now() + 8000;
          while (Date.now() < deadline && !guard.resumeAttachSeen()) {
            await page.waitForTimeout(250);
          }
        }
        // Durable, per-application proof of the server-side finalize, captured
        // before the window is reset. For Ashby, serverFinalizeAllowed===true
        // means the approved artifact attached server-side (not merely set on
        // the input); undefined for providers that emit no such op.
        if (attachment && guard.uploadHandleCreated()) {
          attachment.uploadHandleAllowed = guard.uploadHandleCreated();
          attachment.serverFinalizeAllowed = guard.resumeAttachSeen();
        }
      } finally {
        guard.endResumeUpload();
      }
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
      // Ashby's upload kicks off an ASYNC autofill parse that re-initialises
      // the whole form when it lands -- after doUpload's fixed settle. Filling
      // before it lands means every value we write is discarded by that
      // re-init (the bug that made Chartis submit with 10 "missing" fields it
      // visibly held). So wait for the field values to stop changing before
      // reading what the parser did and filling the rest. Two identical
      // snapshots a beat apart means the parse has settled; capped so an
      // upload that triggers no parse still proceeds promptly.
      if (provider === "ASHBY" || behaviour.parserMode === "PARSER_OVERWRITES") {
        const settleDeadline = Date.now() + 30_000;
        let prev = JSON.stringify([...(await readAll())].sort());
        let stable = 0;
        while (Date.now() < settleDeadline && stable < 2) {
          await page.waitForTimeout(1500);
          const cur = JSON.stringify([...(await readAll())].sort());
          stable = cur === prev ? stable + 1 : 0;
          prev = cur;
        }
      }
      live = await snapForm();
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
        // The full record, then the institution itself (institutionSpellings).
        let schoolHit: string[] = [];
        let results = 0;
        for (const spelling of institutionSpellings(rec.institution)) {
          const schools = await lookup(spelling);
          results += schools.length;
          const hit = exactOptions(schools, spelling);
          if (hit.length === 1) {
            if (spelling !== rec.institution) {
              inspections.push({ field: `Education ${row + 1}`, optionsFound: 1, sample: hit,
                resolvedAs: `${JSON.stringify(rec.institution)} is not offered; entered as its institution ${JSON.stringify(hit[0])}` });
            }
            schoolHit = hit;
            break;
          }
        }
        const degreeHit = exactOptions(degreeOptions, rec.degree);

        if (schoolHit.length !== 1 || degreeHit.length !== 1) {
          leftBlank.push({ field: `Education ${row + 1}`,
            why: schoolHit.length !== 1
              ? `${JSON.stringify(rec.institution)} is not offered by this board's school list `
                + `(${results} results for that search), so the entry is not recorded rather than substituted`
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
      const now = await snapForm();

      // What the main pass already filled and verified is done, full
      // stop, and the rescan must not touch it.
      //
      // A react-select control -- Greenhouse's Location (City) is one --
      // commits its value into a rendered chip and CLEARS its search
      // input. On a re-snapshot the field is rediscovered with a selector
      // that reads empty, so the filled-check below concludes it is
      // unfilled and re-queues it; the re-write then resolves the
      // rerendered control to zero matches and the whole submission stops
      // one field short of the handoff, after the resume was already
      // uploaded. The main pass verified read-back for everything in
      // `filled`, so its identity, by label, is authoritative. Matching
      // by label rather than the volatile selector or key is the point:
      // those change across the rerender; the question text does not.
      // The rescan fills only fields the main pass NEVER PROCESSED. A
      // label the main pass already handled is the same question
      // rerendered, not a new one: react-select in particular re-renders
      // a committed control into several same-labelled nodes whose input
      // reads empty, and re-attempting it resolves the stale selector to
      // zero and stops the whole submission one field short. A genuinely
      // dynamic field -- revealed by answering something -- carries a
      // label the main pass never saw, so this preserves discovery by
      // construction while never undoing verified work.
      const fresh: LiveField[] = [];
      for (const f of now.fields) {
        if (f.type === "file" || attempted.has(f.key) || !f.selector) continue;
        const held = await committedValue(ctx.frame, f.selector).catch(() => null);
        const typed = await ctx.frame.locator(f.selector).inputValue().catch(() => "");
        if (shouldReattempt(f.label || f.key, processedLabels, held, typed)) fresh.push(f);
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
