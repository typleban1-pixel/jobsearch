/**
 * The reason this system cannot submit an application.
 *
 * Not a rule the filler follows. Four independent layers, each of which
 * would have to fail before a submission could happen, and none of which
 * depends on reading a button's label. The accessible-name denylist is
 * the fourth and weakest, present only so that a case which somehow
 * satisfies the other three still has something in its way.
 *
 * The layer that actually carries the guarantee is layer 2: a
 * capture-phase listener that cancels every submit event. Layers 0 and 1
 * are about never getting there; layer 2 is about what happens when they
 * are wrong, which they eventually will be, because ATS forms are other
 * people's software.
 */
import type { Page, Frame, BrowserContext, ElementHandle } from "playwright";

export const SUBMIT_GUARD_VERSION = 1;

/**
 * Layer 4, and explicitly the weakest.
 *
 * A button reading "Continue" that posts an application is exactly what
 * this cannot see, which is why it is last rather than first.
 */
const SUBMIT_NAME_DENYLIST = [
  /\bsubmit\b/i, /\bapply\b/i, /\bsend\s+application\b/i, /\bfinish\b/i,
  /\bcomplete\s+application\b/i, /\bconfirm\s+and\s+send\b/i, /\bsend\b/i,
];

export function nameLooksLikeSubmit(name: string): boolean {
  return SUBMIT_NAME_DENYLIST.some((r) => r.test(name));
}

/**
 * Layer 2 and part of layer 0, installed before any page script runs.
 *
 * Cancels submit events in the capture phase and replaces the
 * programmatic submission entry points. Everything it stops is recorded
 * on `window.__fillGuard`, which the worker reads: a blocked attempt is
 * never a warning, it is a stop.
 */
const GUARD_SCRIPT = `
(() => {
  // Idempotent. Init scripts accumulate on a context, so filling a second
  // application through the same browser runs this again on every new
  // page; without the guard the second run threw redefining a
  // non-configurable property, which broke page initialization and hung
  // the fill.
  if (window.__fillGuard) return;
  const g = { submitAttempts: [], programmatic: [] };
  Object.defineProperty(window, "__fillGuard", { value: g, writable: false, configurable: false });

  const describe = (el) => {
    if (!el) return "unknown";
    try {
      return [el.tagName, el.id ? "#" + el.id : "", el.name ? "[name=" + el.name + "]" : "",
              (el.getAttribute && el.getAttribute("action")) || ""].join("").slice(0, 200);
    } catch { return "unknown"; }
  };

  // Capture phase, on the document, so it runs before any handler the
  // page installed on the form itself.
  document.addEventListener("submit", (e) => {
    // Released to the person. Handoff sets this, and honouring it here is
    // what lets the page be released WITHOUT reloading it: the listener
    // stays installed and simply stops cancelling. Reloading to shed it
    // wiped every field that had just been filled, which defeated the
    // entire point of handing a completed form to someone.
    //
    // A navigation re-runs this script with the flag unset, so the guard
    // re-arms on any new page rather than staying off.
    if (window.__fillGuardDisarmed) return;
    g.submitAttempts.push({ target: describe(e.target), at: Date.now(), trusted: e.isTrusted });
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // preventDefault does not stop form.submit(), which bypasses the event
  // entirely. These have to be replaced, not listened to.
  const nativeSubmit = HTMLFormElement.prototype.submit;
  const nativeRequestSubmit = HTMLFormElement.prototype.requestSubmit;
  HTMLFormElement.prototype.submit = function () {
    g.programmatic.push({ kind: "submit", target: describe(this), at: Date.now() });
    throw new Error("submission is blocked while this form is being filled");
  };
  HTMLFormElement.prototype.requestSubmit = function () {
    g.programmatic.push({ kind: "requestSubmit", target: describe(this), at: Date.now() });
    throw new Error("submission is blocked while this form is being filled");
  };
  g.__native = { nativeSubmit, nativeRequestSubmit };
})();
`;

export interface GuardReport {
  submitAttempts: Array<{ target: string; at: number; trusted: boolean }>;
  programmatic: Array<{ kind: string; target: string; at: number }>;
  blockedRequests: Array<{ method: string; url: string; at: number }>;
}

