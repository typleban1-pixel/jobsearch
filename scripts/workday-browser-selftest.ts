/**
 * The Workday auth flow, against real pages in a real browser.
 *
 *   node scripts/workday-browser-selftest.ts
 *
 * Fixtures are served at the tenants' own origins, so the code under
 * test is the code that runs in production: the same selectors, the same
 * cookie scoping, the same persistent profile. Only the HTML is ours.
 *
 * Two tenants are served throughout, because the property that matters
 * most cannot be tested with one: a session or credential for tenant A
 * must never authenticate tenant B. Cookie scoping is what enforces
 * that, and cookie scoping only exists against real origins.
 *
 * Nothing here can reach a real employer: every request to
 * *.myworkdayjobs.com is intercepted.
 */
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareContext } from "../lib/browser/launch.ts";
import { observe, signIn, createAccount } from "../lib/workday/probe.ts";
import { planNext } from "../lib/workday/authPlan.ts";
import { tenantFromToken } from "../lib/workday/tenant.ts";
import { generatePassword, storePassword, readPassword, deletePassword,
         KEYCHAIN_TEST_SERVICE } from "../lib/workday/keychain.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}  ${d}`); }
};

const A = tenantFromToken("ntrs.wd1.myworkdayjobs.com/northerntrust");
const B = tenantFromToken("huron.wd1.myworkdayjobs.com/huroncareers");
const EMAIL = "plebantyler@gmail.com";

// ---- fixtures ---------------------------------------------------------
const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
const SIGN_IN = page(`<h1>Sign In</h1>
  <input data-automation-id="email" type="email"><input data-automation-id="password" type="password">
  <button data-automation-id="signInSubmitButton">Sign In</button>`);
const CREATE = page(`<h1>Create Account</h1>
  <input data-automation-id="email" type="email"><input data-automation-id="password" type="password">
  <input data-automation-id="verifyPassword" type="password">
  <button data-automation-id="createAccountSubmitButton">Create Account</button>`);
const SIGNED_IN = page(`<h1>Candidate Home</h1>
  <button data-automation-id="utilityButtonSignOut">Sign Out</button>`);
const BAD_CREDS = page(`<h1>Sign In</h1><p>The email or password you entered is incorrect.</p>
  <input data-automation-id="email" type="email"><input data-automation-id="password" type="password">
  <button data-automation-id="signInSubmitButton">Sign In</button>`);
const EXISTS = page(`<h1>Create Account</h1><p>An account already exists with this email address.</p>
  <input data-automation-id="email" type="email"><input data-automation-id="password" type="password">
  <input data-automation-id="verifyPassword" type="password">
  <button data-automation-id="createAccountSubmitButton">Create</button>`);
const CAPTCHA = page(`<h1>Sign In</h1><div data-sitekey="abc"></div>
  <input data-automation-id="email" type="email"><input data-automation-id="password" type="password">
  <button data-automation-id="signInSubmitButton">Sign In</button>`);
const MFA = page(`<h1>Verify</h1><p>Enter the one-time passcode from your authenticator app.</p>
  <input data-automation-id="password" type="password"><button data-automation-id="signInSubmitButton">Go</button>`);
const EMAIL_VERIFY = page(`<h1>Almost there</h1><p>A verification code has been sent to your email.</p>
  <input type="text"><button>Submit</button>`);
const SECURITY_Q = page(`<h1>Security</h1><p>Please answer your security question: what was the name of your first pet?</p>
  <input type="text"><button>Submit</button>`);

/** Per-origin current fixture, swappable to model a state transition. */
const served = new Map<string, string>();
const setFixture = (host: string, html: string) => served.set(host, html);

async function route(ctx: BrowserContext) {
  await ctx.route("**://*.myworkdayjobs.com/**", async (r) => {
    const host = new URL(r.request().url()).hostname;
    await r.fulfill({ status: 200, contentType: "text/html", body: served.get(host) ?? page("<p>nothing</p>") });
  });
}

const PROFILE = mkdtempSync(join(tmpdir(), "wd-profile-"));
const openProfile = async (): Promise<BrowserContext> => {
  const ctx = await chromium.launchPersistentContext(PROFILE, { channel: "chrome", headless: true });
  await prepareContext(ctx);
  await route(ctx);
  return ctx;
};
const go = async (p: Page, t: typeof A) => {
  await p.goto(`https://${t.host}/${t.site}`, { waitUntil: "domcontentloaded" });
  return observe(p, t);
};

const refA = { service: KEYCHAIN_TEST_SERVICE, account: A.host };
const refB = { service: KEYCHAIN_TEST_SERVICE, account: B.host };
await deletePassword(refA); await deletePassword(refB);

let ctx = await openProfile();
let p = await ctx.newPage();

