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
 * Types a credential and submits, without ever putting it anywhere else.
 *
 * fill() sets the value directly; it is never logged, never returned,
 * and the caller holds it only for the length of this call.
 */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.waitForSelector(SEL.email, { state: "visible" });
  await page.fill(SEL.email, email);
  await page.fill(SEL.password, password);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => { /* SPA may not settle */ }),
    page.click(SEL.signInSubmit),
  ]);
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
  await page.waitForSelector(SEL.email, { state: "visible" });
  await page.fill(SEL.email, email);
  await page.fill(SEL.password, password);
  const verify = await page.$(SEL.verifyPassword);
  if (verify) await verify.fill(password);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => { /* SPA may not settle */ }),
    page.click(SEL.createSubmit),
  ]);
}
