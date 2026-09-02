/**
 * One line per organization, when a person has said it was one thing.
 *
 * The granular records hold Genius One twice, 2019 to 2022 and 2024 to
 * present, because that is how the evidence was gathered. Printed as
 * they stand they read as two engagements with a gap, which is not what
 * happened: the relationship never stopped, the workload changed, and
 * for part of it the work ran alongside a full-time job somewhere else.
 *
 * A consolidated span is therefore never something this module works
 * out. It is something it is TOLD, by a relationship record that names
 * who confirmed it and what it covers. Without that record the periods
 * render separately, however obvious the continuity looks, because the
 * cases where it looks obvious are exactly the cases where the
 * temptation to assume it is strongest: same employer, same title,
 * adjacent dates, and a gap that would disappear.
 *
 * Nothing here rewrites, merges or discards a granular record. Each
 * consolidated entry names the records behind it, and every bullet still
 * cites the evidence it always cited.
 */
import type { ResumeRole } from "./resume.ts";

export const RELATIONSHIP_VERSION = 1;

export interface EmploymentRelationship {
  id: string;
  employer: string;
  displayTitle: string;
  location: string | null;
  /** "Contract", "Part-Time Contract", or null for ordinary employment. */
  qualifier: string | null;
  start: string;
  end: string | null;
  startPrecision: "YEAR" | "MONTH" | "DAY";
  endPrecision: "YEAR" | "MONTH" | "DAY";
  employmentType: string;
  workload: "VARIABLE" | "CONSISTENT_PART_TIME" | "CONSISTENT_FULL_TIME" | "UNKNOWN";
  coveredRecordIds: string[];
  continuityBasis: string;
  confirmedBy: string;
}

/** A granular period, as the records hold it. */
export interface EmploymentPeriod {
  id: string;
  employer: string;
  title: string;
  location: string | null;
  start: string;
  end: string | null;
  startPrecision: "YEAR" | "MONTH" | "DAY";
  endPrecision: "YEAR" | "MONTH" | "DAY";
  isCurrent: boolean;
  /** FULL_TIME, CONTRACT, and so on. Null where the record does not say. */
  employmentType?: string | null;
}

/**
 * The title as an employer reads it.
 *
 * The qualifier is a label, not a defence. "Contract" tells a recruiter
 * what kind of relationship this was in one word; a sentence explaining
 * that workload varied alongside other employment tells them the
 * candidate is worried about it. Full-time employment gets no qualifier
 * at all, because ordinary employment reads as ordinary only when
 * nothing draws attention to it.
 */
export function employerFacingTitle(displayTitle: string, qualifier: string | null): string {
  return qualifier ? `${displayTitle} (${qualifier})` : displayTitle;
}

/**
 * Checks a relationship against the periods it claims to consolidate.
 *
 * The database enforces this too. It is repeated here because the
 * renderer must not depend on having been handed good data, and because
 * a span that reaches past the evidence is the one failure that would
 * put invented employment on a resume.
 */
export function assertRelationshipAuthorized(
  rel: EmploymentRelationship, periods: EmploymentPeriod[],
): void {
  const covered = periods.filter((p) => rel.coveredRecordIds.includes(p.id));
  if (covered.length !== rel.coveredRecordIds.length) {
    throw new Error(`the ${rel.employer} relationship names ${rel.coveredRecordIds.length} employment records `
      + `but only ${covered.length} exist in this profile version`);
  }
  if (!covered.length) throw new Error(`the ${rel.employer} relationship covers no employment record`);

  const wrongEmployer = covered.filter((p) => p.employer !== rel.employer);
  if (wrongEmployer.length) {
    throw new Error(`the ${rel.employer} relationship covers a record for ${wrongEmployer[0]!.employer}`);
  }
  if (!rel.continuityBasis?.trim() || !rel.confirmedBy?.startsWith("user:")) {
    throw new Error(`the ${rel.employer} relationship states no human confirmation, so it authorizes nothing`);
  }

  const earliest = covered.map((p) => p.start).sort()[0]!;
  if (rel.start !== earliest) {
    throw new Error(`the ${rel.employer} relationship starts ${rel.start} but its earliest verified period starts ${earliest}`);
  }

  const ongoing = covered.some((p) => p.isCurrent || p.end === null);
  if (ongoing && rel.end !== null) {
    throw new Error(`the ${rel.employer} relationship is ongoing in the records but states an end date`);
  }
  if (!ongoing) {
    const latest = covered.map((p) => p.end ?? "").sort().reverse()[0]!;
    if (rel.end !== latest) {
      throw new Error(`the ${rel.employer} relationship ends ${rel.end} but its latest verified period ends ${latest}`);
    }
  }

  // Precision is a statement about what is known, and a relationship
  // inherits it rather than sharpening it.
  const startPrec = covered.slice().sort((a, b) => a.start.localeCompare(b.start))[0]!.startPrecision;
  if (rel.startPrecision !== startPrec) {
    throw new Error(`the ${rel.employer} relationship states ${rel.startPrecision} start precision `
      + `where the record states ${startPrec}; precision is never upgraded`);
  }
}

