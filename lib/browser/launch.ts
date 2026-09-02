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
  options: { profileDir?: string; viewport?: { width: number; height: number } | null } = {},
): Promise<BrowserContext> {
  const viewport = options.viewport === undefined ? null : options.viewport;
  const context = await chromium.launchPersistentContext(options.profileDir ?? ".browser-profile", {
    channel: "chrome",
    headless: false,
    viewport,
    // Only meaningful with a null viewport, where the window itself sets
    // the size. A fixed viewport ignores it.
    ...(viewport === null ? { args: ["--window-size=1440,1000"] } : {}),
  });
  return prepareContext(context);
}
