/**
 * The verification seam, against real pages in a real browser.
 *
 *   node scripts/otp-integration-selftest.ts
 *
 * Fixtures are served at the board's own origin so the code under test is
 * the code that runs in production; only Gmail is injected. Every case
 * asserts an outcome AND that nothing was written down: the last case
 * walks every artifact a run produces, screenshots included, looking for
 * the code as bytes.
 */
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageBody } from "../lib/gmail/client.ts";
import { screenshotsBlocked, guardScreenshot, type GmailDeps } from "../lib/gmail/otp.ts";
import { resolveVerificationStep } from "../lib/applications/verificationStep.ts";
import { launchBrowser, newPreparedContext, newPreparedPage } from "../lib/browser/launch.ts";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};

const T = Date.now();
const RECIPIENT = "typleban1@gmail.com";
const CODE = "ZQ7X4KP2";
const ORIGIN = "https://job-boards.greenhouse.io";

const context = {
  applicationId: "app-under-test",
  employer: { name: "Acme Robotics", domain: "acmerobotics.com" },
  boardSenders: ["us.greenhouse-mail.io"],
  recipient: RECIPIENT,
  requestedAt: new Date(T),
};

const mail = (over: Partial<MessageBody> = {}): MessageBody => ({
  id: "m1", threadId: "t1", internalDate: T + 20_000,
  date: new Date(T + 20_000).toUTCString(),
  from: "Acme <no-reply@us.greenhouse-mail.io>", to: RECIPIENT,
  subject: "Verification code for Acme Robotics", snippetLength: 30,
  text: `Your verification code is ${CODE}. It expires in 10 minutes.`, ...over,
});

const gmail = (messages: MessageBody[]): GmailDeps => ({
  searchIds: async () => messages.map((m) => m.id),
  getMessage: async (id) => messages.find((m) => m.id === id)!,
  now: () => T,
});

// ---- fixtures ---------------------------------------------------------
const shell = (body: string) => `<!doctype html><meta charset="utf-8"><body>${body}</body>`;

/** Eight boxes, exactly as Greenhouse renders them. */
const boxes = Array.from({ length: 8 }, (_, i) =>
  `<input name="security_code_${i}" maxlength="1" autocomplete="one-time-code">`).join("");

const FIXTURES: Record<string, string> = {
  // An ordinary application with no challenge at all.
  none: shell(`<h1>Apply</h1><input name="first_name"><button type="submit">Submit application</button>`),
  // Ordinary email verification, which is the only automatable case.
  ordinary: shell(`<form><p>Verify your email address. We sent an 8-character verification
    code to ${RECIPIENT}. Enter it below to confirm your email address.</p>
    ${boxes}<button type="submit">Verify</button></form>`),
  // Stripe's real wording.
  human: shell(`<form><p>A verification code was sent to ${RECIPIENT}. To submit your
    application, enter the 8-character code to confirm you're a human.</p>
    ${boxes}<button type="submit">Submit application</button></form>`),
  // Asks for a code and says nothing about why.
  unknown: shell(`<form><p>Enter the security code to continue.</p>
    ${boxes}<button type="submit">Continue</button></form>`),
};

const browser: Browser = await launchBrowser();

/** Serves a fixture at the board origin, and swaps it after the verify click. */
async function open(name: keyof typeof FIXTURES, after?: string): Promise<Page> {
  const page = await newPreparedPage(browser, { viewport: { width: 1200, height: 900 } });
  let served = FIXTURES[name]!;
  await page.route(`${ORIGIN}/**`, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: served });
  });
  if (after) {
    page.on("framenavigated", () => { served = after; });
  }
  await page.goto(`${ORIGIN}/embed/job_app?for=acme&token=1`, { waitUntil: "domcontentloaded" });
  // The verify click posts the form, which re-requests the same URL and
  // gets whatever `after` set, which is how a real board answers.
  return page;
}

const resolve = (page: Page, messages: MessageBody[], bound = 1500) =>
  resolveVerificationStep({ page, context, gmail: gmail(messages), pollBoundMs: bound });

// ---- cases ------------------------------------------------------------
console.log("the seam");

{
  // "Ordinary filling must not depend on Gmail" is a claim about calls
  // that do NOT happen, so the deps count their own invocations.
  let touched = 0;
  const counting: GmailDeps = {
    searchIds: async () => { touched++; return []; },
    getMessage: async () => { touched++; return mail(); },
    now: () => T,
  };
  const page = await open("none");
  const out = await resolveVerificationStep({ page, context, gmail: counting, pollBoundMs: 1500 });
  check("an application with no challenge returns NO_CHALLENGE", out.kind === "NO_CHALLENGE", out.kind);
  check("and the mailbox was never touched", touched === 0, `${touched} calls`);
  await page.close();
}

{
  const page = await open("human");
  const out = await resolve(page, [mail()]);
  check("Stripe's human-presence wording stops at HANDOFF",
    out.kind === "HANDOFF" && out.classification === "HUMAN_PRESENCE",
    JSON.stringify(out));
  const held = await page.locator("input").first().inputValue();
  check("and nothing was typed into the form", held === "", held);
  await page.close();
}