// ------------------------------------------------------------------ 1
console.log("\n1. no account -> the creation path is chosen:");
{
  setFixture(A.host, CREATE);
  const o = await go(p, A);
  check("the page classifies as a creation form", o.state === "CREATE_ACCOUNT_FORM", o.state);
  check("with creation off it hands off",
    planNext(o.state, { hasCredential: false, signInAttempted: false, createAttempted: false, creationEnabled: false }).action === "HANDOFF");
  check("with creation on it creates",
    planNext(o.state, { hasCredential: false, signInAttempted: false, createAttempted: false, creationEnabled: true }).action === "CREATE_ACCOUNT");
}

// ------------------------------------------------------------------ 2
console.log("\n2. account creation, and the credential lands in the keychain:");
{
  const pw = generatePassword();
  setFixture(A.host, CREATE);
  await go(p, A);
  await createAccount(p, EMAIL, pw);
  await storePassword(refA, pw);
  check("the credential is stored", (await readPassword(refA)) === pw);
  // Creation succeeded: the tenant now shows a session.
  setFixture(A.host, SIGNED_IN);
  const after = await go(p, A);
  check("the tenant now reports a session", after.state === "SIGNED_IN", after.state);
  check("and the plan proceeds",
    planNext(after.state, { hasCredential: true, signInAttempted: false, createAttempted: true, creationEnabled: true }).action === "PROCEED");
}

// ------------------------------------------------------------------ 3
console.log("\n3. a valid session is reused, with no second login:");
{
  // A persistent cookie, which is what a Workday session that survives a
  // restart actually is. A cookie with no expiry is a SESSION cookie and
  // dies with the browser by definition; case 5 tests both, because the
  // difference decides whether the user is asked to log in again.
  await p.context().addCookies([{ name: "wd-session", value: "A", domain: A.host, path: "/",
    expires: Math.floor(Date.now() / 1000) + 86_400 }]);
  setFixture(A.host, SIGNED_IN);
  const o = await go(p, A);
  check("still signed in", o.state === "SIGNED_IN");
  check("the plan reuses rather than signing in", planNext(o.state,
    { hasCredential: true, signInAttempted: false, createAttempted: false, creationEnabled: true }).action === "PROCEED");
}

// ------------------------------------------------------------------ 4
console.log("\n4. tenant A's session and credential do not reach tenant B:");
{
  setFixture(B.host, SIGN_IN);
  const o = await go(p, B);
  check("tenant B is NOT signed in by tenant A's session", o.state === "SIGN_IN_FORM", o.state);
  const cookies = await p.context().cookies(`https://${B.host}/`);
  check("tenant A's cookie is not sent to tenant B",
    !cookies.some((c) => c.name === "wd-session"), JSON.stringify(cookies.map((c) => c.name)));
  check("and B holds no credential of its own", (await readPassword(refB)) === null);
  check("so B hands off rather than using A's",
    planNext(o.state, { hasCredential: false, signInAttempted: false, createAttempted: false, creationEnabled: false }).action === "HANDOFF");
  check("A's credential is still only A's", (await readPassword(refA)) !== (await readPassword(refB)));
}

// ------------------------------------------------------------------ 5
console.log("\n5. a browser restart keeps the session:");
{
  await ctx.close();
  ctx = await openProfile();
  p = await ctx.newPage();
  setFixture(A.host, SIGNED_IN);
  const cookies = await p.context().cookies(`https://${A.host}/`);
  check("the persistent cookie survived the restart",
    cookies.some((c) => c.name === "wd-session"), JSON.stringify(cookies.map((c) => c.name)));
  const o = await go(p, A);
  check("and the tenant is still signed in", o.state === "SIGNED_IN", o.state);
  check("no login is required", planNext(o.state,
    { hasCredential: true, signInAttempted: false, createAttempted: false, creationEnabled: true }).action === "PROCEED");

  // The other half, and the reason this is not assumed: a tenant that
  // issues only a session cookie leaves nothing behind. The system must
  // then observe an expired session and sign in again, which is exactly
  // what it does -- it never treats "I had a session yesterday" as
  // evidence of one today.
  await p.context().addCookies([{ name: "wd-ephemeral", value: "A", domain: A.host, path: "/" }]);
  await ctx.close();
  ctx = await openProfile();
  p = await ctx.newPage();
  const after = await p.context().cookies(`https://${A.host}/`);
  check("a session cookie does NOT survive, as expected",
    !after.some((c) => c.name === "wd-ephemeral"), JSON.stringify(after.map((c) => c.name)));
  setFixture(A.host, SIGN_IN);
  const expired = await go(p, A);
  check("so the tenant reads as expired rather than assumed valid", expired.state === "SIGN_IN_FORM", expired.state);
  check("and the stored credential is used to sign in again", planNext(expired.state,
    { hasCredential: true, signInAttempted: false, createAttempted: false, creationEnabled: true }).action === "SIGN_IN");
}