export interface ConsolidatedEntry extends ResumeRole {
  /** The granular records this line stands for. Never emptied. */
  fromRecordIds: string[];
  /** True when a confirmed relationship authorized the span. */
  consolidated: boolean;
  /**
   * Conventional full-time employment, as opposed to contract or
   * part-time work. Used for ordering and for nothing else: it never
   * changes what an entry says, only where it sits.
   */
  isFullTime: boolean;
  /**
   * Every bullet the covered periods make available.
   *
   * This is a CANDIDATE POOL, not a resume section. Consolidating two
   * periods gives tailoring more to choose between; it does not give the
   * document more to print, and content selection still decides what
   * earns space. `lines` carries the pool until selection runs.
   */
  candidateCount: number;
}

/**
 * Turns periods and relationships into the entries a resume shows.
 *
 * A period covered by an authorized relationship is folded into that
 * relationship's single entry; every other period stands on its own.
 * Bullets follow their periods, so a consolidated entry carries the
 * bullets of every period it covers, each still citing its own evidence.
 */
export function consolidateEmployment(
  periods: EmploymentPeriod[],
  relationships: EmploymentRelationship[],
  linesFor: (periodId: string) => ResumeRole["lines"],
): ConsolidatedEntry[] {
  for (const rel of relationships) assertRelationshipAuthorized(rel, periods);

  const claimed = new Map<string, EmploymentRelationship>();
  for (const rel of relationships) for (const id of rel.coveredRecordIds) claimed.set(id, rel);

  const entries: ConsolidatedEntry[] = [];

  for (const rel of relationships) {
    const covered = periods.filter((p) => rel.coveredRecordIds.includes(p.id))
      .sort((a, b) => a.start.localeCompare(b.start));
    entries.push({
      employer: rel.employer,
      title: employerFacingTitle(rel.displayTitle, rel.qualifier),
      location: rel.location,
      start: rel.start, end: rel.end,
      startPrecision: rel.startPrecision, endPrecision: rel.endPrecision,
      // The pool, not the output. Selection narrows it, and nothing here
      // reserves a place for each covered period: a period whose evidence
      // says nothing about the posting contributes nothing, exactly as it
      // would if the periods had never been consolidated.
      lines: covered.flatMap((p) => linesFor(p.id)),
      candidateCount: covered.reduce((n, p) => n + linesFor(p.id).length, 0),
      fromRecordIds: covered.map((p) => p.id),
      consolidated: covered.length > 1,
      isFullTime: rel.employmentType === "FULL_TIME",
    });
  }

  for (const p of periods) {
    if (claimed.has(p.id)) continue;
    entries.push({
      employer: p.employer, title: p.title, location: p.location,
      start: p.start, end: p.end,
      startPrecision: p.startPrecision, endPrecision: p.endPrecision,
      lines: linesFor(p.id),
      candidateCount: linesFor(p.id).length,
      fromRecordIds: [p.id],
      consolidated: false,
      isFullTime: p.employmentType === "FULL_TIME",
    });
  }

  return orderForRecruiter(entries);
}

