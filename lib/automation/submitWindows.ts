/**
 * When batched applications are submitted.
 *
 * Approving an application puts it in the batch; the listener on the Mac
 * sends the batch at three fixed times a day, the same times the daily
 * pipeline runs. A person who wants one sent sooner presses "Apply now",
 * which moves its earliest-run time to the present. Nothing here touches
 * the database or an employer: it only answers "when is the next run" and
 * says it in words.
 *
 * Times are wall-clock in SUBMIT_TZ, the Mac's zone, because that is the
 * clock launchd keeps; the portal runs in UTC and must not guess.
 */
export const SUBMIT_WINDOW_HOURS: readonly number[] = [0, 8, 16];
export const SUBMIT_TZ = "America/New_York";

interface Parts { y: number; m: number; d: number; h: number; min: number }
function partsIn(tz: string, at: Date): Parts {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const get = (type: string) => Number(f.formatToParts(at).find((p) => p.type === type)?.value ?? 0);
  // Some ICU builds print midnight as "24" even under hourCycle h23. Left
  // alone, that put the midnight run a day late on the deployed portal
  // ("next run midnight tonight" at 00:13). Midnight is hour 0.
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24, min: get("minute") };
}
/** The instant at which the wall clock in tz reads y-m-d h:00. Day may overflow; Date.UTC normalises it. */
function zonedToUtc(tz: string, y: number, m: number, d: number, h: number): Date {
  const want = Date.UTC(y, m - 1, d, h);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const q = partsIn(tz, new Date(guess));
    guess += want - Date.UTC(q.y, q.m - 1, q.d, q.h, q.min);
  }
  return new Date(guess);
}

/** The next scheduled run strictly after `now`. */
export function nextSubmitWindow(now: Date = new Date(), tz: string = SUBMIT_TZ): Date {
  const p = partsIn(tz, now);
  for (const h of SUBMIT_WINDOW_HOURS) {
    const t = zonedToUtc(tz, p.y, p.m, p.d, h);
    if (t.getTime() > now.getTime()) return t;
  }
  return zonedToUtc(tz, p.y, p.m, p.d + 1, SUBMIT_WINDOW_HOURS[0]!);
}

/** "midnight", "8:00 AM", "4:00 PM". */
export function windowClock(at: Date, tz: string = SUBMIT_TZ): string {
  const { h, min } = partsIn(tz, at);
  if (h === 0 && min === 0) return "midnight";
  return `${((h + 11) % 12) + 1}:${String(min).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "at 4:00 PM today", "at midnight tonight", "at 8:00 AM tomorrow", "at 8:00 AM on Tuesday". */
export function describeWindow(at: Date, now: Date = new Date(), tz: string = SUBMIT_TZ): string {
  const a = partsIn(tz, at), n = partsIn(tz, now);
  const sameDay = a.y === n.y && a.m === n.m && a.d === n.d;
  const tomorrow = Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(n.y, n.m - 1, n.d) === 86_400_000;
  const clock = windowClock(at, tz);
  if (clock === "midnight" && tomorrow) return "at midnight tonight";
  if (sameDay) return `at ${clock} today`;
  if (tomorrow) return `at ${clock} tomorrow`;
  return `at ${clock} on ${new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(at)}`;
}

/** True when a hold has passed (or there is none). */
export function isDue(notBefore: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (!notBefore) return true;
  return new Date(notBefore).getTime() <= now.getTime();
}