{
  const page = await open("unknown");
  const out = await resolve(page, [mail()]);
  check("an unrecognized challenge stops at HANDOFF",
    out.kind === "HANDOFF" && out.classification === "UNKNOWN", JSON.stringify(out));
  await page.close();
}

{
  const page = await open("ordinary", shell("<h1>Thank you for applying.</h1>"));
  const out = await resolve(page, [mail()]);
  check("an ordinary OTP is completed", out.kind === "VERIFIED", JSON.stringify(out));
  check("and its provenance names the message and application",
    out.kind === "VERIFIED" && out.provenance.messageId === "m1"
    && out.provenance.applicationId === "app-under-test");
  await page.close();
}

{
  const page = await open("ordinary");
  const started = Date.now();
  const out = await resolve(page, [], 1500);
  check("no message within the bound stops at HANDOFF",
    out.kind === "HANDOFF" && /no message matched/.test(out.reason), JSON.stringify(out));
  check("and it actually waited rather than failing instantly", Date.now() - started >= 1400);
  await page.close();
}

{
  const page = await open("ordinary");
  const out = await resolve(page, [mail(), mail({ id: "m2", internalDate: T + 30_000 })]);
  check("two candidate messages stop at HANDOFF",
    out.kind === "HANDOFF" && /ambiguous/.test(out.reason), JSON.stringify(out));
  await page.close();
}

{
  const page = await open("ordinary");
  const out = await resolve(page, [mail({
    text: `Your verification code is ${CODE}. Your security code is AB12CD34.`,
  })]);
  check("two candidate codes stop at HANDOFF",
    out.kind === "HANDOFF" && /ambiguous/.test(out.reason), JSON.stringify(out));
  await page.close();
}

{
  const page = await open("ordinary");
  const out = await resolve(page, [mail({ from: "someone@elsewhere.example" })]);
  check("a sender mismatch stops at HANDOFF",
    out.kind === "HANDOFF" && /sender/.test(out.reason), JSON.stringify(out));
  await page.close();
}

// The step succeeds and the application is still rejected. VERIFIED must
// not be mistaken for submitted.
{
  const page = await open("ordinary", shell(
    `<form><p class="error">Please correct the errors below.</p><input name="x"></form>`));
  const out = await resolve(page, [mail()]);
  check("a verified step on a rejected application is still only VERIFIED",
    out.kind === "VERIFIED", JSON.stringify(out));
  const text = await page.evaluate(() => document.body.innerText);
  check("and the page shows no success wording", !/thank you/i.test(text), text.slice(0, 80));
  await page.close();
}

// ---- the screenshot latch, on a real page -----------------------------
{
  const page = await open("ordinary", shell("<h1>Thank you for applying.</h1>"));
  let blockedDuring: boolean | null = null;
  const original = page.screenshot.bind(page);
  // Any capture during the run must be refused, not merely skipped.
  (page as unknown as { screenshot: unknown }).screenshot = async (...a: unknown[]) => {
    guardScreenshot();
    return original(...(a as []));
  };
  const poll = setInterval(() => { if (screenshotsBlocked()) blockedDuring = true; }, 20);
  const out = await resolve(page, [mail()]);
  clearInterval(poll);
  check("the code was entered", out.kind === "VERIFIED");
  check("captures were blocked while the code was in the form", blockedDuring === true);
  check("and released afterwards", screenshotsBlocked() === false);
  await page.close();
}

// ---- nothing durable carries the code ---------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "otp-artifacts-"));
  const page = await open("ordinary", shell("<h1>Thank you for applying.</h1>"));
  const out = await resolve(page, [mail()]);
  check("the run completed", out.kind === "VERIFIED");

  // Everything a real run persists, built the way submit-application.ts
  // builds it, plus an actual screenshot taken after the code is gone.
  await page.screenshot({ path: join(dir, "after.png"), fullPage: true });
  const artifacts: Record<string, Buffer> = {};
  if (out.kind === "VERIFIED") {
    artifacts["run.json"] = Buffer.from(JSON.stringify({ verification: out }));
    artifacts["event detail"] = Buffer.from(
      `An ordinary email verification step was completed from message ${out.provenance.messageId} `
      + `sent ${out.provenance.sentAt} by ${out.provenance.from}.`);
  }
  for (const f of readdirSync(dir)) artifacts[f] = readFileSync(join(dir, f));

  const needle = Buffer.from(CODE, "utf8");
  for (const [name, buf] of Object.entries(artifacts)) {
    check(`${name} does not contain the code`, !buf.includes(needle), `${buf.length} bytes`);
  }
  // A screenshot is pixels, so byte search proves little on its own; the
  // real guarantee is the latch above, which makes the capture impossible
  // while the code is on screen. This checks the form was cleared too.
  const leftover = await page.locator("input").count();
  check("no code control survives on the confirmed page", leftover === 0, String(leftover));
  await page.close();
}

await browser.close();
console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
