/**
 * The first controlled Workday account creation, in two halves.
 *
 *   node scripts/workday-create-account.ts <host> --fill
 *
 * Half one fills the form and stops with it visible, consent UNCHECKED.
 * The browser stays open and the process waits for a sentinel file that
 * only appears when the user has read the terms, ticked the box, and
 * said to continue. Half two clicks Create Account.
 *
 * The consent control is never touched by this code. That is the user's
 * agreement to make, and a checkbox ticked by an automation is not one.
 *
 * ORDER OF OPERATIONS
 *
 * The password is written to the keychain BEFORE it is typed. An account
 * that exists with a password we did not keep is unrecoverable without a
 * reset; a keychain entry for an account that was never created is
 * harmless and self-correcting. So the harmless failure is the one this
 * risks.
 *
 * Anything on the form beyond email, password and verify-password stops
 * the run. A field this code did not expect is a question nobody has
 * answered, and filling it would be guessing.
 */
import { existsSync, unlinkSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { tenantFromUrl, candidateHomeUrl, urlBelongsToTenant } from "../lib/workday/tenant.ts";
import { tenantFromToken } from "../lib/workday/tenant.ts";
import { observe, waitForWorkdayReady, SEL, clickWorkdayButton } from "../lib/workday/probe.ts";
import { generatePassword, keychainRef, storePassword, readPassword } from "../lib/workday/keychain.ts";
import { ensureTenant, recordObservation, recordCredential } from "../lib/workday/store.ts";
import { sessionStateFrom } from "../lib/workday/authPlan.ts";

const host = process.argv[2];
if (!host) { console.error("usage: workday-create-account.ts <host> --fill"); process.exit(2); }
const GO = ".workday-consent-confirmed";
const ABORT = ".workday-abort";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: co } = await db.from("companies").select("id,name,ats_token").eq("ats_provider", "WORKDAY");
const company = (co ?? []).find((c: any) => { try { return tenantFromToken(c.ats_token).host === host; } catch { return false; } });
if (!company) { console.error(`no company for host ${host}`); process.exit(1); }
const tenant = tenantFromToken(company.ats_token);
const { data: profile } = await db.from("profile").select("email_job_search").single();
const email = profile!.email_job_search as string;

console.log(`${company.name}  ${tenant.host}/${tenant.site}`);
console.log(`email: ${email}`);

const ref = keychainRef(tenant.host);
// A credential from an earlier attempt that stopped before creating
// anything. Reused rather than regenerated: if that attempt did somehow
// create an account, this is the only password that opens it, and
// replacing it would strand the account.
const existing = await readPassword(ref);
if (existing) console.log("reusing the credential stored by an earlier attempt (no account was created then)");

const ctx = await launchApplicationContext();
const page = await ctx.newPage();
page.setDefaultTimeout(40_000);
const stop = async (why: string) => { console.log(`\nSTOP: ${why}`); await ctx.close(); process.exit(3); };

await page.goto(candidateHomeUrl(tenant), { waitUntil: "domcontentloaded" });
await waitForWorkdayReady(page);
if (!urlBelongsToTenant(page.url(), tenant)) await stop(`navigated off the tenant to ${tenantFromUrl(page.url())?.host}`);

// Reveal the sign-in modal, then switch to the creation form.
const signInBtn = await page.$('[data-automation-id="utilityButtonSignIn"]');
if (!signInBtn) await stop("no Sign In control on the careers page");
await signInBtn!.click();
await page.waitForSelector(SEL.email, { timeout: 25_000 });
const createLink = await page.$(SEL.createLink);
if (!createLink) await stop("no Create Account link on the sign-in form");
await createLink!.click();
await page.waitForSelector(SEL.verifyPassword, { timeout: 25_000 });

const o = await observe(page, tenant);
console.log(`page state: ${o.state}`);
if (o.state !== "CREATE_ACCOUNT_FORM") await stop(`expected a creation form, got ${o.state}`);
if (o.signals.captcha) await stop("a CAPTCHA is present");
if (o.signals.sso) await stop("an SSO prompt is present");

