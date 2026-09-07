/**
 * The salary expectation the system states on the person's behalf.
 *
 * Authorized by the person on 2026-09-07: "the worker should be able to do
 * it autonomously every time", weighing the posting's own range, how well
 * the role fits, and where it is. The figure is never invented from the
 * market or a title. It rests on three numbers the person stored on the
 * profile -- a hard floor, a target minimum, an ideal -- and on the range
 * the employer printed, if any. Pure, so every rule below is tested
 * without a database.
 *
 * Rules, in order:
 *  1. The employer printed an annual range. The answer sits inside it:
 *     halfway by default, higher (70%) when the match is strong, lower
 *     (40%) when the role is a stretch met on few of its requirements.
 *     Never below the person's target minimum unless the range tops out
 *     under it, in which case the top of the range. Rounded to $1,000.
 *  2. An hourly or monthly range is read as annual first.
 *  3. No range printed: the ideal for a Chicagoland or remote role; the
 *     minimum-to-ideal span for anything else, where the number is less
 *     certain.
 *  4. Below the hard floor there is no answer: the job would not be
 *     eligible, and stating a number under the floor is not a negotiation
 *     move the person wants made.
 */
export interface SalaryPosting {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryPeriod: string | null;        // YEAR | HOUR | MONTH | null
  remotePolicy: string | null;
  metro: string | null;
}
export interface SalaryFit {
  matchScore: number | null;
  matchProvisional: boolean;
  candidacyVerdict: string | null;    // APPLICATION_CANDIDATE | STRETCH | ...
  hardMet: number | null;
  hardTotal: number | null;
}
export interface SalaryProfile { floor: number | null; min: number | null; ideal: number | null }
export type SalaryAnswer = { value: string; annual: number; because: string } | { block: string };

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const round1k = (n: number) => Math.round(n / 1000) * 1000;

/** A posted amount as an annual figure, or null when it cannot be read as one. */
export function annualize(amount: number | null, period: string | null): number | null {
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return null;
  const p = String(period ?? "").toUpperCase();
  if (p === "HOUR" || (p === "" && amount < 500)) return amount * 2080;
  if (p === "MONTH" || (p === "" && amount < 20_000)) return amount * 12;
  return amount;
}

export function salaryExpectation(profile: SalaryProfile, posting: SalaryPosting | null, fit: SalaryFit | null): SalaryAnswer {
  const { floor, min, ideal } = profile;
  if (typeof ideal !== "number" && typeof min !== "number") {
    return { block: "no salary target is stored on the profile; a figure is never invented from the posting or the market" };
  }
  const target = (typeof ideal === "number" ? ideal : min) as number;
  const low = typeof min === "number" ? min : target;

  const lo = annualize(posting?.salaryMin ?? null, posting?.salaryPeriod ?? null);
  const hi = annualize(posting?.salaryMax ?? null, posting?.salaryPeriod ?? null);
  if (lo !== null && hi !== null && hi >= lo) {
    if (typeof floor === "number" && hi < floor) {
      return { block: `the posted range tops out at ${usd(hi)}, under the ${usd(floor)} floor; no figure is stated for a role that cannot be taken` };
    }
    // Where in the range: strong match asks higher, a thin stretch lower.
    let p = 0.5;
    const ratio = fit && fit.hardTotal ? (fit.hardMet ?? 0) / fit.hardTotal : null;
    const strong = (fit?.matchScore ?? 0) >= 60 && !fit?.matchProvisional || fit?.candidacyVerdict === "APPLICATION_CANDIDATE";
    const thin = fit?.candidacyVerdict === "STRETCH" && ((ratio !== null && ratio < 0.5) || (fit?.matchScore ?? 100) < 40);
    if (strong) p = 0.7; else if (thin) p = 0.4;
    let annual = lo + (hi - lo) * p;
    if (hi < low) annual = hi;                        // the range tops out under the person's minimum: ask for its top
    else annual = Math.min(hi, Math.max(annual, low, lo));
    annual = round1k(annual);
    return { value: usd(annual), annual,
      because: `${usd(lo)}–${usd(hi)} is the posted range; ${strong ? "a strong match asks in its upper part" : thin ? "a thin stretch asks in its lower part" : "the middle of the range"}, and never under the ${usd(low)} target minimum` };
  }

  // No range printed. A Chicagoland or remote role is the person's own
  // market: the ideal. Elsewhere the number is less certain: min to ideal.
  const remote = /remote/i.test(String(posting?.remotePolicy ?? ""));
  // With no posting facts at all there is nothing to weigh; the ideal stands.
  const home = !posting || posting.metro === "Chicagoland" || remote;
  if (home || typeof min !== "number" || min === target) {
    return { value: usd(target), annual: target, because: `no range is posted; ${home ? "a Chicagoland/remote role" : "the role"} is answered with the ideal target on the profile` };
  }
  return { value: `${usd(low)} to ${usd(target)}`, annual: target,
    because: "no range is posted and the role is outside Chicagoland; the profile's minimum-to-ideal span is stated" };
}

/**
 * When the employer offers salary bands as options ("$100,000 - $120,000",
 * "Under $80k", "$150k+"), the band holding the figure, or the nearest band
 * above it; null when no option reads as a band.
 */
export function pickSalaryOption(options: string[], annual: number): string | null {
  const parse = (o: string): { lo: number; hi: number } | null => {
    const nums = [...o.matchAll(/\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?/gi)]
      .map((m) => Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1)).filter((n) => n >= 1000);
    if (!nums.length) return null;
    if (nums.length >= 2) return { lo: Math.min(nums[0]!, nums[1]!), hi: Math.max(nums[0]!, nums[1]!) };
    if (/under|below|less than|up to|<|\bor less\b/i.test(o)) return { lo: 0, hi: nums[0]! };
    if (/\+|over|above|more than|>|\bor more\b|and up/i.test(o)) return { lo: nums[0]!, hi: Number.POSITIVE_INFINITY };
    return { lo: nums[0]!, hi: nums[0]! };
  };
  const bands = options.map((o) => ({ o, b: parse(o) })).filter((x) => x.b) as Array<{ o: string; b: { lo: number; hi: number } }>;
  if (!bands.length) return null;
  const holding = bands.find((x) => annual >= x.b.lo && annual <= x.b.hi);
  if (holding) return holding.o;
  const above = bands.filter((x) => x.b.lo > annual).sort((a, b) => a.b.lo - b.b.lo)[0];
  return above?.o ?? bands.sort((a, b) => b.b.hi - a.b.hi)[0]!.o;
}