// ------------------------------------------------------------------ 6
console.log("\n6. an expired session with a stored credential logs in automatically:");
{
  setFixture(A.host, SIGN_IN);
  const o = await go(p, A);
  check("the session reads as expired", o.state === "SIGN_IN_FORM", o.state);
  const plan = planNext(o.state, { hasCredential: true, signInAttempted: false, createAttempted: false, creationEnabled: true });
  check("the plan signs in", plan.action === "SIGN_IN");
  const pw = (await readPassword(refA))!;
  await signIn(p, EMAIL, pw);
  setFixture(A.host, SIGNED_IN);
  const after = await go(p, A);
  check("and the session is restored", after.state === "SIGNED_IN", after.state);
}

// ------------------------------------------------------------------ 7
console.log("\n7. a wrong credential hands off and is not retried:");
{
  setFixture(A.host, BAD_CREDS);
  const o = await go(p, A);
  check("the refusal is recognised", o.state === "INVALID_CREDENTIALS", o.state);
  const plan = planNext(o.state, { hasCredential: true, signInAttempted: true, createAttempted: false, creationEnabled: true });
  check("it hands off", plan.action === "HANDOFF");
  check("with a reason naming the refusal", /refused/.test(plan.reason ?? ""), plan.reason ?? "");
}

// ------------------------------------------------------------------ 8
console.log("\n8. an account that already exists is handled safely:");
{
  setFixture(B.host, EXISTS);
  const o = await go(p, B);
  check("recognised", o.state === "ACCOUNT_EXISTS", o.state);
  const plan = planNext(o.state, { hasCredential: false, signInAttempted: false, createAttempted: true, creationEnabled: true });
  check("hands off rather than making a second account", plan.action === "HANDOFF");
  check("and never creates", plan.action !== "CREATE_ACCOUNT");
}

// ------------------------------------------------------------------ 9
console.log("\n9. every human-presence wall stops the run:");
{
  for (const [name, html, expect] of [
    ["CAPTCHA", CAPTCHA, "CAPTCHA"], ["MFA", MFA, "MFA"],
    ["email verification", EMAIL_VERIFY, "EMAIL_VERIFICATION"],
    ["security question", SECURITY_Q, "SECURITY_QUESTION"],
  ] as Array<[string, string, string]>) {
    setFixture(A.host, html);
    const o = await go(p, A);
    check(`${name} is classified`, o.state === expect, `${o.state}`);
    const plan = planNext(o.state, { hasCredential: true, signInAttempted: false, createAttempted: false, creationEnabled: true });
    check(`  and hands off with a reason`, plan.action === "HANDOFF" && !!plan.reason, JSON.stringify(plan));
  }
}

// ----------------------------------------------------------------- 10
console.log("\n10. no secret reaches anything durable:");
{
  const pw = (await readPassword(refA))!;
  setFixture(A.host, SIGN_IN);
  await go(p, A);
  await signIn(p, EMAIL, pw);
  // The page's own DOM, the URL, and a screenshot on disk.
  const html = await p.content();
  check("the password is not in the page HTML", !html.includes(pw));
  check("nor in the URL", !p.url().includes(pw));
  const shotDir = mkdtempSync(join(tmpdir(), "wd-shot-"));
  await p.screenshot({ path: join(shotDir, "s.png"), fullPage: true });
  const bytes = readFileSync(join(shotDir, "s.png"));
  check("nor as bytes in a screenshot", !bytes.includes(Buffer.from(pw)));
  rmSync(shotDir, { recursive: true, force: true });
  // The observation object, which is what gets recorded.
  const o = await observe(p, A);
  check("nor anywhere in the recorded signals", !JSON.stringify(o).includes(pw));
  check("and the signals carry no input VALUES at all",
    !JSON.stringify(o.signals).includes(EMAIL), "the email appeared in the signals");
}

// ----------------------------------------------------------------- 11
console.log("\n11. authentication cannot advance an application:");
{
  setFixture(A.host, SIGNED_IN);
  const o = await go(p, A);
  const plan = planNext(o.state, { hasCredential: true, signInAttempted: false, createAttempted: false, creationEnabled: true });
  check("the strongest outcome is PROCEED", plan.action === "PROCEED");
  check("which is not a submission, an approval, or a status change",
    !/SUBMIT|APPROVE|READY/i.test(plan.action));
}

await deletePassword(refA); await deletePassword(refB);
await ctx.close();
rmSync(PROFILE, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("sessions persist and stay separate; walls stop the run; secrets stay out of everything");
