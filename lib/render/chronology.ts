/**
 * Which employment appears, and what the timeline says once it does.
 *
 * Two different questions live here, and keeping them apart is the
 * point. Whether a position earns space on a resume is a content
 * decision: an old, unrelated job that says nothing about this posting
 * can come off. Whether the resulting timeline still tells the truth is
 * not a content decision at all, and no amount of relevance can buy an
 * exemption from it.
 *
 * The rule is about the reader's impression, not about completeness. A
 * resume that simply does not reach back to 2015 claims nothing false. A
 * resume that shows 2019-2022 and then 2024-present, having quietly
 * dropped the job in between, tells the reader there was a gap that
 * never existed - or, dropped the other way, closes a gap that did.
 *
 * So an omission is permitted only where the time it covered is still
 * covered by something else, or falls outside the span the document
 * claims at all. Where it is not, the position stays as a chronology
 * entry: title, employer, dates, no bullets. That costs one line and
 * keeps the timeline honest.
 *
 * The renderer never decides any of this. It is handed a document and
 * prints it.
 */
import type { ResumeDoc, ResumeRole } from "./resume.ts";
import { authorizedSpans, type EmploymentRelationship } from "./relationships.ts";

export const CHRONOLOGY_VERSION = 2;

/**
 * How much uncovered time reads as a gap.
 *
 * Three months is deliberately short. A reader does not measure, they
 * notice, and the cost of being wrong in the strict direction is one
 * extra line on a resume, while the cost of being wrong in the other
 * direction is a document that misrepresents an employment history.
 */
export const MATERIAL_GAP_DAYS = 92;

const DAY = 86_400_000;
const day = (iso: string): number => Math.floor(Date.parse(iso) / DAY);
const today = (): number => Math.floor(Date.now() / DAY);

/**
 * A position's identity, including the precision of its dates.
 *
 * Precision is part of identity because "2022" and "June 2022" are
 * different claims about what is known, and a document may not upgrade
 * one into the other.
 */
export function employmentKey(r: ResumeRole): string {
  return [r.employer, r.title, r.start, r.end ?? "", r.startPrecision, r.endPrecision].join("␟");
}

const describe = (r: ResumeRole) =>
  `${r.title} at ${r.employer} (${r.start.slice(0, 4)}–${r.end ? r.end.slice(0, 4) : "present"})`;

/** An ongoing role runs to today; nothing extends past it. */
const span = (r: ResumeRole): [number, number] => [day(r.start), r.end ? day(r.end) : today()];

/** Merges overlapping employment into the periods actually covered. */
function coverage(roles: ResumeRole[]): Array<[number, number]> {
  const spans = roles.map(span).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of spans) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Time covered by `a` and not by `b`, as contiguous runs. */
function uncovered(a: Array<[number, number]>, b: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [s, e] of a) {
    let cursor = s;
    for (const [bs, be] of b) {
      if (be <= cursor) continue;
      if (bs >= e) break;
      if (bs > cursor) out.push([cursor, Math.min(bs, e)]);
      cursor = Math.max(cursor, be);
      if (cursor >= e) break;
    }
    if (cursor < e) out.push([cursor, e]);
  }
  return out;
}

export interface GapFinding {
  /** Days of employment the master covered and the document does not. */
  days: number;
  from: string; to: string;
  /** The omitted positions whose absence produced it. */
  because: string[];
}

/**
 * Gaps a document would show that the employment history does not have.
 *
 * Only time inside the span the document itself claims is considered: a
 * resume that starts in 2019 makes no assertion about 2015, so leaving
 * 2015 off invents nothing. Everything from the earliest position shown
 * up to the most recent employment is fair game, which is what stops the
 * current job from being dropped.
 */
export function misleadingGaps(master: ResumeDoc, shown: ResumeRole[]): GapFinding[] {
  if (!master.roles.length || !shown.length) return [];

  const masterCover = coverage(master.roles);
  const shownCover = coverage(shown);
  const windowStart = Math.min(...shown.map((r) => span(r)[0]));
  const windowEnd = Math.max(...master.roles.map((r) => span(r)[1]));

  const inWindow = masterCover
    .map(([s, e]) => [Math.max(s, windowStart), Math.min(e, windowEnd)] as [number, number])
    .filter(([s, e]) => e > s);

  const omitted = master.roles.filter((r) => !shown.some((s) => employmentKey(s) === employmentKey(r)));

  return uncovered(inWindow, shownCover)
    .filter(([s, e]) => e - s >= MATERIAL_GAP_DAYS)
    .map(([s, e]) => ({
      days: e - s,
      from: new Date(s * DAY).toISOString().slice(0, 10),
      to: new Date(e * DAY).toISOString().slice(0, 10),
      because: omitted.filter((r) => { const [rs, re] = span(r); return rs < e && re > s; }).map(describe),
    }));
}