// Every visible control inside the modal. Anything unexpected stops.
const fields = await page.evaluate(() => {
  const modal = document.querySelector('[data-automation-id="signInContent"]')
    ?? document.querySelector('[data-automation-id="createAccountSubmitButton"]')?.closest("form")
    ?? document.body;
  return [...modal.querySelectorAll("input, select, textarea")]
    .filter((e) => e.getClientRects().length > 0)
    .map((e) => ({ id: e.getAttribute("data-automation-id") ?? "", type: (e as HTMLInputElement).type ?? e.tagName.toLowerCase(),
                   required: e.hasAttribute("required") || e.getAttribute("aria-required") === "true" }));
});
console.log(`visible fields in the modal: ${JSON.stringify(fields)}`);
const EXPECTED = new Set(["email", "password", "verifypassword", "createaccountcheckbox"]);
const unexpected = fields.filter((f: any) => !EXPECTED.has(f.id.toLowerCase()));
if (unexpected.length) await stop(`unexpected field(s) on the form: ${JSON.stringify(unexpected)}. Nothing is guessed.`);

// Keychain first. See the header.
const password = existing ?? generatePassword(28);
if (!existing) {
  await storePassword(ref, password);
  console.log(`credential stored in the keychain (${ref.service}:${ref.account}); it is not printed anywhere`);
}
await ensureTenant(db, tenant, company.id);

await page.fill(SEL.email, email);
await page.fill(SEL.password, password);
await page.fill(SEL.verifyPassword, password);
console.log("email, password and verify-password filled");

const consent = await page.$('[data-automation-id="createAccountCheckbox"]');
const checked = consent ? await consent.isChecked() : null;
console.log(`consent checkbox present=${Boolean(consent)} checked=${checked}  <- left for the user`);
if (checked) await stop("the consent box was already checked; this run did not do that and will not proceed");

console.log(`\nFORM IS FILLED AND VISIBLE. Consent is NOT checked.`);
console.log(`Waiting for ${GO} (or ${ABORT} to cancel). The browser stays open.`);

// Wait for the user's decision, watching the box as we go.
//
// The first attempt stopped here because the box read unchecked when the
// user said they had ticked it. The control is a real input with
// opacity:0 behind a styled span, so isChecked() does track it -- which
// means the click had not reached THIS window. Reporting every change
// makes that visible while it is still fixable, instead of at the end.
let lastSeen: boolean | null = null;
for (;;) {
  if (existsSync(ABORT)) { unlinkSync(ABORT); await stop("aborted by the user"); }
  const box = await page.$('[data-automation-id="createAccountCheckbox"]');
  const now = box ? await box.isChecked() : null;
  if (now !== lastSeen) {
    console.log(`  [${new Date().toISOString().slice(11, 19)}] consent checkbox: ${now ? "CHECKED" : "unchecked"}`);
    lastSeen = now;
  }
  if (existsSync(GO)) { unlinkSync(GO); break; }
  await new Promise((r) => setTimeout(r, 1500));
}

// The user says they have read the terms and ticked the box. Verify that
// is actually true before clicking anything: proceeding on an unchecked
// box would submit a form the user has not agreed to.
const nowChecked = await (await page.$('[data-automation-id="createAccountCheckbox"]'))?.isChecked();
if (!nowChecked) await stop("the consent box is still unchecked; nothing was clicked");
console.log("consent confirmed checked by the user; clicking Create Account");

await clickWorkdayButton(page, "Create Account");
await page.waitForLoadState("networkidle").catch(() => { /* SPA */ });
await waitForWorkdayReady(page, 25_000);
const after = await observe(page, tenant);
console.log(`\nafter creation: ${after.state}`);

const authenticated = after.state === "SIGNED_IN";
await recordObservation(db, {
  host: tenant.host, pageState: after.state,
  sessionState: sessionStateFrom(after.state, false),
  accountState: after.state === "SIGNED_IN" || after.state === "ACCOUNT_EXISTS" ? "EXISTS" : "CREATING",
  handoffReason: authenticated ? null : `account creation ended on ${after.state}`,
  authenticated,
});
if (authenticated || after.state === "EMAIL_VERIFICATION") await recordCredential(db, tenant.host, true);

if (after.state === "EMAIL_VERIFICATION") console.log("HANDOFF: the tenant wants email verification. Not automated.");
else if (!authenticated) console.log(`HANDOFF: ended on ${after.state}`);
else console.log("account created and the session is live");
await ctx.close();
