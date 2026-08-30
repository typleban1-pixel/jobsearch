/**
 * Compensation, travel, quota and equity.
 *
 * Salary is the most dangerous field to get wrong, because a hard floor
 * is a deal breaker rather than a preference: a misparsed number silently
 * excludes a job the user wanted, or admits one they did not. So a
 * structured field from the board is trusted, and a number scraped out of
 * prose is only accepted when it sits next to compensation language and
 * lands in a plausible range.
 */

export interface Compensation {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: "YEAR" | "HOUR" | "MONTH" | null;
  salarySource: string | null;
  warnings: string[];
}

const COMP_CONTEXT =
  /(salary|compensation|base pay|pay range|pay band|annual|per year|hourly|per hour|\bOTE\b|target earnings)/i;

export function parseStructuredSalary(input: {
  min?: number | null; max?: number | null; currency?: string | null;
  interval?: string | null; source: string;
}): Compensation | null {
  const min = toNumber(input.min);
  const max = toNumber(input.max);
  if (min === null && max === null) return null;
  return {
    salaryMin: min, salaryMax: max,
    salaryCurrency: (input.currency || "USD").toUpperCase(),
    salaryPeriod: normalizePeriod(input.interval),
    salarySource: input.source,
    warnings: [],
  };
}

/**
 * Last resort, and deliberately narrow. Requires a real range (two
 * numbers), compensation language within 120 characters, and both values
 * inside a plausible band. Everything else is left null: salary_unknown
 * is a score reason the system already handles, and a wrong number is not.
 */
export function parseSalaryFromText(text: string): Compensation | null {
  const warnings: string[] = [];
  const re = /\$\s?([\d,]{3,12}(?:\.\d+)?)\s*(?:k\b)?\s*(?:-|–|—|to)\s*\$?\s?([\d,]{3,12}(?:\.\d+)?)\s*(?:k\b)?/gi;

  for (const m of text.matchAll(re)) {
    const start = Math.max(0, m.index - 120);
    const context = text.slice(start, m.index + m[0].length + 120);
    if (!COMP_CONTEXT.test(context)) continue;

    let lo = Number(m[1]!.replace(/,/g, ""));
    let hi = Number(m[2]!.replace(/,/g, ""));
    if (/k/i.test(m[0])) { if (lo < 1000) lo *= 1000; if (hi < 1000) hi *= 1000; }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) continue;

    const hourly = /per hour|hourly|\/\s?hr|an hour/i.test(context);
    if (hourly) {
      if (lo < 7 || hi > 500) continue;
      warnings.push("salary read from posting text (hourly); verify before relying on it");
      return { salaryMin: Math.round(lo), salaryMax: Math.round(hi), salaryCurrency: "USD",
               salaryPeriod: "HOUR", salarySource: "description_text", warnings };
    }
    if (lo < 20_000 || hi > 2_000_000) continue;
    warnings.push("salary read from posting text rather than a structured field; verify before relying on it");
    return { salaryMin: Math.round(lo), salaryMax: Math.round(hi), salaryCurrency: "USD",
             salaryPeriod: "YEAR", salarySource: "description_text", warnings };
  }
  return null;
}

export interface CareerSignals {
  travelRequirementPct: number | null;
  hasQuotaOrCommission: boolean | null;
  mentionsEquity: boolean | null;
}

/**
 * The four signals postings state reliably. Absence is null, not false:
 * a posting that never mentions equity is not a posting that offers none.
 */
export function parseCareerSignals(text: string): CareerSignals {
  const travel = text.match(/\b(?:up to\s*)?(\d{1,3})\s?%\s*(?:of\s*(?:the\s*)?time\s*)?(?:travel|traveling|travelling)/i)
    ?? text.match(/\btravel(?:ing|ling)?\s*(?:requirement)?\s*(?:of|:)?\s*(?:up to\s*)?(\d{1,3})\s?%/i);
  let travelPct: number | null = null;
  if (travel?.[1]) {
    const n = Number(travel[1]);
    if (n >= 0 && n <= 100) travelPct = n;
  } else if (/\bno travel\b|\btravel:\s*none\b/i.test(text)) {
    travelPct = 0;
  }

  const quota = /\b(quota|commission|OTE\b|on-target earnings|variable compensation|sales incentive)\b/i.test(text)
    ? true : null;
  const equity = /\b(equity|stock options|RSUs?|restricted stock|share options|ESOP)\b/i.test(text)
    ? true : null;

  return { travelRequirementPct: travelPct, hasQuotaOrCommission: quota, mentionsEquity: equity };
}

export type EmploymentArrangement =
  | "FULL_TIME" | "PART_TIME" | "CONTRACT" | "CONTRACT_TO_HIRE"
  | "INTERNSHIP" | "TEMPORARY" | "UNKNOWN";

export function parseEmployment(hint: string | null | undefined, title: string): EmploymentArrangement {
  const h = (hint ?? "").toLowerCase();
  if (h) {
    if (/intern/.test(h)) return "INTERNSHIP";
    if (/contract to hire|c2h/.test(h)) return "CONTRACT_TO_HIRE";
    if (/contract|contractor|freelance/.test(h)) return "CONTRACT";
    if (/part[- ]?time/.test(h)) return "PART_TIME";
    if (/temp/.test(h)) return "TEMPORARY";
    // Lever says "Permanent" / "Regular" / "Full-time" for the same thing.
    if (/full[- ]?time|permanent|regular/.test(h)) return "FULL_TIME";
  }
  const t = title.toLowerCase();
  if (/\bintern(ship)?\b|\bco-?op\b/.test(t)) return "INTERNSHIP";
  if (/\bcontract(or)?\b/.test(t)) return "CONTRACT";
  if (/\bpart[- ]?time\b/.test(t)) return "PART_TIME";
  return "UNKNOWN";
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v.replace(/[^0-9.]/g, "")) : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function normalizePeriod(interval?: string | null): "YEAR" | "HOUR" | "MONTH" | null {
  const i = (interval ?? "").toLowerCase();
  if (/hour/.test(i)) return "HOUR";
  if (/month/.test(i)) return "MONTH";
  if (/year|annual|salary/.test(i)) return "YEAR";
  return interval ? null : "YEAR";
}
