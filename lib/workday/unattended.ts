/**
 * The live dependencies for an unattended Workday authentication.
 *
 * Everything the loop in authenticate.ts needs from a real browser, in
 * one place: observing the page, opening the sign-in form, typing the
 * stored credential, creating an account, and completing the tenant's
 * email verification from the person's own inbox.
 *
 * TWO CONSENT CONTROLS, ONE AUTHORISATION
 *
 * Ty said in chat on 2026-09-07: "yes tick the checkbox for me". That
 * sentence is the authority for the two things below that the earlier
 * scripts refused to touch: the create-account terms checkbox and the
 * tenant's legal-notice banner. Both are the person's agreement with the
 * employer; the person made it once, here, for every tenant, and the
 * text of that authorisation travels with every account this creates
 * (WORKDAY_ACCOUNT_CREATED events). Revoke it by emptying
 * CONSENT_AUTHORISATION, which makes createAccount refuse.
 *
 * WHAT STAYS OUT OF REACH
 *
 * CAPTCHAs, MFA, security questions and SSO prompts are still handoffs.
 * The password is random, lives in the login keychain, and is read only
 * for the length of the call that types it.
 */
import type { Page } from "playwright";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkdayTenant } from "./tenant.ts";
import { urlBelongsToTenant } from "./tenant.ts";
import { observe, waitForWorkdayReady, SEL, signIn as doSignIn, clickWorkdayButton, submitCredentialForm, captureVerdict, acceptLegalNotice } from "./probe.ts";
import { generatePassword, keychainRef, storePassword, readPassword } from "./keychain.ts";
import { ensureTenant, recordCredential } from "./store.ts";
import type { AuthDeps } from "./authenticate.ts";
import { searchIds, getMessage, buildQuery } from "../gmail/client.ts";
import { withVerificationCode, type GmailDeps } from "../gmail/otp.ts";
import { readPageContext } from "../applications/verificationStep.ts";

export const CONSENT_AUTHORISATION =
  "Ty, in chat, 2026-09-07: \"yes tick the checkbox for me\" (Workday account terms and legal notices, every tenant)";

/** Senders a Workday tenant's own mail arrives from. */
const WORKDAY_SENDERS = ["myworkday.com", "workday.com", "myworkdayjobs.com"];

export interface UnattendedOptions {
  db: SupabaseClient;
  page: Page;
  tenant: WorkdayTenant;
  companyId: string | null;
  companyName: string;
  applicationId: string;
  email: string;
  log?: (line: string) => void;
}

