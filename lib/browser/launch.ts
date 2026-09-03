/**
 * Launching a browser, once, correctly.
 *
 * Every Playwright context in this project has to carry one piece of
 * compatibility with how the code reaches it. tsx compiles with
 * esbuild's keepNames, which rewrites functions passed to page.evaluate()
 * into a form that calls __name(fn, "name"). That helper exists in the
 * Node module scope and nowhere in the browser, so the first evaluate of
 * a run dies with "ReferenceError: __name is not defined".
 *
 * It cost a real submission attempt: the Home Chef run filled zero
 * fields before anyone understood why. Fixing it in the one script that
 * failed left the same bug latent in ten others, including both Lever
 * self-tests and the resume renderer. So the shim lives here, applied by
 * construction, and no launcher can forget it.
 *
 * The init script is passed as source text rather than as a function.
 * A function would be compiled by the same transform and would reference
 * __name before defining it.
 */
import { existsSync, readlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";

/**
 * esbuild's keepNames helper, as an identity function.
 *
 * Guarded so it never clobbers a real one, and installed before any page
 * script runs on every navigation and in every frame.
 */
const KEEP_NAMES_SHIM =
  "globalThis.__name = globalThis.__name || function (f) { return f; };";

/** Applies the shim to a context. Safe to call more than once. */
export async function prepareContext(context: BrowserContext): Promise<BrowserContext> {
  await context.addInitScript({ content: KEEP_NAMES_SHIM });
  return context;
}

/** A headless browser for tests and rendering. */
export async function launchBrowser(
  options: Parameters<typeof chromium.launch>[0] = {},
): Promise<Browser> {
  return chromium.launch({ channel: "chrome", headless: true, ...options });
}

/**
 * A context from a browser, with the shim already installed.
 *
 * Use this rather than browser.newContext() so the shim cannot be
 * omitted by forgetting a line.
 */
export async function newPreparedContext(
  browser: Browser,
  options: Parameters<Browser["newContext"]>[0] = {},
): Promise<BrowserContext> {
  return prepareContext(await browser.newContext(options));
}

/**
 * A page with the shim installed.
 *
 * browser.newPage() quietly creates its own context, so it bypasses
 * newPreparedContext entirely. Both Lever self-tests used it, which is
 * why they still failed after every explicit newContext call had been
 * migrated. Anything that wants a one-off page should come through here.
 */
export async function newPreparedPage(
  browser: Browser,
  options: Parameters<Browser["newContext"]>[0] = {},
) {
  const context = await newPreparedContext(browser, options);
  return context.newPage();
}

/**
 * The signed-in profile used for real applications.
 *
 * headless is false on purpose: these runs are watched, and a headed
 * window is what makes a handoff possible. viewport null because a fixed
 * viewport on a headed window puts the bottom of the page permanently
 * below the window edge.
 */
export async function launchApplicationContext(
  options: { profileDir?: string; viewport?: { width: number; height: number } | null; debugPort?: number } = {},
): Promise<BrowserContext> {
  const viewport = options.viewport === undefined ? null : options.viewport;
  const profileDir = options.profileDir ?? ".browser-profile";

  /**
   * The debugging port is opt-in, and this is why.
   *
   * It used to be on always, at a fixed 9222. A debug port can be bound
   * by exactly one process, and a persistent profile can be opened by
   * exactly one process, so a single leftover Chrome holding 9222 and
   * the profile's SingletonLock made EVERY later launch die instantly.
   * That is precisely what broke production submission: a stale Chrome
   * from an interactive Workday session held both, and each queued
   * Greenhouse submission launched a browser that popped an about:blank
   * window and exited before it reached a page.
   *
   * Only the interactive CDP-attach flow needs the port; the submitter
   * does not, and now does not ask for one. When a port IS requested,
   * a stale lock is cleared first so a crashed prior session cannot wedge
   * the next one.
   */
  const args = viewport === null ? ["--window-size=1440,1000"] : [];
  if (options.debugPort) args.push(`--remote-debugging-port=${options.debugPort}`);

  // A SingletonLock left by a process that is gone is not a live lock.
  // Chrome writes it as a symlink to host-pid; if nothing answers, it is
  // debris that would otherwise fail the launch with an opaque error.
  const lock = join(profileDir, "SingletonLock");
  if (existsSync(lock)) {
    try {
      const target = readlinkSync(lock);              // "host-PID"
      const pid = Number(target.split("-").pop());
      const alive = Number.isFinite(pid) && (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
      if (!alive) unlinkSync(lock);
    } catch { /* a lock we cannot read is left for Chrome to adjudicate */ }
  }

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: "chrome", headless: false, viewport, args,
    });
  } catch (e) {
    // The real reason, not "the runner died". A launch that fails here
    // fails because the profile is in use or the port is taken, and the
    // caller should be able to say so.
    throw new Error(`browser launch failed for profile ${profileDir}`
      + `${options.debugPort ? ` (debug port ${options.debugPort})` : ""}: ${(e as Error).message}`);
  }
  return prepareContext(context);
}
