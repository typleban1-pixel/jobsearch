/**
 * Snapshotting a Lever form during preparation, in a browser.
 *
 * Greenhouse publishes its form, so a snapshot is an API call and
 * preparation never opens a page. Lever does not: the form exists only
 * as HTML at the apply URL. Rather than approve answers now and discover
 * the real form later, preparation opens the page, makes the
 * deterministic setup choices, and snapshots what those produce. The
 * invariant is unchanged: the questions approved are the questions the
 * system is allowed to answer and submit against.
 *
 * Lives under lib/browser because it imports Playwright. The portal must
 * never reach this file, which is why prepareApplication takes it as an
 * injected function rather than importing it.
 */
import { chromium } from "playwright";
import type { FormField } from "../applications/answer.ts";
import { snapshotLeverForm, stabilizeLeverForm, leverSnapshotShape, type LeverField } from "./providers/lever.ts";
import { launchBrowser, newPreparedContext, newPreparedPage } from "./launch.ts";

export interface LiveSnapshotResult {
  ok: boolean;
  reason?: string;
  snapshot?: {
    provider: string;
    fields: FormField[];
    sensitiveKeys: string[];
    fetchedAt: string;
    /** Lever specifics kept alongside, so fill can reproduce the setup. */
    lever: {
      applyUrl: string;
      office: string | null;
      officeReason: string;
      /** The office chosen for this application, if the posting offered a choice. */
      reviewedOffice: string | null;
      shape: string;
      signatureKeys: string[];
      kinds: Record<string, LeverField["kind"]>;
    };
  };
  hash?: string;
  /** Present when a person has to choose before anything can be prepared. */
  offices?: Array<{ value: string; label: string }>;
  /** The same choice expressed as a form question, for the answer queue. */
  officeQuestion?: { key: string; label: string; options: string[] };
}

/** Sections the provider itself marks demographic or compliance. */
const SENSITIVE = /^(eeo\[|surveysResponses\[|consent\[)/;

/** Lever kinds mapped onto the system's field vocabulary. */
function toFormField(f: LeverField): FormField {
  const type: FormField["type"] =
    f.kind === "file" ? "file"
    : f.kind === "textarea" ? "textarea"
    : f.kind === "select" || f.kind === "radio_group" || f.kind === "checkbox_group" ? "select"
    : "text";
  return {
    key: f.key,
    label: f.label,
    type,
    required: f.required,
    ...(f.options.length ? { options: f.options } : {}),
  };
}

export async function snapshotLeverLive(input: {
  applyUrl: string;
  /** An office already reviewed for THIS application, if one has been. */
  reviewedOffice?: string | null;
  timeoutMs?: number;
}): Promise<LiveSnapshotResult> {
  const browser = await launchBrowser();
  try {
    const page = await newPreparedPage(browser, { viewport: { width: 1440, height: 1000 } });
    const res = await page.goto(input.applyUrl, { waitUntil: "domcontentloaded", timeout: input.timeoutMs ?? 45_000 });
    if (!res || res.status() >= 400) {
      return { ok: false, reason: `the apply page returned ${res?.status() ?? "no response"}` };
    }
    await page.waitForTimeout(3000);

    // Deterministic setup FIRST. Choosing an office changes which
    // surveys and questions render, so a snapshot taken before the
    // choice describes a form that will not exist at fill time.
    const setup = await stabilizeLeverForm(page, { preferLocation: input.reviewedOffice ?? undefined });
    if (!setup.chose && /a person must choose/.test(setup.reason)) {
      const offered = (await snapshotLeverForm(page)).locationChoices;
      // The office is a question the employer asks, so it is returned as
      // one rather than as an error to be handled elsewhere. Answering it
      // in the queue makes the choice application-specific by
      // construction: it lives on this application's answers and cannot
      // turn into a standing geographic preference.
      return {
        ok: false,
        reason: `this posting offers ${offered.length} offices and none matches a reviewed location. `
          + `Choose one for this application and prepare it again`,
        offices: offered,
        officeQuestion: {
          key: "opportunityLocationId",
          label: "Which office are you applying to?",
          options: offered.map((o) => o.label),
        },
      };
    }

    const live = await snapshotLeverForm(page);
    if (!live.fields.length) return { ok: false, reason: "no application form was found at the apply URL" };
    if (live.captchaChallengeVisible) {
      return { ok: false, reason: "a CAPTCHA challenge is displayed on the apply page" };
    }

    const shape = leverSnapshotShape(live);
    const kinds: Record<string, LeverField["kind"]> = {};
    for (const f of live.fields) kinds[f.key] = f.kind;

    return {
      ok: true,
      hash: shape,
      snapshot: {
        provider: "LEVER",
        fields: live.fields.map(toFormField),
        sensitiveKeys: live.fields.filter((f) => SENSITIVE.test(f.key)).map((f) => f.key),
        fetchedAt: new Date().toISOString(),
        lever: {
          applyUrl: live.url,
          // Which office this application is for. Reproduced at fill
          // time so the form that gets filled is the form that was
          // approved, surveys included.
          office: setup.chose, officeReason: setup.reason,
          reviewedOffice: input.reviewedOffice ?? null,
          shape, signatureKeys: live.signatureKeys, kinds,
        },
      },
    };
  } catch (err) {
    return { ok: false, reason: `could not snapshot the live form: ${(err as Error).message}` };
  } finally {
    await browser.close();
  }
}