/**
 * The invariant. Tailoring may choose what to show; it may not change
 * what happened.
 *
 * Refuses, in order: a position the evidence does not contain, a
 * position whose dates or date precision were altered, the same position
 * listed twice, the loss of the most recent employment, and any omission
 * that opens a gap the history does not have. Two stints merged into one
 * span fails the first check, because the merged span matches no
 * recorded position.
 */
export function assertChronologyIntact(
  master: ResumeDoc, tailored: ResumeDoc,
  /**
   * Spans a person explicitly confirmed as one continuous relationship.
   *
   * This is the one way a document may show a span that no single
   * employment record holds, and it is deliberately narrow: the
   * relationship has to name this employer, this title and exactly this
   * span. Two stints at one employer with no relationship record behind
   * them stay two stints, which is the protection this exception must
   * not weaken.
   */
  relationships: EmploymentRelationship[] = [],
): void {
  const known = new Map(master.roles.map((r) => [employmentKey(r), r]));
  for (const span of authorizedSpans(relationships)) {
    known.set([span.employer, span.title, span.start, span.end ?? "",
               span.startPrecision, span.endPrecision].join("␟"), null as any);
  }
  const seen = new Set<string>();

  for (const r of tailored.roles) {
    /**
     * An entry that presents several real periods.
     *
     * Admitted only on the terms that make it honest: every period it
     * prints must match a recorded position at this employer exactly,
     * dates and precision included, and it must print ALL of them. Drop
     * one and the entry hides a gap; invent one and it claims a period
     * that never happened. Either way this refuses.
     *
     * This is deliberately not the continuous-relationship exception
     * above. That one authorizes a single merged span on the strength of
     * someone stating the relationship was continuous. This authorizes
     * no span at all: the periods stay separate on the page, and the
     * reader sees the interruption.
     */
    if (r.periods?.length) {
      const atEmployer = master.roles.filter((m) => m.employer === r.employer);
      const key = (x: { start: string; end: string | null; startPrecision: string; endPrecision: string }) =>
        [x.start, x.end ?? "", x.startPrecision, x.endPrecision].join("\u241F");
      const rendered = new Set(r.periods.map(key));
      // The master may itself be consolidated. When it is, its Genius One
      // entry reports only the newest period on the role itself and holds
      // the real set in `periods`, so reading start and end off the role
      // would compare the tailored document against one of the two
      // periods it is supposed to contain, and reject it. Expand each
      // master role into the periods it actually stands for.
      const recorded = new Set(atEmployer.flatMap((m) =>
        (m.periods?.length ? m.periods : [m]).map(key)));

      for (const shown of rendered) {
        if (!recorded.has(shown)) {
          throw new Error(
            `${describe(r)} presents a period at ${r.employer} that no recorded position matches `
            + `(${shown.split("\u241F").slice(0, 2).join(" to ")}). Dates and date precision come from the evidence.`);
        }
      }
      for (const missing of recorded) {
        if (!rendered.has(missing)) {
          throw new Error(
            `${describe(r)} consolidates ${r.employer} but leaves out the period `
            + `${missing.split("\u241F").slice(0, 2).join(" to ")}. A consolidated entry has to print every real `
            + "period, or it hides an interruption in the employment.");
        }
      }
      // Register every period this entry stands for, under the same key
      // shape a separate entry would have used. Downstream checks ask
      // "was this position shown", and a consolidated entry genuinely
      // shows all of them; registering only the employer left the
      // most-recent-employment check unable to see the current period
      // and reporting it as omitted.
      for (const period of r.periods) {
        const k = employmentKey({ ...r, ...period });
        if (seen.has(k)) throw new Error(`${describe(r)} lists the same period twice`);
        seen.add(k);
      }
      continue;
    }

    const key = employmentKey(r);
    if (!known.has(key)) {
      // Three different defects reach here and the message says which.
      // A span covering several recorded periods is the interesting one:
      // it is not necessarily false, it is unauthorized, and the fix is
      // a confirmed relationship record rather than a looser check.
      const sameEmployer = master.roles.filter((m) => m.employer === r.employer);
      const spansSeveral = sameEmployer.length > 1
        && r.start <= sameEmployer.map((m) => m.start).sort()[0]!
        && sameEmployer.some((m) => (m.end ?? "9999") < (r.end ?? "9999"));
      throw new Error(
        spansSeveral
          ? `${describe(r)} covers ${sameEmployer.length} separate recorded periods at ${r.employer}, `
            + "and no confirmed continuous-relationship record authorizes that span. Separate stints stay separate "
            + "until someone states that the relationship was continuous."
          : sameEmployer.length
            ? `${describe(r)} does not match the recorded employment for ${r.employer}: `
              + `${sameEmployer.map(describe).join("; ")}. Dates, date precision and titles are taken from the evidence and never adjusted.`
            : `${describe(r)} is employment the evidence does not contain`);
    }
    if (seen.has(key)) throw new Error(`${describe(r)} is listed twice`);
    seen.add(key);
  }

  if (!master.roles.length) return;

  // The most recent position is never optional: dropping it reads as
  // unemployment, whatever the arithmetic says.
  const latestEnd = Math.max(...master.roles.map((r) => span(r)[1]));
  const current = master.roles.filter((r) => span(r)[1] === latestEnd);
  // A consolidated relationship stands in for the periods it covers, so
  // the most recent work is present when either the record or the
  // relationship that contains it is shown.
  const currentShown = current.some((r) => seen.has(employmentKey(r)))
    || relationships.some((rel) =>
         current.some((r) => r.employer === rel.employer)
         && tailored.roles.some((t) => t.employer === rel.employer && t.end === rel.end && t.start === rel.start));
  if (tailored.roles.length && !currentShown) {
    throw new Error(`the most recent employment (${current.map(describe).join(" / ")}) was omitted, `
      + "which reads as unemployment since then");
  }

  for (const gap of misleadingGaps(master, tailored.roles)) {
    throw new Error(`omitting ${gap.because.join(", ")} opens a ${Math.round(gap.days / 30)} month gap `
      + `(${gap.from} to ${gap.to}) that the employment history does not have; `
      + "keep it as a chronology entry with no bullets instead");
  }
}

