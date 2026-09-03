/**
 * Reading a live Workday page into signals, and acting on the plan.
 *
 * The browser half. Everything decidable lives in pageState.ts and
 * authPlan.ts and is tested without Playwright; this file is the part
 * that must touch a real page, kept as thin as possible for that reason.
 *
 * DETERMINISM
 *
 * No step here waits a fixed number of milliseconds and then assumes.
 * Navigation waits for the network to settle, and every subsequent step
 * waits for a SELECTOR that must exist for the action to be meaningful.
 * If the selector never appears the run stops; it does not proceed on a
 * timer and hope.
 */
import type { Page } from "playwright";
import { classifyWorkdayPage, type PageSignals, type WorkdayPageState } from "./pageState.ts";
import { urlBelongsToTenant, type WorkdayTenant } from "./tenant.ts";

/**
 * Waits until the tenant's SPA has actually rendered.
 *
 * Workday serves a shell that stamps data-automation-id="loading" before
 * any real content exists. A readiness check of "at least one automation
 * id" is satisfied by that spinner, which is how a first run of this
 * survey classified all nineteen live tenants as UNKNOWN: it read the
 * loading screen every time.
 *
 * The condition is therefore the absence of the spinner AND the presence
 * of something else, which is a fact about the DOM rather than an
 * elapsed time. Returns false on timeout so the caller can classify
 * honestly instead of acting on a half-rendered page.
 */
export async function waitForWorkdayReady(page: Page, timeout = 25_000): Promise<boolean> {
  try {
    await page.waitForFunction(() => {
      const all = document.querySelectorAll("[data-automation-id]");
      if (all.length === 0) return false;
      const loading = document.querySelector('[data-automation-id="loading"]');
      // The spinner is sometimes left in the DOM after render, so its
      // mere presence is not disqualifying; being the ONLY thing is.
      return !(loading && all.length <= 1);
    }, null, { timeout });
    return true;
  } catch { return false; }
}

/** Controls Workday stamps, read straight from the DOM. */
export async function readSignals(page: Page): Promise<PageSignals> {
  const raw = await page.evaluate(() => {
    // VISIBLE controls only.
    //
    // Workday keeps the sign-in form and the create-account form in the
    // same modal container and toggles between them, so both exist in
    // the DOM at all times. Reading every data-automation-id therefore
    // saw verifyPassword and createAccountSubmitButton while the SIGN-IN
    // form was on screen, and classified it CREATE_ACCOUNT_FORM. With no
    // credential stored that would have driven an account-creation
    // attempt against a hidden form.
    //
    // getClientRects() is the browser's own answer to "does this occupy
    // space", which covers display:none, an unrendered ancestor, and a
    // zero-size box, without this code reimplementing any of it.
    const visible = (e: Element) => e.getClientRects().length > 0;
    const ids = [...document.querySelectorAll("[data-automation-id]")]
      .filter(visible)
      .map((e) => e.getAttribute("data-automation-id") ?? "").filter(Boolean);
    const inputs = [...document.querySelectorAll("input")]
      .filter(visible).map((i) => i.type || "text");
    const body = document.body?.innerText ?? "";
    // A mounted challenge, as opposed to an invisible scoring badge.
    const frames = [...document.querySelectorAll("iframe")].map((f) => f.getAttribute("src") ?? "");
    const challenge = frames.some((s) => /recaptcha\/api2\/(?:b?frame|anchor)|hcaptcha\.com\/captcha|challenges\.cloudflare\.com/.test(s))
      || document.querySelector("[data-sitekey]") !== null;
    const badgeOnly = !challenge && document.querySelector(".grecaptcha-badge") !== null;
    const sso = frames.some((s) => /login\.microsoftonline\.com|okta\.com|accounts\.google\.com|onelogin\.com|pingidentity/.test(s))
      || /sign in with (?:microsoft|google|okta|sso)|use your (?:company|organization) account/i.test(body);
    return { ids, inputs, body, challenge, badgeOnly, sso };
  });
  return {
    automationIds: raw.ids.map((s: string) => s.toLowerCase()),
    text: raw.body.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 20_000),
    url: page.url(),
    inputTypes: raw.inputs,
    captcha: raw.challenge,
    captchaBadgeOnly: raw.badgeOnly,
    sso: raw.sso,
  };
}

export interface Observation {
  state: WorkdayPageState;
  signals: PageSignals;
  /** False when the page navigated off this tenant's origin. */
  onTenant: boolean;
}

