/**
 * Locks exactly-once submission classification: a click that could not be
 * confirmed is AMBIGUOUS and must never be retried automatically.
 *   node scripts/exactly-once-selftest.ts
 */
import { classifyOutcome, retryAllowed } from "../lib/applications/submitOutcome.ts";
let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };
const CLAIM = "2026-09-05T16:00:00Z";
ok(classifyOutcome({ submittedAt: "2026-09-05T16:05:00Z", clickAttemptedAt: "2026-09-05T16:04:00Z", claimedAt: CLAIM }).outcome === "CONFIRMED", "confirmed receipt -> CONFIRMED");
ok(classifyOutcome({ submittedAt: null, clickAttemptedAt: "2026-09-05T16:04:00Z", claimedAt: CLAIM }).outcome === "AMBIGUOUS", "clicked this run, no confirmation -> AMBIGUOUS");
ok(classifyOutcome({ submittedAt: null, clickAttemptedAt: "2026-09-05T15:00:00Z", claimedAt: CLAIM }).outcome === "SAFE_STOP", "click from a PRIOR run -> SAFE_STOP");
ok(classifyOutcome({ submittedAt: null, clickAttemptedAt: null, claimedAt: CLAIM }).outcome === "SAFE_STOP", "no click -> SAFE_STOP");
ok(classifyOutcome({ submittedAt: null, clickAttemptedAt: null, claimedAt: CLAIM, declined: true }).outcome === "DECLINED", "declined before browser -> DECLINED");
ok(retryAllowed("AMBIGUOUS") === false, "AMBIGUOUS may NOT be retried (no duplicate)");
ok(retryAllowed("CONFIRMED") === false, "CONFIRMED may NOT be retried");
ok(retryAllowed("SAFE_STOP") === true, "SAFE_STOP may be retried");
ok(retryAllowed("DECLINED") === true, "DECLINED may be retried");
ok(retryAllowed(null) === true, "never-run may be tried");
console.log(bad ? `\n${bad} FAILED` : `\nexactly-once-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