/**
 * How many recent positions always appear, however little they have to
 * say.
 *
 * Truncating the tail of a work history is normal and claims nothing
 * false: a resume that starts in 2019 is not asserting that 2018 was
 * idle. Truncating it all the way down is different. A record of five
 * positions shown as one reads as a career that began two years ago,
 * and that impression is false even though every date on the page is
 * right. Three is where a document stops reading as a history and starts
 * reading as a snapshot.
 *
 * This is a content policy, not the truth invariant: it only ever keeps
 * more than the invariant demands, never less.
 */
export const RECENT_POSITIONS_SHOWN = 3;

export interface EmploymentSelection {
  roles: ResumeRole[];
  omitted: Array<{ role: string; why: string }>;
  /** Kept for the timeline alone, with nothing to say about this job. */
  chronologyOnly: string[];
}

/**
 * Chooses which positions appear.
 *
 * A position with something to say about this posting is always shown. A
 * position with nothing to say is dropped only where dropping it leaves
 * the timeline unchanged; otherwise it stays, with no bullets, because a
 * line of dates is a smaller cost than a gap that did not happen.
 *
 * Oldest first, one at a time, re-checking after each: dropping two
 * positions can open a gap that dropping either alone does not.
 */
export function selectEmployment(master: ResumeDoc, tailored: ResumeRole[]): EmploymentSelection {
  const omitted: Array<{ role: string; why: string }> = [];
  let kept = [...tailored];

  // The most recent positions are not offered up for omission at all.
  const recent = new Set([...tailored]
    .sort((a, b) => span(b)[1] - span(a)[1] || day(b.start) - day(a.start))
    .slice(0, RECENT_POSITIONS_SHOWN)
    .map(employmentKey));

  const candidates = [...tailored]
    .filter((r) => r.lines.length === 0 && !recent.has(employmentKey(r)))
    .sort((a, b) => day(a.start) - day(b.start));

  for (const c of candidates) {
    const without = kept.filter((r) => employmentKey(r) !== employmentKey(c));
    if (!without.length) continue;
    try {
      assertChronologyIntact(master, { ...master, roles: without });
      kept = without;
      omitted.push({ role: describe(c), why: "nothing in it speaks to this posting, and leaving it off changes no dates and opens no gap" });
    } catch {
      // Refused: it is load-bearing for the timeline, so it stays.
    }
  }

  return {
    roles: kept,
    omitted,
    chronologyOnly: kept.filter((r) => r.lines.length === 0).map(describe),
  };
}