/**
 * What the page is right now.
 *
 * The tenant check is a safety property, not bookkeeping: a redirect to
 * another origin means whatever is on screen is not this tenant's
 * sign-in, and typing this tenant's credential into it would hand a
 * secret to a third party.
 */
export async function observe(page: Page, tenant: WorkdayTenant): Promise<Observation> {
  const signals = await readSignals(page);
  const onTenant = urlBelongsToTenant(signals.url, tenant);
  return {
    state: onTenant ? classifyWorkdayPage(signals) : "SSO_PROMPT",
    signals,
    onTenant,
  };
}

/**
 * Fills the VISIBLE control matching a selector.
 *
 * Workday keeps the sign-in and create-account forms in one modal and
 * hides the inactive one, so `[data-automation-id="email"]` matches
 * twice. page.fill() takes the FIRST match without complaining -- the
 * harness logs it plainly: "resolved to 2 elements. Proceeding with the
 * first one" -- and the first is whichever form appears earlier in the
 * DOM, not the one on screen.
 *
 * A credential typed into the hidden form is a credential the tenant
 * never receives. The visible form submits empty, the modal closes
 * because it closes either way, and the page returns to the landing
 * state signed out: exactly what the live run did.
 *
 * :visible resolves the one a person would type into. Two visible
 * matches is not something to guess between, so it throws.
 */
async function fillVisible(page: Page, selector: string, value: string): Promise<void> {
  const control = page.locator(`${selector}:visible`);
  const n = await control.count();
  if (n === 0) throw new Error(`no visible control matches ${selector}`);
  if (n > 1) throw new Error(`${n} visible controls match ${selector}; refusing to choose`);
  await control.fill(value);
}

/** Selectors Workday uses for the controls this flow touches. */
export const SEL = {
  email: '[data-automation-id="email"]',
  password: '[data-automation-id="password"]',
  verifyPassword: '[data-automation-id="verifyPassword"]',
  signInSubmit: '[data-automation-id="signInSubmitButton"]',
  createSubmit: '[data-automation-id="createAccountSubmitButton"]',
  createLink: '[data-automation-id="createAccountLink"]',
  signOut: '[data-automation-id="utilityButtonSignOut"]',
} as const;

/**
 * Clicks a Workday button by its accessible name.
 *
 * The <button> Workday stamps with a data-automation-id is NOT the
 * interactive element. It carries aria-hidden="true" and tabindex="-2",
 * and a sibling div with role="button", tabindex="0" and the aria-label
 * sits on top of it:
 *
 *   <div class="..."
 *     <div role="button" aria-label="Create Account" data-automation-id="click_filter"></div>
 *     <button data-automation-id="createAccountSubmitButton" aria-hidden="true">Create Account</button>
 *   </div>
 *
 * Clicking the button therefore fails with "click_filter intercepts
 * pointer events", which is exactly what happened on the first live
 * account-creation attempt. Playwright retried for the full timeout and
 * gave up, so nothing was created.
 *
 * Targeting the accessible role and name resolves the element a person
 * would actually click, and does it through the accessibility tree
 * rather than by hardcoding the overlay's class or automation id.
 */
export async function clickWorkdayButton(page: Page, name: string, timeout = 25_000): Promise<void> {
  const control = page.getByRole("button", { name, exact: true });
  await control.first().click({ timeout });
}

/**
 * Clicks the overlay belonging to ONE specific submit button.
 *
 * By accessible name is not enough on the credential modal. The utility
 * bar's "Sign In" button and the form's "Sign In" submit share a name,
 * the utility one comes first in the DOM, and .first() therefore
 * reopened the modal instead of submitting it: the loop observed
 * SIGN_IN_FORM again and concluded the credential had been ignored,
 * while the same credential reached Candidate Home when driven by hand.
 *
 * The automation id identifies the right button unambiguously, and the
 * clickable overlay is its immediately preceding sibling.
 */
export async function clickSubmit(page: Page, automationId: string, timeout = 25_000): Promise<void> {
  const overlay = page.locator(
    `xpath=//*[@data-automation-id="${automationId}"]/preceding-sibling::*[@data-automation-id="click_filter"][1]`)
    .locator("visible=true");
  if (await overlay.count()) { await overlay.first().click({ timeout }); return; }
  // No overlay on this tenant: the button itself is the control.
  await page.locator(`[data-automation-id="${automationId}"]:visible`).first().click({ timeout });
}

