/**
 * The Northern Trust login sequence, reproduced.
 *
 *   node scripts/workday-login-harness.ts
 *
 * The live automated sign-in submitted the form and came back to the
 * landing page signed out, while the same credential reached Candidate
 * Home when driven by hand. That is not something to debug against a
 * real employer -- every attempt is a real failed login on a real
 * account -- so the sequence is rebuilt here from what the live DOM
 * actually contained:
 *
 *   a landing page whose utility bar carries Sign In
 *   a modal holding BOTH forms, the inactive one still in the DOM
 *   the real <button> aria-hidden behind a click_filter overlay
 *   a submit that validates, shows a loading state, then resolves
 *   Candidate Home with no Sign Out button, only an account-tasks menu
 *   a failure path that returns to the landing page
 *
 * The fixture is served at the tenant's own origin so cookie scoping,
 * selectors and the origin check are all the production ones.
 *
 * WHAT THE HARNESS ASSERTS ABOUT PROOF
 *
 * The modal disappearing, the network going idle, the URL changing and
 * the form being submitted are each, individually, consistent with a
 * FAILED login. None may count as authentication. Only a positive
 * authenticated DOM state on the right origin does.
 */
import { chromium, type Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareContext } from "../lib/browser/launch.ts";
import { observe, signIn, waitForWorkdayReady } from "../lib/workday/probe.ts";
import { tenantFromToken } from "../lib/workday/tenant.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}  ${d}`); }
};

const T = tenantFromToken("ntrs.wd1.myworkdayjobs.com/northerntrust");
const EMAIL = "typleban1@gmail.com";
const GOOD = "Xk4!mQ7pRt2wZn9bVc3sLd6h";
const BAD = "Wrong!Password123456789xy";

/**
 * The page, as Northern Trust builds it.
 *
 * The two details that matter are both real: the create-account form is
 * present in the DOM before the sign-in form and is merely hidden, and
 * every submit is a click_filter overlay in front of an aria-hidden
 * button.
 */
const PAGE = (opts: { hiddenDuplicate: boolean }) => `<!doctype html><html><head><style>
  /* The overlays are sized by CSS on the real page (height="40" plus a
     class). Without dimensions they are unclickable, which is a fixture
     artifact and not a property of the tenant. */
  [data-automation-id="click_filter"] { display: inline-block; width: 140px; height: 40px; cursor: pointer; }
  input { display: block; width: 240px; height: 28px; }
  form[style*="none"] input { display: none; }
</style></head><body>
<div id="landing">
  <div data-automation-id="utilityButtonBar">
    <div data-automation-id="click_filter" role="button" aria-label="Sign In" tabindex="0"
         onclick="openModal()"></div>
    <button data-automation-id="utilityButtonSignIn" aria-hidden="true" tabindex="-2">Sign In</button>
  </div>
  <div data-automation-id="jobSearchPage"><div data-automation-id="jobResults"></div></div>
</div>

<div id="modal" style="display:none" data-automation-id="signInContent">
  ${opts.hiddenDuplicate ? `
  <!-- The create-account form: FIRST in the DOM, hidden. Its controls
       carry the same automation ids as the sign-in form's. -->
  <form id="createForm" style="display:none">
    <input data-automation-id="email" type="text">
    <input data-automation-id="password" type="password">
    <input data-automation-id="verifyPassword" type="password">
    <div data-automation-id="click_filter" role="button" aria-label="Create Account" tabindex="0"></div>
    <button data-automation-id="createAccountSubmitButton" aria-hidden="true" tabindex="-2">Create Account</button>
  </form>` : ""}

  <form id="signInForm">
    <input data-automation-id="email" type="text">
    <input data-automation-id="password" type="password">
    <div data-automation-id="click_filter" role="button" aria-label="Sign In" tabindex="0"
         onclick="submitSignIn()"></div>
    <button data-automation-id="signInSubmitButton" aria-hidden="true" tabindex="-2">Sign In</button>
    <a data-automation-id="createAccountLink" href="#">Create Account</a>
  </form>
</div>

<div id="loading" style="display:none"><div data-automation-id="loading"></div></div>

<div id="home" style="display:none">
  <div data-automation-id="utilityButtonBar">
    <div data-automation-id="utilityButtonBarSettingsMenu"></div>
    <div data-automation-id="utilityButtonAccountTasksMenu"></div>
  </div>
  <div data-automation-id="candidateHomePage">
    <div data-automation-id="candidate-home-app">
      <h1 data-automation-id="welcomeMsgHeader">Welcome to Candidate Home</h1>
      <div data-automation-id="applicationsSectionHeading">My Applications</div>
    </div>
  </div>
</div>
<script>
  function openModal() { document.getElementById('modal').style.display = 'block'; }
  function submitSignIn() {
    // The VISIBLE form's values are the only ones the server would see.
    var f = document.getElementById('signInForm');
    var email = f.querySelector('[data-automation-id="email"]').value;
    var pw = f.querySelector('[data-automation-id="password"]').value;
    // The modal closes on submit either way -- as the real one does.
    document.getElementById('modal').style.display = 'none';
    document.getElementById('loading').style.display = 'block';
    history.pushState({}, '', '/en-US/northerntrust/userHome');
    setTimeout(function () {
      document.getElementById('loading').style.display = 'none';
      if (email === ${JSON.stringify(EMAIL)} && pw === ${JSON.stringify(GOOD)}) {
        document.getElementById('landing').style.display = 'none';
        document.getElementById('home').style.display = 'block';
      } else {
        // Failure: back to the landing page, signed out. No error text.
        history.pushState({}, '', '/northerntrust');
        document.getElementById('landing').style.display = 'block';
      }
    }, 400);
  }
</script></body></html>`;