export function unattendedDeps(o: UnattendedOptions): AuthDeps {
  const log = o.log ?? ((l: string) => console.log(`    ${l}`));
  const ref = keychainRef(o.tenant.host);
  const { page, tenant } = o;
  let verificationRequestedAt = new Date();
  const evidenceDir = `.workday-auth/${tenant.host}-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  const tickConsent = async (): Promise<boolean> => {
    if (!CONSENT_AUTHORISATION) return false;
    const box = page.locator('[data-automation-id="createAccountCheckbox"]');
    if (!(await box.count().catch(() => 0))) return true;          // this tenant asks for none
    if (await box.first().isChecked().catch(() => false)) return true;
    // The real input is opacity:0 behind a styled control; clicking the
    // label is what a person does and what registers.
    const label = page.locator("label[for]").filter({ hasText: /terms|agree|consent|privacy/i }).first();
    if (await label.count().catch(() => 0)) await label.click({ timeout: 5_000 }).catch(() => undefined);
    if (!(await box.first().isChecked().catch(() => false))) await box.first().check({ force: true, timeout: 5_000 }).catch(() => undefined);
    return box.first().isChecked().catch(() => false);
  };

  return {
    email: o.email,
    observe: async () => {
      await waitForWorkdayReady(page, 15_000).catch(() => undefined);
      const obs = await observe(page, tenant);
      log(`observed: ${obs.state}`);
      return { state: obs.state, url: obs.signals.url };
    },
    openSignIn: async () => {
      log("opening the sign-in form");
      await clickWorkdayButton(page, "Sign In", 30_000).catch(async () => {
        const b = await page.$('[data-automation-id="utilityButtonSignIn"]');
        if (b) await b.click({ timeout: 20_000 });
      });
      await page.waitForSelector(SEL.email, { timeout: 20_000 }).catch(() => undefined);
    },
    signIn: async (email, password) => {
      log("signing in with the stored credential");
      const how = await doSignIn(page, email, password);
      const said = await captureVerdict(page, evidenceDir, `after-sign-in-${Date.now() % 100000}`);
      log(`sign-in form submitted (${how})${said.length ? `  says: ${said.join(" | ").slice(0, 200)}` : ""}`);
    },
    readCredential: () => readPassword(ref),
    createAccount: async (email) => {
      if (!CONSENT_AUTHORISATION) throw new Error("account creation is not authorised");
      // On the sign-in form, switch to the creation form.
      if (!(await page.locator(`${SEL.verifyPassword}:visible`).count().catch(() => 0))) {
        const link = page.locator(SEL.createLink).first();
        if (await link.count().catch(() => 0)) { await link.click({ timeout: 10_000 }).catch(() => undefined); }
        await page.waitForSelector(`${SEL.verifyPassword}:visible`, { timeout: 15_000 }).catch(() => undefined);
      }
      // Anything beyond email, password, verify and the consent box is a
      // question nobody answered; refuse rather than guess.
      const fields: string[] = await page.evaluate(() =>
        [...document.querySelectorAll('[data-automation-id="signInContent"] input, form input')]
          .filter((e) => e.getClientRects().length > 0)
          .map((e) => (e.getAttribute("data-automation-id") ?? "").toLowerCase()).filter(Boolean));
      const unexpected = fields.filter((f) => !["email", "password", "verifypassword", "createaccountcheckbox"].includes(f));
      if (unexpected.length) throw new Error(`unexpected field(s) on the creation form: ${unexpected.join(", ")}`);

      // Keychain first: an account whose password we did not keep is
      // unrecoverable; a keychain entry with no account is harmless.
      const existing = await readPassword(ref);
      const password = existing ?? generatePassword(28);
      if (!existing) { await storePassword(ref, password); log("credential stored in the keychain before anything is typed"); }
      await ensureTenant(o.db, tenant, o.companyId);

      await page.fill(SEL.email, email);
      await page.fill(SEL.password, password);
      await page.fill(SEL.verifyPassword, password);
      const consented = await tickConsent();
      if (!consented) throw new Error("the consent checkbox could not be ticked");
      log("creation form filled; consent ticked under the recorded authorisation");
      verificationRequestedAt = new Date();
      // The submit is the creation form's own button, by automation id:
      // the utility bar has no "Create Account", but clicking by name is
      // how the sign-in submit was once confused with the utility one.
      await captureVerdict(page, evidenceDir, "creation-form-filled");
      const how = await submitCredentialForm(page, "createAccountSubmitButton", 20_000);
      log(`creation form submitted (${how})`);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      await waitForWorkdayReady(page, 25_000).catch(() => undefined);
      // What the tenant said, so a creation that did not take is
      // explained by its own words rather than by the next state.
      const said = await captureVerdict(page, evidenceDir, "after-create-account");
      log(`after Create Account: ${page.url()}${said.length ? `  says: ${said.join(" | ").slice(0, 300)}` : ""}  (evidence ${evidenceDir})`);
      await recordCredential(o.db, tenant.host, true);
      await o.db.from("application_events").insert({
        application_id: o.applicationId, event: "WORKDAY_ACCOUNT_CREATED", actor: "worker",
        detail: `An account was created on ${tenant.host} for ${email}. The terms checkbox was ticked on the person's authorisation: ${CONSENT_AUTHORISATION}. The password is in the macOS login keychain (${ref.service}:${ref.account}) and nowhere else.`,
      }).then(() => undefined, () => undefined);
    },
    verifyEmail: async () => {
      const gmail: GmailDeps = { searchIds, getMessage, now: () => Date.now() };
      const state = await readPageContext(page);
      // A code box on the page: the shared, gated code path.
      const codeInputs = page.locator("input[autocomplete='one-time-code'], input[name*='code' i], input[aria-label*='code' i], input[data-automation-id*='code' i]");
      if (await codeInputs.count().catch(() => 0)) {
        for (let attempt = 0; attempt < 12; attempt++) {
          const r = await withVerificationCode({
            applicationId: o.applicationId, employer: { name: o.companyName, domain: null },
            boardSenders: WORKDAY_SENDERS, recipient: o.email, requestedAt: verificationRequestedAt, page: state,
          } as any, gmail, async (code) => {
            await codeInputs.first().fill(code);
            await clickWorkdayButton(page, "Verify", 10_000).catch(() => clickWorkdayButton(page, "Submit", 10_000).catch(() => undefined));
            return "OK";
          });
          if (r.ok) { log("verification code entered from the inbox"); return "ATTEMPTED"; }
          if (!/no message matched|no message survived/.test(r.reason)) { log(`verification: ${r.reason}`); return "HANDOFF"; }
          await new Promise((res) => setTimeout(res, 5_000));
        }
        return "HANDOFF";
      }
      // Otherwise the tenant mailed a link. Find the one message from a
      // Workday sender, to this address, newer than the request, that
      // carries a link on this tenant's own host, and open it here.
      for (let attempt = 0; attempt < 12; attempt++) {
        const ids = await searchIds(buildQuery({ from: WORKDAY_SENDERS, withinDays: 1 }), 10).catch(() => [] as string[]);
        for (const id of ids) {
          const m = await getMessage(id).catch(() => null);
          if (!m || m.internalDate < verificationRequestedAt.getTime() - 60_000) continue;
          if (!m.to.toLowerCase().includes(o.email.toLowerCase())) continue;
          const links = (m.text.match(/https?:\/\/[^\s<>"')]+/g) ?? []).filter((u) => urlBelongsToTenant(u, tenant));
          if (!links.length) continue;
          log(`opening the verification link from message ${id}`);
          await page.goto(links[0]!, { waitUntil: "domcontentloaded" }).catch(() => undefined);
          await waitForWorkdayReady(page, 25_000).catch(() => undefined);
          return "ATTEMPTED";
        }
        await new Promise((res) => setTimeout(res, 5_000));
      }
      log("no verification message arrived within a minute");
      return "HANDOFF";
    },
  };
}

/** The legal-notice banner, accepted under the same authorisation. */
export async function acceptLegalIfAuthorised(page: Page): Promise<string> {
  if (!CONSENT_AUTHORISATION) return "NOT_AUTHORISED";
  return acceptLegalNotice(page);
}
