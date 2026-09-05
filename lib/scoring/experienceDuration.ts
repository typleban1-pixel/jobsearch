/**
 * Conservative experience-duration resolver.
 *
 * Answers "how many years of X?" and "do you have N+ years of X?" from
 * VERIFIED employment evidence ALONE, never from optimism. Its whole job is
 * to state the greatest figure the evidence DEFINITELY supports and no more.
 *
 * The rules it enforces, each of which was a way to overstate:
 *   - count only the periods whose role evidence establishes the capability;
 *     a skill is not assumed to have existed for a whole employment merely
 *     because the person held the job;
 *   - never double-count overlapping employment (a full-time role and a
 *     concurrent contract are one span of calendar time, not two) -- matched
 *     intervals are merged before their length is summed;
 *   - never round upward -- a partial year is floored;
 *   - a threshold is answered YES only when the merged span definitely
 *     reaches it; short of that it is UNRESOLVED, never a guessed NO
 *     (absence of recorded evidence is not evidence the person lacks it);
 *   - an exact-number answer is the floored whole-year span, a defensible
 *     lower bound;
 *   - if nothing matches, the answer is UNRESOLVED, not zero.
 *
 * Pure and deterministic: it takes the records and an as-of month, returns
 * the figure AND the exact intervals it summed, so every number is auditable
 * and can be persisted as its own justification.
 */

/** One employment span, as employment_records stores it. */
export interface EmploymentRecord {
  employer: string;
  title: string;                 // actual_title (fall back to display_title)
  startMonth: string;            // ISO date; month granularity is enough
  endMonth: string | null;      // null when is_current
  isCurrent: boolean;
  status: string;                // only VERIFIED spans are counted
  titleText: string;             // the role title, lowercased
  evidenceText: string;          // title + responsibilities + accomplishments + tools, lowercased
}

export interface Interval { start: number; end: number; employer: string; title: string }

export type Resolution = "ESTABLISHED" | "UNRESOLVED";

export interface DurationResult {
  object: "GENERAL_PROFESSIONAL" | "SPECIFIC";
  capability: string;
  months: number;                // merged, non-overlapping
  years: number;                 // floor(months / 12) -- never rounded up
  intervals: Interval[];         // exactly the spans summed, for provenance
  resolution: Resolution;
  basis: string;
}

/** Months since an epoch, from an ISO date. Month granularity, day ignored. */
function toMonthIndex(iso: string): number {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return NaN;
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

/** Words that name no capability, stripped before matching an object. */
const FILLER = new Set(["experience", "years", "year", "of", "in", "with", "the", "a", "an",
  "and", "or", "for", "at", "professional", "relevant", "overall", "total", "combined",
  "minimum", "least", "plus", "work", "working", "hands-on", "direct", "proven", "demonstrated"]);

/** A term asking about general career length rather than a specific skill. */
const GENERAL = /^(?:general |overall |total |combined |full[- ]time )?(?:work|professional|industry|relevant)?\s*experience$/i;

/**
 * Pull the threshold and the capability object out of a requirement or
 * question. "5+ years of digital marketing experience" -> {threshold:5,
 * object:"digital marketing"}. A bare "3 years" -> general professional.
 */
export function parseYearsRequirement(text: string): { threshold: number | null; object: string } {
  const t = String(text ?? "").toLowerCase().trim();
  // First number that is a years figure ("5+ years", "5 years", "minimum of 5").
  const num = /(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)/.exec(t) ?? /(?:minimum|at least|min\.?)\s*(?:of\s*)?(\d+)/.exec(t);
  const threshold = num ? Number(num[1]) : null;
  // Object = what remains after removing the years clause and filler.
  let obj = t
    .replace(/\d+(?:\.\d+)?\s*\+?\s*(?:years?|yrs?)/g, " ")
    .replace(/(?:minimum|at least|min\.?)\s*(?:of\s*)?\d+/g, " ")
    .replace(/\bhow many\b|\bdo you have\b|\bof experience\b|\?/g, " ")
    .replace(/[^a-z0-9+#\s-]+/g, " ")
    .split(/\s+/).filter((w) => w && !FILLER.has(w)).join(" ").trim();
  if (!obj || GENERAL.test(`${obj} experience`)) obj = "";
  return { threshold, object: obj };
}

/** Does a role's evidence establish this capability object? */
function roleEstablishes(rec: EmploymentRecord, objectTokens: string[]): boolean {
  if (!objectTokens.length) return true;                 // general professional: every role counts
  // Match the capability against the TITLE, not the whole description. The
  // title is the role's own claim of what it WAS; a responsibilities line
  // like "collaborated with marketing" mentions a capability the person did
  // not necessarily hold, and crediting a span from it would overstate. This
  // under-counts before it over-counts, which is the only safe direction.
  // Every significant token of the object must appear, so "product marketing"
  // is not credited to a role titled only "marketing".
  return objectTokens.every((tok) => rec.titleText.includes(tok));
}

/** Merge overlapping/adjacent intervals and total their length in months. */
function mergeMonths(intervals: Interval[]): { months: number; merged: Interval[] } {
  if (!intervals.length) return { months: 0, merged: [] };
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {                  // overlap or touch -> one span
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ ...iv });
    }
  }
  const months = merged.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
  return { months, merged };
}

