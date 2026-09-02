/**
 * Where the application form actually is.
 *
 * SpotHero's careers page carries the job description and no controls at
 * all; the Greenhouse form lives one frame down at
 * job-boards.greenhouse.io/embed/job_app. Reading only the top document
 * reported NO_FORM_FOUND for a form that was plainly on screen.
 *
 * Everything downstream — snapshot, selectors, fill, read-back, the
 * submission guards — operates against a resolved context rather than
 * against "the page". A context is a Playwright Frame, and the top
 * document is simply the main frame, so there is one code path and no
 * iframe special-casing scattered through the filler.
 *
 * Identification is deterministic and provider-based. A frame is not
 * chosen because it happens to contain inputs: an employer page can
 * embed a newsletter signup, a chat widget or a survey, and filling one
 * of those with application answers would be worse than finding nothing.
 */
import type { Frame, Page } from "playwright";
import { Stop } from "./stopReasons.ts";

export const FORM_CONTEXT_VERSION = 1;

/** Origins that serve a real application form, per provider. */
const PROVIDER_FORM_HOSTS: Record<string, RegExp> = {
  GREENHOUSE: /(^|\.)(job-boards|boards)\.greenhouse\.io$/i,
  LEVER: /(^|\.)jobs\.lever\.co$/i,
  ASHBY: /(^|\.)jobs\.ashbyhq\.com$/i,
};

export interface FormContext {
  /** The frame the form lives in. The top document is the main frame. */
  frame: Frame;
  /** Where it came from, for the run record. */
  url: string;
  kind: "top-document" | "iframe";
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ""; }
}

async function controlCount(frame: Frame): Promise<number> {
  return frame.evaluate(() =>
    document.querySelectorAll("input:not([type=hidden]),select,textarea").length,
  ).catch(() => 0);
}

/**
 * Finds the form, or stops.
 *
 * Order matters. A provider-hosted top document is used directly, which
 * keeps every previously validated direct-Greenhouse run on exactly the
 * path it already took. Only when the top document is not itself the
 * form are child frames considered, and only those whose ORIGIN belongs
 * to the provider.
 */
export async function resolveFormContext(page: Page, provider: string): Promise<FormContext> {
  const host = PROVIDER_FORM_HOSTS[provider];
  if (!host) {
    throw new Stop("PROVIDER_UNSUPPORTED", `no form-host pattern is known for ${provider}`);
  }

  const main = page.mainFrame();
  const topIsProvider = host.test(hostOf(main.url()));
  if (topIsProvider && (await controlCount(main)) > 0) {
    return { frame: main, url: main.url(), kind: "top-document" };
  }

  // Child frames whose origin is the provider's. Nothing else qualifies,
  // however many inputs it has.
  const candidates = page.frames()
    .filter((f) => f !== main)
    .filter((f) => host.test(hostOf(f.url())));

  const withControls: Frame[] = [];
  for (const f of candidates) if ((await controlCount(f)) > 0) withControls.push(f);

  if (withControls.length === 1) {
    const f = withControls[0]!;
    return { frame: f, url: f.url(), kind: "iframe" };
  }

  if (withControls.length > 1) {
    throw new Stop("SELECTOR_AMBIGUOUS",
      `${withControls.length} ${provider} form frames are present and which one is the application is not established`,
      { urls: withControls.map((f) => f.url().slice(0, 120)) });
  }

  // Nothing provider-hosted anywhere. If the top document happens to
  // have controls they are somebody else's form, and they are not filled.
  const topControls = await controlCount(main);
  throw new Stop("NO_FORM_FOUND",
    topControls > 0
      ? `no ${provider} form frame is present; the ${topControls} control(s) on this page belong to something else and are not an application form`
      : `no ${provider} application form is present in the page or any of its ${page.frames().length - 1} frame(s)`,
    { topControls, frames: page.frames().map((f) => f.url().slice(0, 120)) });
}

/**
 * Confirms the form is still the one that was resolved.
 *
 * A frame can navigate, reload or be replaced while the worker is
 * filling. Continuity cannot be assumed: if the frame is detached or its
 * URL has moved, the run stops rather than writing the rest of the
 * answers into whatever is there now.
 */
export async function assertContextIntact(ctx: FormContext): Promise<void> {
  if (ctx.frame.isDetached()) {
    throw new Stop("FORM_CHANGED", "the application form frame was detached while filling");
  }
  const now = ctx.frame.url();
  if (now !== ctx.url) {
    throw new Stop("FORM_CHANGED",
      `the application form navigated while filling (was ${ctx.url.slice(0, 80)}, now ${now.slice(0, 80)})`);
  }
}
