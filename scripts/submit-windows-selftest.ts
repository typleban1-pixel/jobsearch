/** The batch schedule: next run after any moment, said in words, in the Mac's zone. */
import { nextSubmitWindow, describeWindow, windowClock, isDue } from "../lib/automation/submitWindows.ts";
let bad = 0;
const ok = (c: boolean, what: string, extra = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${extra ? " -- " + extra : ""}`); if (!c) bad++; };
const TZ = "America/New_York";
const at = (iso: string) => new Date(iso);

// 2026-09-07 is EDT (UTC-4). 19:35Z = 3:35 PM local.
let now = at("2026-09-07T19:35:00Z"); let next = nextSubmitWindow(now, TZ);
ok(next.toISOString() === "2026-09-07T20:00:00.000Z", "3:35 PM local -> 4:00 PM today", next.toISOString());
ok(describeWindow(next, now, TZ) === "at 4:00 PM today", "said as 'at 4:00 PM today'", describeWindow(next, now, TZ));
now = at("2026-09-07T20:00:00Z"); next = nextSubmitWindow(now, TZ);
ok(next.toISOString() === "2026-09-08T04:00:00.000Z", "exactly 4:00 PM -> midnight (strictly after)", next.toISOString());
ok(describeWindow(next, now, TZ) === "at midnight tonight", "said as 'at midnight tonight'", describeWindow(next, now, TZ));
now = at("2026-09-08T05:30:00Z"); next = nextSubmitWindow(now, TZ);   // 1:30 AM local
ok(next.toISOString() === "2026-09-08T12:00:00.000Z" && describeWindow(next, now, TZ) === "at 8:00 AM today", "1:30 AM -> 8:00 AM today", describeWindow(next, now, TZ));
// Standard time: 2026-12-01 is EST (UTC-5). 23:10Z = 6:10 PM local -> midnight = 05:00Z next day.
now = at("2026-12-01T23:10:00Z"); next = nextSubmitWindow(now, TZ);
ok(next.toISOString() === "2026-12-02T05:00:00.000Z", "EST offset respected", next.toISOString());
ok(windowClock(at("2026-12-02T13:00:00Z"), TZ) === "8:00 AM", "8:00 AM in EST", windowClock(at("2026-12-02T13:00:00Z"), TZ));
ok(isDue(null) && isDue("2020-01-01T00:00:00Z") && !isDue(new Date(Date.now() + 60_000)), "isDue: null and past are due, future is not");
console.log(bad ? `\n${bad} FAILED` : "\nsubmit-windows-selftest: ALL PASS");
process.exit(bad ? 1 : 0);