/**
 * The merged, floored duration the evidence supports for a capability.
 * asOfMonthIndex fixes "present" so the function stays pure.
 */
export function experienceFor(
  capability: string, records: EmploymentRecord[], asOfMonthIndex: number,
): DurationResult {
  const objectTokens = capability
    .toLowerCase().replace(/[^a-z0-9+#\s-]+/g, " ").split(/\s+/)
    .filter((w) => w && !FILLER.has(w));
  const isGeneral = objectTokens.length === 0;

  const matched: Interval[] = [];
  for (const rec of records) {
    if (rec.status !== "VERIFIED") continue;             // only established history
    const start = toMonthIndex(rec.startMonth);
    const end = rec.isCurrent || !rec.endMonth ? asOfMonthIndex : toMonthIndex(rec.endMonth);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (!roleEstablishes(rec, objectTokens)) continue;
    matched.push({ start, end, employer: rec.employer, title: rec.title });
  }

  const { months, merged } = mergeMonths(matched);
  const years = Math.floor(months / 12);                 // never rounded up
  const resolution: Resolution = matched.length > 0 ? "ESTABLISHED" : "UNRESOLVED";
  return {
    object: isGeneral ? "GENERAL_PROFESSIONAL" : "SPECIFIC",
    capability: isGeneral ? "professional experience" : capability,
    months, years, intervals: merged, resolution,
    basis: resolution === "UNRESOLVED"
      ? `no VERIFIED role establishes ${JSON.stringify(capability)}, so the duration is unresolved`
      : `${years} year(s) from ${merged.length} merged interval(s), overlaps not double-counted`,
  };
}

export type YearsAnswer =
  | { kind: "NUMERIC"; years: number; result: DurationResult }
  | { kind: "THRESHOLD_YES"; threshold: number; result: DurationResult }
  | { kind: "UNRESOLVED"; reason: string; result: DurationResult };

/**
 * Answer one years question conservatively.
 *   - a threshold ("N+ years of X") is YES only if the merged span definitely
 *     reaches N; otherwise UNRESOLVED (never a guessed NO);
 *   - an open number ("how many years of X") is the floored whole-year span
 *     when established, else UNRESOLVED.
 */
export function resolveYearsQuestion(
  text: string, records: EmploymentRecord[], asOfMonthIndex: number,
): YearsAnswer {
  const { threshold, object } = parseYearsRequirement(text);
  const result = experienceFor(object, records, asOfMonthIndex);
  if (result.resolution === "UNRESOLVED") {
    return { kind: "UNRESOLVED", reason: result.basis, result };
  }
  if (threshold !== null) {
    if (result.years >= threshold) return { kind: "THRESHOLD_YES", threshold, result };
    return { kind: "UNRESOLVED",
      reason: `evidence definitely supports ${result.years} year(s) of ${JSON.stringify(result.capability)}, `
        + `which does not definitely reach the ${threshold}-year threshold; left for a person rather than answered No`,
      result };
  }
  return { kind: "NUMERIC", years: result.years, result };
}

/** Build resolver records from raw employment_records rows. */
export function toEmploymentRecords(rows: Array<Record<string, any>>): EmploymentRecord[] {
  return rows.map((r) => ({
    employer: r.employer ?? "",
    title: r.actual_title ?? r.display_title ?? "",
    startMonth: r.start_month ?? "",
    endMonth: r.end_month ?? null,
    isCurrent: !!r.is_current,
    status: r.status ?? "",
    titleText: `${r.actual_title ?? ""} ${r.display_title ?? ""}`.toLowerCase(),
    evidenceText: [
      r.actual_title, r.display_title,
      ...(Array.isArray(r.responsibilities) ? r.responsibilities : []),
      ...(Array.isArray(r.accomplishments) ? r.accomplishments : []),
      ...(Array.isArray(r.tools) ? r.tools : []),
    ].filter(Boolean).join(" · ").toLowerCase(),
  }));
}

/** Month index for an as-of ISO date (e.g. "2026-09-01"). */
export const monthIndexOf = (iso: string): number => toMonthIndex(iso);
