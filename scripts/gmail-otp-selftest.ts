/**
 * The OTP capability, and the ways it must refuse.
 *
 *   node scripts/gmail-otp-selftest.ts
 *
 * Entirely offline: Gmail is injected, so this suite never touches a
 * mailbox and never needs a credential. The interesting assertions are
 * the refusals. A capability that can read a code out of mail is only
 * safe if the gates around it hold, so nearly every case here proves that
 * something does NOT happen.
 */
import { createHash } from "node:crypto";
import type { MessageBody } from "../lib/gmail/client.ts";
import { classify, expectedCodeLength } from "../lib/gmail/verification.ts";
import {
  withVerificationCode, otpQuery, extractCode, guardScreenshot, screenshotsBlocked,
  type GmailDeps, type OtpRequest,
} from "../lib/gmail/otp.ts";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};

const T = 1_700_000_000_000;
const RECIPIENT = "typleban1@gmail.com";
const EMPLOYER = { name: "Acme Robotics", domain: "acmerobotics.com" };
const BOARD = ["us.greenhouse-mail.io"];

// The page an ordinary email verification shows: it says what it is
// verifying, and claims nothing about the applicant being a person.
const ORDINARY_PAGE = {
  text: "Verify your email address. We sent a 6-character verification code to "
    + "typleban1@gmail.com. Enter it below to confirm your email address.",
};
// Stripe's actual wording, which is a human-presence claim.
const STRIPE_PAGE = {
  text: "A verification code was sent to typleban1@gmail.com. To submit your "
    + "application, enter the 8-character code to confirm you're a human.",
};

const msg = (over: Partial<MessageBody> = {}): MessageBody => ({
  id: "m1", threadId: "t1", internalDate: T + 30_000,
  date: new Date(T + 30_000).toUTCString(),
  from: "Acme <no-reply@us.greenhouse-mail.io>",
  to: RECIPIENT, subject: "Verification code for Acme Robotics",
  snippetLength: 40,
  text: "Your verification code is 4F2K9B. It expires in 10 minutes.",
  ...over,
});

const deps = (messages: MessageBody[]): GmailDeps => ({
  searchIds: async () => messages.map((m) => m.id),
  getMessage: async (id) => messages.find((m) => m.id === id)!,
  now: () => T + 60_000,
});

const request = (over: Partial<OtpRequest> = {}): OtpRequest => ({
  applicationId: "app-1", employer: EMPLOYER, boardSenders: BOARD,
  recipient: RECIPIENT, requestedAt: new Date(T), page: ORDINARY_PAGE, ...over,
});

// ---- classification ---------------------------------------------------
console.log("classification");
check("ordinary email verification is ORDINARY_OTP",
  classify(ORDINARY_PAGE).classification === "ORDINARY_OTP", classify(ORDINARY_PAGE).why);
check("Stripe's wording is HUMAN_PRESENCE",
  classify(STRIPE_PAGE).classification === "HUMAN_PRESENCE", classify(STRIPE_PAGE).why);
check("a visible CAPTCHA is HUMAN_PRESENCE",
  classify({ text: "Verify your email address. Enter the code.", captchaChallengeVisible: true })
    .classification === "HUMAN_PRESENCE");
check("a code request with no stated purpose is UNKNOWN",
  classify({ text: "Enter the security code to continue." }).classification === "UNKNOWN");
check("a page not asking for a code at all is UNKNOWN",
  classify({ text: "First name. Last name. Resume." }).classification === "UNKNOWN");
check("only ORDINARY_OTP may extract",
  classify(ORDINARY_PAGE).mayExtract && !classify(STRIPE_PAGE).mayExtract);
check("a human claim beats a verification purpose in the same page",
  classify({ text: "Verify your email address, then confirm you are a human." })
    .classification === "HUMAN_PRESENCE");
check("the expected length is read off the page", expectedCodeLength(ORDINARY_PAGE.text) === 6);
check("and off Stripe's page", expectedCodeLength(STRIPE_PAGE.text) === 8);