/** Requests a page may legitimately make while being filled. */
const REQUEST_ALLOW = [
  /\/(?:upload|attachment|file|resume|s3|blob)/i,
  /\bautosave\b/i,
  /\.(?:js|css|png|jpe?g|gif|svg|woff2?|ico|map)(?:\?|$)/i,
  // Ashby loads a location combobox's suggestions from ONE read operation
  // on its GraphQL endpoint, named in the query string. This allows ONLY
  // that exact operation: every other operation on the same endpoint --
  // the application-submit mutation among them -- carries a different op and
  // is not matched here, so it stays blocked. Pinned to the op name and
  // anchored so no other value can satisfy it.
  /\/api\/non-user-graphql\?op=ApiAutocompleteGeoLocation(?:&|$)/i,
];

/**
 * Whether a request may proceed while a form is being filled, by the allow
 * rules above. Exported so the narrow Ashby option-fetch allowance can be
 * proven -- allowed for the geo read, refused for a submit-like operation --
 * without standing up a browser.
 */
export function mayFetchWhileFilling(url: string): boolean {
  return REQUEST_ALLOW.some((r) => r.test(url));
}

const INSTALLED = new WeakMap<BrowserContext, SubmitGuard>();

export class SubmitGuard {
  readonly blockedRequests: GuardReport["blockedRequests"] = [];
  private armed = false;
  /** The form's own origin. Only requests to it can be a submission. */
  private origin: string | null = null;
  private readonly context: BrowserContext;

  private constructor(context: BrowserContext) {
    this.context = context;
  }

  /**
   * Installs layers 2 and 3 on the whole context.
   *
   * addInitScript runs before page scripts on every navigation, so a
   * multi-step form that changes pages stays guarded without the worker
   * remembering to re-arm.
   */
  static async install(context: BrowserContext): Promise<SubmitGuard> {
    // One guard per context. Installing per application added a second
    // init script and a second route handler to the same browser, which
    // is both wasteful and, before the idempotence fix above, fatal.
    const existing = INSTALLED.get(context);
    if (existing) return existing;

    const guard = new SubmitGuard(context);
    INSTALLED.set(context, guard);
    await context.addInitScript(GUARD_SCRIPT);

    // Layer 3: a single-page form can submit with fetch and never fire a
    // submit event at all, which is invisible to layer 2.
    await context.route("**/*", async (route) => {
      const request = route.request();
      const method = request.method();
      if (!guard.armed || method === "GET" || method === "HEAD" || method === "OPTIONS") {
        return route.continue();
      }
      const url = request.url();
      if (REQUEST_ALLOW.some((r) => r.test(url))) return route.continue();

      // Same origin as the form, which is what the architecture says and
      // what the first implementation got wrong by blocking every host.
      //
      // Greenhouse pages POST Snowplow analytics to c.spl.greenhouse.io
      // on load. Blocking those aborted requests that have nothing to do
      // with applying and, worse, recorded them as submission attempts,
      // so every run reported guards firing and no run could finish. A
      // submission goes to the form's own origin; telemetry to a
      // different host is somebody else's business.
      const pageOrigin = guard.origin;
      if (pageOrigin) {
        try {
          if (new URL(url).origin !== pageOrigin) return route.continue();
        } catch { /* unparseable: fall through and block */ }
      }
      guard.blockedRequests.push({ method, url: url.slice(0, 300), at: Date.now() });
      return route.abort("blockedbyclient");
    });

    return guard;
  }

  /**
   * Request blocking applies only while the worker is driving, and only
   * to the origin serving the form.
   */
  arm(formUrl?: string): void {
    this.armed = true;
    if (formUrl) { try { this.origin = new URL(formUrl).origin; } catch { this.origin = null; } }
  }

  /**
   * Re-point layer 3 at the origin that actually serves the form.
   *
   * An embedded application lives on the provider's origin while the
   * page is the employer's. Armed with the page URL, layer 3 would have
   * guarded spothero.com and ignored a submission POST from the
   * greenhouse.io frame, which is the one that matters.
   */
  protectOrigin(formUrl: string): void {
    try { this.origin = new URL(formUrl).origin; } catch { /* leave as-is */ }
  }

