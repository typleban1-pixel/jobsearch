/**
 * What to do when a board asks for a code after Submit.
 *
 * This is the seam between the live form and the mailbox, and it is
 * deliberately the only place the two meet. Ordinary form filling never
 * touches Gmail; nothing here runs until a submitted form has actually
 * asked for a code, and even then the form decides whether the mailbox is
 * consulted at all.
 *
 * Three ways out, and two of them are stops:
 *
 *   NO_CHALLENGE  the page never asked for a code
 *   HANDOFF       it asked, and this system is not the one to answer
 *   VERIFIED      an ordinary email verification was completed
 *
 * VERIFIED does not mean submitted. It means one verification step was
 * satisfied; whether the application itself landed is a separate question
 * the caller still has to ask the page.
 */
import type { Page } from "playwright";
import {
  classify, asksForCode, type Classification, type PageContext,
} from "../gmail/verification.ts";
import {
  withVerificationCode, type GmailDeps, type Provenance,
} from "../gmail/otp.ts";

/** How long to keep looking for a message that has not arrived yet. */
const POLL_BOUND_MS = 90_000;
const POLL_EVERY_MS = 5_000;

export type VerificationOutcome =
  | { kind: "NO_CHALLENGE" }
  | { kind: "HANDOFF"; classification: Classification | "ORDINARY_OTP"; reason: string }
  | { kind: "VERIFIED"; provenance: Provenance };

export type VerificationContext = {
  applicationId: string;
  employer: { name: string; domain: string | null };
  boardSenders: string[];
  recipient: string;
  /** T: the moment the form asked. Set by the caller at the Submit click. */
  requestedAt: Date;
};

/** Reads what the classifier needs. Text and a genuinely visible challenge. */
export async function readPageContext(page: Page): Promise<PageContext & { controls: number; url: string }> {
  return page.evaluate(() => ({
    text: (document.body.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 40000),
    url: location.href,
    controls: document.querySelectorAll("input,select,textarea").length,
    captchaChallengeVisible: [...document.querySelectorAll("iframe")].some((f) => {
      const src = f.getAttribute("src") ?? "";
      if (!/recaptcha|hcaptcha|turnstile/i.test(src)) return false;
      const r = f.getBoundingClientRect();
      return /bframe|challenge/i.test(src) && r.width > 100 && r.height > 100;
    }),
  }));
}

// Code inputs only. Every selector names a code, a security/verification
// field, or a digit slot, so none of them can match an ordinary name,
// email, or phone field still on the page. A segmented control (one box
// per character, which is what Greenhouse renders for its 8-character
// code) is matched by the digit/one-time-code selectors; a single input
// by the rest. If this resolves to the wrong count enterCode refuses
// rather than typing into a guess, so breadth here is safe.
const CODE_INPUT = [
  "input[autocomplete='one-time-code']",
  "input[name*='security' i]",
  "input[name*='verification' i]",
  "input[name*='code' i]",
  "input[aria-label*='security code' i]",
  "input[aria-label*='verification code' i]",
  "input[aria-label*='confirmation code' i]",
  "input[aria-label*='digit' i]",
].join(", ");

export async function resolveVerificationStep(args: {
  page: Page;
  context: VerificationContext;
  gmail: GmailDeps;
  log?: (line: string) => void;
  pollBoundMs?: number;
}): Promise<VerificationOutcome> {
  const { page, context, gmail } = args;
  const log = args.log ?? (() => {});
  const bound = args.pollBoundMs ?? POLL_BOUND_MS;

  const state = await readPageContext(page);
  if (!asksForCode(state.text)) return { kind: "NO_CHALLENGE" };

  const verdict = classify(state);
  log(`the page asks for a code; classified ${verdict.classification} (${verdict.why})`);
  if (!verdict.mayExtract) {
    return { kind: "HANDOFF", classification: verdict.classification, reason: verdict.why };
  }

  // The control has to exist before the mailbox is touched. A page that
  // says "enter the code" without offering anywhere to enter it is not a
  // page this should be automating against.
  const inputs = page.locator(CODE_INPUT);
  const boxes = await inputs.count();
  if (boxes === 0) {
    return { kind: "HANDOFF", classification: "ORDINARY_OTP", reason: "no code control is present on the page" };
  }

  // Zero messages is the expected state for the first few seconds: the
  // mail has not arrived yet. Every other refusal is final, and retrying
  // one would just be waiting for a constraint to change its mind.
  const deadline = Date.now() + bound;
  let last = "";
  for (;;) {
    const result = await withVerificationCode(
      { ...context, page: state },
      gmail,
      async (code) => enterCode(page, inputs, boxes, code, state),
    );

    if (result.ok) {
      const step = result.result;
      if (step.kind !== "OK") {
        return { kind: "HANDOFF", classification: "ORDINARY_OTP", reason: step.reason };
      }
      log(`verification accepted from message ${result.provenance.messageId}`);
      return { kind: "VERIFIED", provenance: result.provenance };
    }

    last = result.reason;
    const worthWaiting = /no message matched|no message survived/.test(last);
    if (!worthWaiting || Date.now() >= deadline) break;
    log(`waiting for the verification message (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    await page.waitForTimeout(POLL_EVERY_MS);
  }
  return { kind: "HANDOFF", classification: "ORDINARY_OTP", reason: last };
}

type StepResult = { kind: "OK" } | { kind: "REFUSED"; reason: string };

/**
 * Types the code, proves it committed, and submits that step alone.
 *
 * Runs inside the OTP module's lending callback, so the screenshot latch
 * is closed for its whole duration. Nothing here logs the value, and the
 * read-back comparison happens in memory.
 */
async function enterCode(
  page: Page,
  inputs: ReturnType<Page["locator"]>,
  boxes: number,
  code: string,
  before: { controls: number; url: string },
): Promise<StepResult> {
  // The latch is already closed by the lending entrance for the whole of
  // this callback, so there is nothing to assert here. guardScreenshot()
  // belongs at capture sites, where it stops a screenshot from happening;
  // calling it here only made this function throw on itself.
  if (boxes === 1) {
    await inputs.first().fill(code);
  } else if (boxes === code.length) {
    // Segmented entry: one character per box, which is what Greenhouse
    // renders for an eight character code.
    for (let i = 0; i < boxes; i++) await inputs.nth(i).fill(code[i]!);
  } else {
    return { kind: "REFUSED", reason: `${boxes} code controls for a ${code.length} character code` };
  }

  const committed = boxes === 1
    ? await inputs.first().inputValue()
    : (await inputs.allInnerTexts().catch(() => []), (await Promise.all(
        Array.from({ length: boxes }, (_, i) => inputs.nth(i).inputValue()),
      )).join(""));
  if (committed.trim().toUpperCase() !== code.toUpperCase()) {
    // Deliberately reports lengths, never the values being compared.
    return { kind: "REFUSED", reason: `the code did not commit (${committed.trim().length} of ${code.length} characters held)` };
  }

  const now = await readPageContext(page);
  if (now.url !== before.url) {
    return { kind: "REFUSED", reason: "the page navigated while the code was being entered" };
  }

  const submit = page.locator("form button[type=submit], form input[type=submit]")
    .or(page.getByRole("button", { name: /submit application|verify|confirm/i }));
  const count = await submit.count();
  if (count !== 1) {
    return { kind: "REFUSED", reason: `the verification submit resolved to ${count} controls, not exactly one` };
  }
  await submit.first().click({ timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  return { kind: "OK" };
}