// ---- the query is constrained on every axis ---------------------------
console.log("\nthe search cannot be widened");
const q = otpQuery(request());
check("constrains the sender", q.includes("from:us.greenhouse-mail.io"));
check("constrains the employer domain too", q.includes("from:acmerobotics.com"));
check("constrains the recipient", q.includes(`to:${RECIPIENT}`));
check("names the employer", q.includes(`"${EMPLOYER.name}"`));
check("anchors on the request time", q.includes(`after:${Math.floor(T / 1000)}`));
const refuses = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
check("refuses with no recipient", refuses(() => otpQuery(request({ recipient: "" }))));
check("refuses with no employer", refuses(() => otpQuery(request({ employer: { name: "", domain: null } }))));
check("refuses with no sender list",
  refuses(() => otpQuery(request({ boardSenders: [], employer: { name: "Acme Robotics", domain: null } }))));

// ---- code extraction --------------------------------------------------
console.log("\ncode extraction");
check("takes the one code that follows code wording",
  extractCode("Your verification code is 4F2K9B. Thanks.", 6).code === "4F2K9B");
check("two different candidates is a refusal",
  extractCode("Your verification code is 4F2K9B. Your security code is 9XT4M1.", 6).code === null);
check("the same code twice is not ambiguous",
  extractCode("Your verification code is 4F2K9B. Code: 4F2K9B", 6).code === "4F2K9B");
check("no code at all is a refusal", extractCode("Thanks for applying to Acme.", 6).code === null);
check("a shaped token with no code wording is ignored",
  extractCode("Tracking id AB12CD34 for your records.", 8).code === null);
check("prose after code wording is not mistaken for a code",
  extractCode("Your verification code is arriving shortly.", 6).code === null);

// ---- the gates --------------------------------------------------------
console.log("\nevery gate is a refusal, not a score");
const run = async (over: Partial<OtpRequest>, messages: MessageBody[]) =>
  withVerificationCode(request(over), deps(messages), async (c) => c.length);

const success = await run({}, [msg()]);
check("ordinary OTP succeeds", success.ok === true);
check("and returns provenance bound to the application",
  success.ok === true && success.provenance.applicationId === "app-1"
  && success.provenance.messageId === "m1");

const cases: Array<[string, Awaited<ReturnType<typeof run>>, RegExp]> = [
  ["human presence stops", await run({ page: STRIPE_PAGE }, [msg()]), /HUMAN_PRESENCE/],
  ["a visible CAPTCHA stops",
    await run({ page: { ...ORDINARY_PAGE, captchaChallengeVisible: true } }, [msg()]), /HUMAN_PRESENCE/],
  ["unknown wording stops",
    await run({ page: { text: "Enter the security code to continue." } }, [msg()]), /UNKNOWN/],
  ["sender mismatch stops", await run({}, [msg({ from: "someone@notaboard.example" })]), /sender/],
  ["wrong recipient stops", await run({}, [msg({ to: "someone.else@gmail.com" })]), /recipient/],
  ["a different employer stops", await run({}, [msg({ subject: "Code for Globex", text: "Your verification code is 4F2K9B." })]), /employer/],
  ["a code older than the request stops", await run({}, [msg({ internalDate: T - 60_000 })]), /stale/],
  ["a code past the window stops", await run({}, [msg({ internalDate: T + 11 * 60_000 })]), /window/],
  ["two matching messages stop", await run({}, [msg(), msg({ id: "m2", internalDate: T + 40_000 })]), /ambiguous|latest-wins/],
  ["two candidate codes stop",
    await run({}, [msg({ text: "Your verification code is 4F2K9B. Your security code is 9XT4M1." })]), /ambiguous/],
  ["no code stops", await run({}, [msg({ text: "Thanks for applying to Acme Robotics." })]), /no code/],
  ["nothing found stops", await run({}, []), /no message matched/],
];
for (const [what, res, why] of cases) {
  check(what, res.ok === false && why.test(res.reason), res.ok ? "it succeeded" : res.reason);
}
check("no refusal reason leaks the code",
  cases.every(([, r]) => r.ok === true || !r.reason.includes("4F2K9B")));

// ---- the screenshot latch ---------------------------------------------
console.log("\nno capture while a code is in the form");
check("captures are allowed before", screenshotsBlocked() === false);
let blockedDuring = false, guardThrew = false;
await withVerificationCode(request(), deps([msg()]), async () => {
  blockedDuring = screenshotsBlocked();
  try { guardScreenshot(); } catch { guardThrew = true; }
  return 1;
});
check("blocked while the code is in flight", blockedDuring);
check("and the guard throws rather than returning quietly", guardThrew);
check("released afterwards", screenshotsBlocked() === false);
let releasedAfterThrow = true;
try {
  await withVerificationCode(request(), deps([msg()]), async () => { throw new Error("fill failed"); });
} catch { releasedAfterThrow = screenshotsBlocked() === false; }
check("released even when the fill throws", releasedAfterThrow);