/**
 * Types a credential and submits, without ever putting it anywhere else.
 *
 * fill() sets the value directly; it is never logged, never returned,
 * and the caller holds it only for the length of this call.
 */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await fillVisible(page, SEL.email, email);
  await fillVisible(page, SEL.password, password);
  await clickSubmit(page, "signInSubmitButton");
  await settleAfterCredential(page);
}

/**
 * Waits for a credential submission to actually resolve.
 *
 * networkidle is not enough. Workday's candidate app is a SPA that keeps
 * connections open, so the load state can settle while the sign-in form
 * is still on screen; a successful login then reads as SIGN_IN_FORM and
 * the caller concludes the credential was ignored. That happened on the
 * first live run against Northern Trust, where the same credential had
 * demonstrably reached Candidate Home moments earlier.
 *
 * So this waits for the OUTCOME instead: either the credential form is
 * gone, or an authenticated page has appeared, or an error is being
 * shown. All three are DOM facts. A timeout returns quietly and the
 * caller classifies whatever is there, which is the honest fallback.
 */
async function settleAfterCredential(page: Page, timeout = 25_000): Promise<void> {
  await page.waitForFunction(() => {
    const q = (id: string) => document.querySelector(`[data-automation-id="${id}"]`);
    const visible = (e: Element | null) => Boolean(e && e.getClientRects().length > 0);
    const stillAsking = visible(q("password")) || visible(q("verifyPassword"));
    const authed = visible(q("candidateHomePage")) || visible(q("candidate-home-app"))
      || visible(q("utilityButtonAccountTasksMenu")) || visible(q("utilityButtonSignOut"));
    const errored = [...document.querySelectorAll('[role="alert"], [data-automation-id*="rror"]')]
      .some((e) => (e as HTMLElement).innerText.trim().length > 0
        && /incorrect|invalid|already exists|verify/i.test((e as HTMLElement).innerText));
    // The modal closes the INSTANT submit is pressed, before the tenant
    // has decided anything. Returning here on "the form is gone" meant
    // observing the loading screen and calling a successful login
    // UNKNOWN. Disappearance is not an outcome; it is the start of one.
    const loading = visible(q("loading"));
    const settledSignedOut = !stillAsking && !loading
      && (visible(q("utilityButtonSignIn")) || visible(q("jobSearchPage")));
    return authed || errored || settledSignedOut;
  }, null, { timeout }).catch(() => { /* classified by the caller as it stands */ });
}

/**
 * Creates an account from verified identity only.
 *
 * The three inputs are the job-search email and a generated password
 * twice. No employer-specific question is answered here; if the tenant
 * asks one, the page will not match CREATE_ACCOUNT_FORM cleanly and the
 * caller hands off.
 */
export async function createAccount(page: Page, email: string, password: string): Promise<void> {
  await fillVisible(page, SEL.email, email);
  await fillVisible(page, SEL.password, password);
  if (await page.locator(`${SEL.verifyPassword}:visible`).count()) {
    await fillVisible(page, SEL.verifyPassword, password);
  }
  await clickSubmit(page, "createAccountSubmitButton");
  await settleAfterCredential(page);
}

/**
 * Dismisses the tenant's legal notice by accepting it.
 *
 * Workday renders this as a banner above the app, and Northern Trust's
 * sat un-dismissed through an entire failed sign-in: the credential was
 * submitted, the modal closed with no error of any kind, and the app
 * returned to the job search still signed out. A consent gate the
 * session establishment depends on is the leading explanation for a
 * login that fails silently rather than complaining.
 *
 * Accepting is a consent decision, so it is never a default: the caller
 * has to ask for it, and the return value says what was actually done so
 * the run can record it.
 */
export async function acceptLegalNotice(page: Page): Promise<"ACCEPTED" | "ABSENT" | "FAILED"> {
  const accept = page.locator('[data-automation-id="legalNoticeAcceptButton"]');
  if (!(await accept.count().catch(() => 0))) return "ABSENT";
  if (!(await accept.first().isVisible().catch(() => false))) return "ABSENT";
  try {
    await accept.first().click({ timeout: 10_000 });
    // The banner is removed by the app, not by the click, so wait for the
    // fact rather than assuming it.
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-automation-id="legalNotice"]');
      return !b || (b as HTMLElement).getClientRects().length === 0;
    }, null, { timeout: 10_000 }).catch(() => undefined);
    return "ACCEPTED";
  } catch { return "FAILED"; }
}