/**
 * Reverse chronological, ordered by when each thing was TAKEN ON.
 *
 * Ordering by end date is the usual reading of "reverse chronological",
 * and for a history without overlap the two are identical. They differ
 * exactly where this history does. A long contract relationship running
 * from 2019 to the present ends later than a full-time job held from
 * 2022 to 2024, so an end-date sort puts both contracts above it and the
 * top of the resume reads as three equivalent concurrent jobs.
 *
 * Ordering by start date says something truer and simpler: here is what
 * I took on most recently, and here is what was already running when I
 * did. A full-time position begun inside a longer contract relationship
 * therefore leads, and it does so because it started later, not because
 * anything decided full-time work matters more. The dates are all
 * printed; nothing is hidden and nothing is explained away.
 *
 * The sort is on per-entry values only, so it is a strict total order
 * and never depends on the order rows arrive in:
 *
 *   1. later start first;
 *   2. then conventional full-time employment, which settles the case of
 *      two things begun the same month;
 *   3. then ongoing work before finished work;
 *   4. then later end first;
 *   5. then employer name, which decides nothing and makes the output
 *      identical on every run.
 *
 * End date is deliberately fourth. A contract that happens to run longer
 * can no longer push a full-time position down the page, which is the
 * misreading this ordering exists to prevent.
 */
export function orderForRecruiter<T extends {
  start: string; end: string | null; employer: string; isFullTime?: boolean;
}>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.start !== b.start) return b.start.localeCompare(a.start);
    if (Boolean(a.isFullTime) !== Boolean(b.isFullTime)) return a.isFullTime ? -1 : 1;
    if ((a.end === null) !== (b.end === null)) return a.end === null ? -1 : 1;
    const ae = a.end ?? "", be = b.end ?? "";
    if (ae !== be) return be.localeCompare(ae);
    return a.employer.localeCompare(b.employer);
  });
}

/**
 * The spans a document is allowed to show for an employer.
 *
 * Used by the chronology invariant: an entry is legitimate when it
 * matches a granular period exactly, or when it matches a relationship
 * a person authorized. Nothing else, which is what keeps two genuinely
 * separate stints separate.
 */
export function authorizedSpans(relationships: EmploymentRelationship[]): Array<{
  employer: string; title: string; start: string; end: string | null;
  startPrecision: string; endPrecision: string;
}> {
  return relationships.map((r) => ({
    employer: r.employer,
    title: employerFacingTitle(r.displayTitle, r.qualifier),
    start: r.start, end: r.end,
    startPrecision: r.startPrecision, endPrecision: r.endPrecision,
  }));
}


/**
 * The employer a verified profile wants encountered first.
 *
 * This is a PRESENTATION decision and it is written here as one rather
 * than smuggled into the chronology. Ty asked that Genius One lead the
 * experience section because it is his current ongoing relationship
 * (2019 to present, Contract) and he wants a recruiter to meet the
 * current work first. Nothing about the dates, the employment type or
 * the "(Contract)" qualifier changes to achieve it: the entry is printed
 * exactly as the relationship states, it simply appears first.
 *
 * Deliberately NOT expressed by pretending Genius One started later, and
 * deliberately NOT a relevance signal. Where an employer sits on the
 * page and which of its claims are chosen are separate questions, and
 * this touches only the first.
 */
export const LEAD_EMPLOYER = "Genius One, Inc.";

/**
 * Chronological order, with the lead employer hoisted to the front.
 *
 * The chronology is computed first and completely, then one entry is
 * moved. Everything below the lead keeps the order orderForRecruiter
 * produced, so the rest of the page still reads later-start-first and
 * remains a strict total order independent of input order. An absent
 * lead employer changes nothing.
 */
export function orderForPresentation<T extends {
  start: string; end: string | null; employer: string; isFullTime?: boolean;
}>(entries: T[], lead: string = LEAD_EMPLOYER): T[] {
  const ordered = orderForRecruiter(entries);
  return [...ordered.filter((e) => e.employer === lead), ...ordered.filter((e) => e.employer !== lead)];
}