// ---- the code reaches no artifact -------------------------------------
//
// Everything a run persists is built out of what escapes this module.
// This drives the real path with a sentinel code and then searches every
// such surface for it: the returned value, the provenance, an event
// detail, a run.json, console output, and a thrown error.
console.log("\nthe code cannot reach a persisted artifact");
const SENTINEL = "ZQ7X4KP2";
const sentinelMsg = msg({
  text: `Your verification code is ${SENTINEL}. It expires in 10 minutes.`,
  subject: "Verification code for Acme Robotics",
});
const captured: string[] = [];
const real = { log: console.log, error: console.error, warn: console.warn };
console.log = (...a: unknown[]) => { captured.push(a.join(" ")); };
console.error = (...a: unknown[]) => { captured.push(a.join(" ")); };
console.warn = (...a: unknown[]) => { captured.push(a.join(" ")); };

let artifacts: Record<string, string> = {};
let thrown = "";
try {
  const res = await withVerificationCode(
    request({ page: { text: ORDINARY_PAGE.text.replace("6-character", "8-character") } }),
    deps([sentinelMsg]),
    async (code) => {
      // What fill.ts would do: type it, and hash it for a digest only.
      return { typedLength: code.length, digest: createHash("sha256").update(code).digest("hex") };
    },
  );
  if (res.ok) {
    artifacts["returned"] = JSON.stringify(res.result);
    artifacts["provenance"] = JSON.stringify(res.provenance);
    artifacts["run.json"] = JSON.stringify({ outcome: "VERIFIED", ...res.provenance, result: res.result });
    artifacts["event detail"] = `Email verification completed. message ${res.provenance.messageId}, `
      + `from ${res.provenance.from}, sent ${res.provenance.sentAt}.`;
    artifacts["screenshot caption"] = `${res.provenance.subject} / ${res.provenance.from}`;
  } else {
    artifacts["refusal"] = res.reason;
  }
  // And the error path, where a careless caller puts the code in a message.
  try {
    await withVerificationCode(
      request({ page: { text: ORDINARY_PAGE.text.replace("6-character", "8-character") } }),
      deps([sentinelMsg]),
      async (code) => { throw new Error(`could not type ${code} into the field`); },
    );
  } catch (e) { thrown = (e as Error).message; }
} finally {
  console.log = real.log; console.error = real.error; console.warn = real.warn;
}

check("the run actually obtained a code", Object.keys(artifacts).includes("provenance"),
  JSON.stringify(artifacts).slice(0, 120));
for (const [name, value] of Object.entries(artifacts)) {
  check(`absent from ${name}`, !value.toUpperCase().includes(SENTINEL), value.slice(0, 100));
}
check("absent from console output", !captured.join("\n").toUpperCase().includes(SENTINEL));
check("absent from a thrown error, even one built around it",
  thrown.length > 0 && !thrown.toUpperCase().includes(SENTINEL), thrown);
check("the error still says what failed", /verification step failed/.test(thrown), thrown);

// ---- the shape of the module itself -----------------------------------
console.log("\nthe shape of the export surface");
const mod = await import("../lib/gmail/otp.ts");
const exported = Object.keys(mod).sort();
check("exports exactly the expected surface",
  exported.join(",") === "extractCode,guardScreenshot,otpQuery,screenshotsBlocked,withVerificationCode",
  exported.join(","));

// extractCode does return a code, and saying otherwise would be a lie.
// What makes it safe is that it is pure: it is handed a body the caller
// already holds and cannot reach a mailbox, so it adds no read capability.
check("extractCode is pure: body and length, no deps and no mailbox", mod.extractCode.length === 2);
const pure = mod.extractCode("Your verification code is 4F2K9B.", 6);
check("and it is the only export that yields a code", pure.code === "4F2K9B");

// The entrance is the one that can reach mail, and it never returns one.
const surfaced = await withVerificationCode(
  request({ page: { text: ORDINARY_PAGE.text.replace("6-character", "8-character") } }),
  deps([sentinelMsg]), async () => "done");
const everything = JSON.stringify(surfaced);
check("the mailbox-reaching entrance returns no code",
  surfaced.ok === true && !everything.toUpperCase().includes(SENTINEL), everything.slice(0, 120));
check("it takes a callback rather than returning a value to hold",
  mod.withVerificationCode.length === 3);

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