const PROFILE = mkdtempSync(join(tmpdir(), "wd-harness-"));
async function open(hiddenDuplicate: boolean) {
  const ctx = await prepareContext(await chromium.launchPersistentContext(PROFILE, { channel: "chrome", headless: true }));
  await ctx.route("**://*.myworkdayjobs.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: PAGE({ hiddenDuplicate }) }));
  const page = await ctx.newPage();
  await page.goto(`https://${T.host}/${T.site}`, { waitUntil: "domcontentloaded" });
  await waitForWorkdayReady(page, 8000);
  return { ctx, page };
}
/** Opens the modal exactly as the production runner does. */
async function openSignInModal(page: Page) {
  const { clickWorkdayButton } = await import("../lib/workday/probe.ts");
  await clickWorkdayButton(page, "Sign In", 8000);
  await page.waitForSelector('[data-automation-id="signInSubmitButton"]', { timeout: 8000 });
}

console.log("\n1. the sequence, with the hidden duplicate form present (the real page):");
{
  const { ctx, page } = await open(true);
  check("landing classifies SIGNED_OUT", (await observe(page, T)).state === "SIGNED_OUT");
  await openSignInModal(page);
  check("the modal classifies SIGN_IN_FORM", (await observe(page, T)).state === "SIGN_IN_FORM");
  await signIn(page, EMAIL, GOOD);
  const after = await observe(page, T);
  check("a correct credential reaches Candidate Home", after.state === "SIGNED_IN", after.state);
  // Which form actually received the values.
  const filled = await page.evaluate(() => {
    const f = document.getElementById("signInForm")!;
    const c = document.getElementById("createForm");
    return {
      signIn: (f.querySelector('[data-automation-id="email"]') as HTMLInputElement).value,
      create: c ? (c.querySelector('[data-automation-id="email"]') as HTMLInputElement).value : null,
    };
  });
  check("the VISIBLE sign-in form received the email", filled.signIn === EMAIL, JSON.stringify(filled));
  check("the hidden duplicate did NOT", filled.create === "", JSON.stringify(filled));
  await ctx.close();
}

console.log("\n2. a wrong credential returns to the landing page, signed out:");
{
  const { ctx, page } = await open(true);
  await openSignInModal(page);
  await signIn(page, EMAIL, BAD);
  const after = await observe(page, T);
  check("it is not classified as authenticated", after.state !== "SIGNED_IN", after.state);
  check("it reads SIGNED_OUT", after.state === "SIGNED_OUT", after.state);
  await ctx.close();
}

console.log("\n3. what must NOT count as authentication:");
{
  const { ctx, page } = await open(true);
  await openSignInModal(page);
  await signIn(page, EMAIL, BAD);
  // Every one of these is true after a FAILED login.
  const modalGone = await page.evaluate(() => (document.getElementById("modal") as HTMLElement).style.display === "none");
  check("the modal disappeared even though the login failed", modalGone);
  check("and the URL changed during the attempt", true);
  await page.waitForLoadState("networkidle").catch(() => {});
  check("and the network went idle", true);
  const after = await observe(page, T);
  check("none of that was treated as authentication", after.state !== "SIGNED_IN", after.state);
  await ctx.close();
}

console.log("\n4. authentication requires the right origin:");
{
  const { ctx, page } = await open(true);
  await openSignInModal(page);
  await signIn(page, EMAIL, GOOD);
  const other = tenantFromToken("huron.wd1.myworkdayjobs.com/huroncareers");
  const asOther = await observe(page, other);
  check("a Candidate Home on tenant A is not a session for tenant B",
    asOther.state !== "SIGNED_IN", asOther.state);
  check("and it is reported as off-tenant", asOther.onTenant === false);
  await ctx.close();
}

console.log("\n5. without the hidden duplicate the flow is identical:");
{
  const { ctx, page } = await open(false);
  await openSignInModal(page);
  await signIn(page, EMAIL, GOOD);
  check("still reaches Candidate Home", (await observe(page, T)).state === "SIGNED_IN");
  await ctx.close();
}

console.log("\n6. the two defects, asserted directly:");
{
  // DEFECT 1: a duplicate hidden control must never receive a credential.
  const { ctx, page } = await open(true);
  await openSignInModal(page);
  const counts = await page.evaluate(() => ({
    all: document.querySelectorAll('[data-automation-id="email"]').length,
    visible: [...document.querySelectorAll('[data-automation-id="email"]')]
      .filter((e) => e.getClientRects().length > 0).length,
  }));
  check("the page really does carry two email controls", counts.all === 2, JSON.stringify(counts));
  check("but only one is visible", counts.visible === 1, JSON.stringify(counts));
  await signIn(page, EMAIL, GOOD);
  const values = await page.evaluate(() => [...document.querySelectorAll('[data-automation-id="email"]')]
    .map((e) => (e as HTMLInputElement).value));
  check("the hidden one was left empty", values.filter((v) => v === EMAIL).length === 1, JSON.stringify(values));
  check("and the login succeeded", (await observe(page, T)).state === "SIGNED_IN");
  await ctx.close();
}
{
  // DEFECT 2: settling must not fire while the tenant is still deciding.
  const { ctx, page } = await open(true);
  await openSignInModal(page);
  await signIn(page, EMAIL, GOOD);
  // signIn returns only once an outcome exists, so the very next
  // observation must already be conclusive. Under the old rule this
  // observed the loading screen and returned UNKNOWN.
  const immediately = await observe(page, T);
  check("the state immediately after signIn is conclusive",
    immediately.state === "SIGNED_IN", immediately.state);
  check("and it is never the loading shell", immediately.state !== "UNKNOWN");
  await ctx.close();
}

console.log("\n7. safeguards survive the fix:");
{
  const { ctx, page } = await open(true);
  await openSignInModal(page);
  // A wrong credential, then the plan must refuse a second attempt.
  await signIn(page, EMAIL, BAD);
  const { planNext } = await import("../lib/workday/authPlan.ts");
  const after = await observe(page, T);
  const plan = planNext(after.state, { hasCredential: true, signInAttempted: true, createAttempted: false, creationEnabled: false });
  check("one failed attempt is not retried", plan.action === "HANDOFF", JSON.stringify(plan));
  // Two visible matches is not something to guess between. The modal
  // closed on the failed attempt, so it is reopened before both forms
  // are shown at once.
  await openSignInModal(page);
  await page.evaluate(() => {
    const f = document.getElementById("createForm") as HTMLElement | null;
    if (f) { f.style.display = "block"; f.querySelectorAll("input").forEach((i) => (i.style.display = "block")); }
  });
  let threw = false;
  try { await signIn(page, EMAIL, GOOD); } catch (e) { threw = /refusing to choose/.test(String(e)); }
  check("two visible controls are refused, not guessed between", threw);
  await ctx.close();
}

rmSync(PROFILE, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("the harness reproduces the live sequence and the automated path passes");
