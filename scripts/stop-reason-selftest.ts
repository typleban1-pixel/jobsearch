/**
 * The invariant under test: a SAFE_STOP can never exist without a recorded
 * reason. That is not a style preference — an outcome with no cause is only
 * discoverable by going back to the employer, which is the one thing a safe
 * stop is supposed to avoid.
 */
import {
  STOP_CODES, STOP_STAGES, formatStopDetail, parseStopDetail, resolveStopRecord,
  assertStopRecorded, fillStopCode, STOP_EVENT, type StopRecord,
} from "../lib/applications/stopReason.ts";
import { classifyOutcome } from "../lib/applications/submitOutcome.ts";

let n = 0, bad = 0;
const ok = (c: boolean, what: string) => { n++; if (!c) { bad++; console.error(`FAIL ${what}`); } };
const eq = (a: unknown, b: unknown, what: string) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// ---- 1. every code/stage pair round-trips ----------------------------
for (const code of STOP_CODES) {
  for (const stage of STOP_STAGES) {
    const r: StopRecord = { code, stage, detail: `stopped because ${code}`, pageReached: false };
    const back = parseStopDetail(formatStopDetail(r));
    ok(back !== null, `${code}/${stage} parses back`);
    eq(back?.code, code, `${code}/${stage} code survives`);
    eq(back?.stage, stage, `${code}/${stage} stage survives`);
  }
}

// ---- 2. the detail is never empty, even when the caller supplies none --
{
  const d = formatStopDetail({ code: "ADAPTER_REFUSED", stage: "fill", detail: "", pageReached: false });
  ok(d.includes("no further detail recorded"), "an empty detail is filled, not left blank");
  ok(d.includes("[ADAPTER_REFUSED @ fill]"), "the code and stage lead the prose");
  ok(parseStopDetail(d) !== null, "a filled-in detail is still machine-readable");
}

// ---- 3. page identity is carried when a page existed ------------------
{
  const withPage = formatStopDetail({
    code: "CAPTCHA_WALL", stage: "pre-submit", detail: "a challenge frame was showing",
    pageReached: true, url: "https://job-boards.greenhouse.io/stripe/jobs/7130546",
    title: "Stripe — Apply",
  });
  ok(withPage.includes("Page reached: https://job-boards.greenhouse.io"), "url is in the prose");
  ok(withPage.includes("Stripe — Apply"), "title is in the prose");
  eq(parseStopDetail(withPage)?.url, "https://job-boards.greenhouse.io/stripe/jobs/7130546", "url machine-readable");
  const noPage = formatStopDetail({ code: "BROWSER_LAUNCH_FAILED", stage: "launch", detail: "x", pageReached: false });
  ok(noPage.includes("No browser page was reached"), "absence of a page is stated, not omitted");
  eq(parseStopDetail(noPage)?.pageReached, false, "pageReached survives as false");
}

// ---- 4. mismatches survive both halves --------------------------------
{
  const d = formatStopDetail({
    code: "READBACK_MISMATCH", stage: "readback", detail: "what was written is not there",
    pageReached: true, url: "u",
    mismatches: [{ field: "State", expected: "Ohio", actual: "" },
                 { field: "Phone", expected: "210", actual: "211" }],
  });
  ok(d.includes('State: wrote "Ohio", read ""'), "mismatch is legible to a person");
  eq(parseStopDetail(d)?.mismatches?.length, 2, "both mismatches survive parsing");
  eq(parseStopDetail(d)?.mismatches?.[1]?.actual, "211", "mismatch values survive exactly");
}

// ---- 5. THE INVARIANT: a SAFE_STOP always resolves to a record --------
// Exhaustive over the ways a run can end, including the ones where the
// runner recorded nothing at all.
for (const ok_ of [true, false]) {
  for (const timedOut of [true, false]) {
    for (const tail of ["", "  ", "some output"]) {
      const rec = resolveStopRecord({ recorded: null, ok: ok_, tail, timedOut });
      ok(rec.detail.trim().length > 0, `unrecorded stop still has detail (ok=${ok_} t=${timedOut})`);
      ok(STOP_CODES.includes(rec.code), `unrecorded stop has a real code (ok=${ok_} t=${timedOut})`);
      ok(formatStopDetail(rec).length > 0, "an unrecorded stop still formats");
    }
  }
}
eq(resolveStopRecord({ recorded: null, ok: false, tail: "x", timedOut: true }).code,
   "TIMEOUT", "a wall-clock kill is TIMEOUT, not a guess");
