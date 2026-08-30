/**
 * Salary comparison.
 *
 * Two rules, both learned from the data rather than assumed.
 *
 * ANNUALIZE FIRST. The corpus contains a role posted at 66 to 67 dollars
 * per hour. Compared raw against an 85,000 floor that reads as below
 * floor and gets excluded, when it is actually worth about 139,000 a
 * year. One job today, but the bug is silent and the cost is a good role
 * disappearing without trace.
 *
 * ONLY THE TOP OF A KNOWN BAND IS DEFINITIVE. A floor may exclude a job
 * only when the posted MAXIMUM is definitively below it. A posting that
 * states a minimum and no maximum tells us nothing about the ceiling, so
 * it stays in and carries uncertainty instead.
 */

export const HOURS_PER_YEAR = 2080;   // 40 hours, 52 weeks
export const MONTHS_PER_YEAR = 12;

export function annualize(amount: number | null, period: string | null): number | null {
  if (amount === null) return null;
  switch ((period ?? "YEAR").toUpperCase()) {
    case "HOUR": return Math.round(amount * HOURS_PER_YEAR);
    case "MONTH": return Math.round(amount * MONTHS_PER_YEAR);
    case "YEAR": return Math.round(amount);
    default: return null;      // unrecognised period is unknown, not a year
  }
}

export type FloorVerdict = "BELOW_FLOOR" | "AT_OR_ABOVE_FLOOR" | "INDETERMINATE";

export function compareToFloor(input: {
  salaryMin: number | null;
  salaryMax: number | null;
  period: string | null;
  isEstimated: boolean;
  floor: number | null;
}): { verdict: FloorVerdict; annualizedMax: number | null; detail: string } {
  const { salaryMin, salaryMax, period, isEstimated, floor } = input;
  if (floor === null) {
    return { verdict: "INDETERMINATE", annualizedMax: null, detail: "no floor set" };
  }
  // An aggregator's guess must never be strong enough to exclude a job.
  if (isEstimated) {
    return { verdict: "INDETERMINATE", annualizedMax: null, detail: "salary is an estimate, not employer-stated" };
  }
  const max = annualize(salaryMax, period);
  if (max === null) {
    const min = annualize(salaryMin, period);
    if (min !== null && min >= floor) {
      return { verdict: "AT_OR_ABOVE_FLOOR", annualizedMax: null,
               detail: `stated minimum ${min.toLocaleString()} already clears the floor` };
    }
    return { verdict: "INDETERMINATE", annualizedMax: null,
             detail: "no maximum stated, so the ceiling is unknown" };
  }
  return max < floor
    ? { verdict: "BELOW_FLOOR", annualizedMax: max,
        detail: `posted maximum ${max.toLocaleString()} is below the ${floor.toLocaleString()} floor` }
    : { verdict: "AT_OR_ABOVE_FLOOR", annualizedMax: max,
        detail: `posted maximum ${max.toLocaleString()}` };
}