  /**
   * Layers 2 and 3 are torn down together, once, at handoff.
   *
   * After this the page behaves normally and the person can submit. The
   * worker exits immediately afterwards, so there is no window in which
   * automation is running against an unguarded page.
   */
  async handoff(page: Page): Promise<void> {
    // Disarming is enough: the route handler stays installed but passes
    // everything through. Unrouting would tear down a guard the next
    // application in the same browser still needs.
    this.armed = false;
    await page.evaluate(() => {
      const g = (window as any).__fillGuard;
      if (g?.__native) {
        HTMLFormElement.prototype.submit = g.__native.nativeSubmit;
        HTMLFormElement.prototype.requestSubmit = g.__native.nativeRequestSubmit;
      }
      (window as any).__fillGuardDisarmed = true;
    });
    // The capture-phase listener stays installed and now checks
    // __fillGuardDisarmed, so it passes submissions through from here on.
    //
    // It used to be shed by reloading the page. That ran in a finally
    // block on every path, including the successful one, so the sequence
    // a person actually saw was: the form fills, the page scrolls for the
    // final screenshot, and then every field goes blank. HANDOFF means
    // the completed form is yours to submit, and a reload is the one
    // thing that cannot happen at it.
    //
    // Nothing else here touches the page: no navigation, no reload, no
    // re-snapshot, no scrolling. The last action that changes the
    // document is the final read-back.
  }

  /**
   * Read from the frame that owns the form.
   *
   * addInitScript installs the guard in every frame, so a submit
   * attempt inside an embedded Greenhouse form records on THAT frame's
   * window. Reading only the main frame would report zero attempts for
   * an iframe submission that was in fact blocked.
   */
  async report(target: Page | Frame): Promise<GuardReport> {
    const inPage = await target.evaluate(() => {
      const g = (window as any).__fillGuard;
      return g ? { submitAttempts: g.submitAttempts, programmatic: g.programmatic } : { submitAttempts: [], programmatic: [] };
    }).catch(() => ({ submitAttempts: [], programmatic: [] }));
    return { ...inPage, blockedRequests: this.blockedRequests };
  }

  /**
   * A point in time to compare against.
   *
   * blockedRequests is context-wide and cumulative, so asking "has
   * anything been blocked" poisons every check after the first block:
   * a legitimate multi-step form could never advance, and the stop
   * reason reported would belong to an earlier page. Submit attempts
   * live on `window.__fillGuard` and reset with each navigation, so only
   * the request count needs a baseline.
   */
  mark(): number {
    return this.blockedRequests.length;
  }

  /** Did anything happen on THIS page since the mark? */
  async sawSubmissionAttemptSince(target: Page | Frame, since: number): Promise<boolean> {
    const r = await this.report(target);
    return r.submitAttempts.length > 0 || r.programmatic.length > 0
      || r.blockedRequests.length > since;
  }

  async sawSubmissionAttempt(target: Page | Frame): Promise<boolean> {
    return this.sawSubmissionAttemptSince(target, 0);
  }
}

/**
 * Layer 1: whether activating this control could submit a form.
 *
 * Decided from structure alone, before any text is considered. A control
 * that passes is not thereby clickable; it is merely not disqualified
 * here.
 */
export async function isSubmitCapable(el: ElementHandle<Element>): Promise<{ capable: boolean; why: string }> {
  return el.evaluate((node: Element) => {
    const tag = node.tagName.toLowerCase();
    const type = (node.getAttribute("type") ?? "").toLowerCase();

    if (tag === "input" && type === "submit") return { capable: true, why: "input[type=submit]" };
    if (tag === "input" && type === "image") return { capable: true, why: "input[type=image]" };
    if (tag === "button" && type === "submit") return { capable: true, why: "button[type=submit]" };
    if (node.hasAttribute("formaction")) return { capable: true, why: "carries formaction" };
    if (node.hasAttribute("form")) return { capable: true, why: "associated with a form by the form attribute" };

    // The HTML default for a button inside a form is type=submit. A
    // button with no type attribute is a submit button wearing no label
    // that says so, which no name-based check can see.
    const form = (node as HTMLButtonElement).form ?? node.closest("form");
    if (tag === "button" && !node.hasAttribute("type") && form) {
      return { capable: true, why: "button with no type inside a form, which defaults to submit" };
    }

    // The form's implicit default button: the first submit-capable
    // control in tree order. Enter in a text field activates it.
    if (form) {
      const candidates = Array.from(form.querySelectorAll("button, input[type=submit], input[type=image]"));
      const first = candidates.find((c) => {
        const t = (c.getAttribute("type") ?? "").toLowerCase();
        const ct = c.tagName.toLowerCase();
        return t === "submit" || t === "image" || (ct === "button" && !c.hasAttribute("type"));
      });
      if (first === node) return { capable: true, why: "the form's implicit default button" };
    }
    return { capable: false, why: "" };
  });
}