eq(resolveStopRecord({ recorded: null, ok: false, tail: "x", timedOut: false }).code,
   "RUNNER_DIED_WITHOUT_REASON", "an undescribed death says so rather than inventing a cause");
ok(resolveStopRecord({ recorded: null, ok: true, tail: "" }).detail.includes("(none)"),
   "an empty tail is stated as empty");

// ---- 6. a recorded reason always wins over the fallback ---------------
{
  const recorded: StopRecord = { code: "LOGIN_WALL", stage: "auth", detail: "sign-in demanded", pageReached: true };
  eq(resolveStopRecord({ recorded, ok: false, tail: "noise", timedOut: true }).code, "LOGIN_WALL",
     "the runner's own record beats the timeout fallback");
  eq(resolveStopRecord({ recorded, ok: false, tail: "noise" }).stage, "auth", "stage comes from the record");
}

// ---- 7. the guard actually refuses ------------------------------------
{
  let threw = false;
  try { assertStopRecorded("SAFE_STOP", null); } catch { threw = true; }
  ok(threw, "SAFE_STOP with a null record is refused");
  let threw2 = false;
  try { assertStopRecorded("CONFIRMED", null); } catch { threw2 = true; }
  ok(!threw2, "a confirmed submission needs no stop record");
  let threw3 = false;
  try {
    assertStopRecorded("SAFE_STOP", { code: "TIMEOUT", stage: "fill", detail: "d", pageReached: false });
  } catch { threw3 = true; }
  ok(!threw3, "SAFE_STOP with a record passes");
}

// ---- 8. every SAFE_STOP the classifier can produce gets a record ------
// Walks the classifier's own inputs rather than trusting one example.
for (const submittedAt of [null]) {
  for (const clickAttemptedAt of [null, "2020-01-01T00:00:00Z"]) {
    const { outcome } = classifyOutcome({
      submittedAt, clickAttemptedAt, claimedAt: "2026-01-01T00:00:00Z",
    });
    if (outcome !== "SAFE_STOP") continue;
    const rec = resolveStopRecord({ recorded: null, ok: false, tail: "t" });
    let threw = false;
    try { assertStopRecorded(outcome, rec); } catch { threw = true; }
    ok(!threw, `classifier SAFE_STOP (click=${clickAttemptedAt}) is always paired with a record`);
  }
}

// ---- 9. adapter vocabulary maps without guessing ----------------------
eq(fillStopCode("RECAPTCHA_PRESENT"), "CAPTCHA_WALL", "captcha recognised");
eq(fillStopCode("LOGIN_REQUIRED"), "LOGIN_WALL", "login recognised");
eq(fillStopCode("SNAPSHOT_CHANGED"), "READBACK_MISMATCH", "snapshot drift recognised");
eq(fillStopCode("BLOCKED"), "FILL_INCOMPLETE", "blocked fill recognised");
eq(fillStopCode("SOMETHING_NOBODY_HAS_SEEN"), "ADAPTER_REFUSED", "unknown words do not become a guess");
eq(fillStopCode(null), "ADAPTER_REFUSED", "a missing reason does not become a guess");

// ---- 10. garbage in stored detail is not mistaken for a record --------
eq(parseStopDetail(null), null, "null detail carries no record");
eq(parseStopDetail("just some prose"), null, "prose alone carries no record");
eq(parseStopDetail("stop-record:{not json"), null, "malformed json is not a record");
eq(parseStopDetail('stop-record:{"code":"MADE_UP","stage":"fill"}'), null, "an unknown code is not a record");
eq(parseStopDetail('stop-record:{"code":"TIMEOUT","stage":"nowhere"}'), null, "an unknown stage is not a record");
ok(STOP_EVENT === "SUBMIT_SAFE_STOP", "the event name is the one the listener queries");

console.log(`${n - bad}/${n} assertions passed`);
process.exit(bad ? 1 : 0);
