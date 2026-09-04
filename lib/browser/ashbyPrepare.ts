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
 * The form normalization (grouping choice fieldsets, dropping the file
 * phantom, revealing the form) lives in ashbyForm.ts and is shared verbatim
 * with the fill path, so the snapshot reviewed here and the form filled
 * later can never be grouped differently.
 *
 * Lives under lib/browser because it imports Playwright. The portal must
 * never reach this file, which is why prepareApplication takes it as an
 * injected function rather than importing it.
 */
import type { Frame } from "playwright";
import { hashSnapshot, type FormSnapshot } from "../applications/formSnapshot.ts";
import { snapshotLive, type LiveSnapshot } from "./liveSnapshot.ts";
import { isDemographicField, isDisabilityField } from "./eeo.ts";
import { launchBrowser, newPreparedPage } from "./launch.ts";
import {
  looksLikeForm, toFormField, groupAshbyChoices, mergeChoiceGroups,
  dropFileHeaderArtifacts, readChoiceFieldsets, revealAshbyForm, ashbyMultiStep,
} from "./ashbyForm.ts";

export interface AshbyLiveResult {
  ok: boolean;
  reason?: string;
  snapshot?: FormSnapshot;
  hash?: string;
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
    await revealAshbyForm(page);
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
    const isMultiStep = looksLikeForm(live) ? await ashbyMultiStep(page) : false;
    const decision = decideAshby(live, isMultiStep);
    if (!decision.ok) return { ok: false, reason: decision.reason };

    // Collapse Ashby choice fieldsets into one question each, then drop the
    // per-option fields the generic read produced. Anything not proven to be
    // a grouped option is left exactly as discovered.
    const grouping = groupAshbyChoices(await readChoiceFieldsets(page));
    // Merge on LiveField (the grouped questions carry live per-option
    // selectors the fill path needs), then project to FormField for the
    // stored snapshot -- which keeps only key/label/type/required/options,
    // so no volatile selector is ever persisted and this snapshot is
    // byte-identical to before.
    const cleaned = dropFileHeaderArtifacts(live.fields);
    const fields = mergeChoiceGroups(cleaned, grouping).map(toFormField);
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
