/**
 * The employment timeline, and what a tailored resume may do to it.
 *
 * The document is allowed to be selective. A position from 2016 that
 * says nothing about the job being applied for can come off, and the
 * resume simply starts later. What it may never do is leave the reader
 * with a false impression of the timeline: a gap that did not happen, a
 * gap that did happen closed up, two separate stints presented as one
 * run, or a date adjusted to make any of that work.
 *
 * The fixture below is built to make those cases separable: an interior
 * position that is load-bearing for the timeline, an old one that is
 * not, a contract that overlaps a staff role, and two separate stints at
 * one employer. Runs offline.
 */
import { assertChronologyIntact, selectEmployment, misleadingGaps, MATERIAL_GAP_DAYS,
         RECENT_POSITIONS_SHOWN } from "../lib/render/chronology.ts";
import { assembleTailoredDoc } from "../lib/render/tailoredDoc.ts";
import { renderResumeHtml } from "../lib/render/resumePdf.ts";
import type { ResumeDoc, ResumeRole } from "../lib/render/resume.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++; else fails.push(`  ${name}\n      ${detail}`);
};
/** Runs `f` and returns the refusal message, or "" if it was allowed. */
const refusal = (f: () => void): string => { try { f(); return ""; } catch (e) { return String(e); } };

const line = (text: string, ...sources: string[]) => ({ text, sources });
const role = (employer: string, title: string, start: string, end: string | null,
              lines: string[] = [], precision: "YEAR" | "MONTH" = "YEAR"): ResumeRole => ({
  employer, title, location: "Cleveland, OH", start, end,
  startPrecision: precision, endPrecision: precision,
  lines: lines.map((t, i) => line(t, `${employer}-${title}-${i}`)),
});

const CURRENT = role("Genius One, Inc.", "Operations Specialist", "2024-01-01", null,
  ["Built pricing models for vendor contracts"]);
const STAFF = role("Holley Performance", "Videographer", "2022-01-01", "2024-01-01",
  ["Produced video for national campaigns"]);
// Runs inside the staff role. Two jobs at once, which is the truth.
const CONTRACT = role("Sideline Media", "Contract Colorist", "2022-06-01", "2023-06-01",
  ["Graded footage for broadcast delivery"], "MONTH");
// Interior. Nothing else covers 2019-2022, so this one holds the line.
const INTERIOR = role("Lorain County CC", "Media Technician", "2019-01-01", "2022-01-01",
  ["Maintained studio broadcast equipment"]);
// Oldest, and separated from the rest by a real gap the resume does not
// have to explain, because it does not reach back that far.
const OLDEST = role("Lorain County CC", "Student Assistant", "2016-01-01", "2017-01-01",
  ["Set up cameras for campus events"]);

// Old enough to be past the floor, and separated from everything else,
// so leaving it off truncates the history rather than perforating it.
const ANCIENT = role("Campus Recreation", "Equipment Attendant", "2013-01-01", "2014-01-01",
  ["Issued and tracked rental equipment"]);

const HISTORY: ResumeDoc = {
  name: "Ty Pleban", email: "x@example.com", phone: null, location: "Cleveland, OH", links: [],
  summary: line("A summary sentence.", "s1"),
  roles: [CURRENT, STAFF, CONTRACT, INTERIOR, OLDEST, ANCIENT],
  education: [{ institution: "Leavitt School of Health", credential: "B.S.", field: "Health Science" }],
  skillGroups: [], projects: [],
};
const withRoles = (roles: ResumeRole[]): ResumeDoc => ({ ...HISTORY, roles });

// 1. An old, irrelevant position may come off when the timeline is
//    unaffected. The resume just starts later, which claims nothing.
check("dropping the oldest positions, outside the span the resume claims, is allowed",
  refusal(() => assertChronologyIntact(HISTORY, withRoles([CURRENT, STAFF, CONTRACT, INTERIOR]))) === "",
  refusal(() => assertChronologyIntact(HISTORY, withRoles([CURRENT, STAFF, CONTRACT, INTERIOR]))));
check("and no gap is reported for them",
  misleadingGaps(HISTORY, [CURRENT, STAFF, CONTRACT, INTERIOR]).length === 0, "");

// 2. An omission that opens a gap the history does not have is refused.
{
  const why = refusal(() => assertChronologyIntact(HISTORY, withRoles([CURRENT, STAFF, CONTRACT, OLDEST])));
  check("dropping the interior position is refused", why !== "", "it was allowed");
  check("and the refusal names the position and the gap it opens",
    /Media Technician/.test(why) && /gap/i.test(why) && /2019|2022/.test(why), why);
  const gaps = misleadingGaps(HISTORY, [CURRENT, STAFF, CONTRACT, OLDEST]);
  check("the gap is measured, not guessed",
    gaps.length === 1 && gaps[0]!.days > 900 && gaps[0]!.days < 1200, JSON.stringify(gaps));
}

// 3. The current position is never optional.
{
  const why = refusal(() => assertChronologyIntact(HISTORY, withRoles([STAFF, CONTRACT, INTERIOR, OLDEST, ANCIENT])));
  check("dropping the most recent employment is refused",
    /most recent employment/.test(why) && /reads as unemployment/.test(why), why || "it was allowed");
}

// 4. Selection makes the call, and makes it the safe way: a zero-bullet
//    position that holds the timeline stays, one that does not comes off.
{
  // Something to say about the current job and about the 2016 one, and
  // nothing in between. Everything between them is then load-bearing.
  const roles = HISTORY.roles.map((r) =>
    r.title === "Operations Specialist" || r.title === "Student Assistant" ? r : { ...r, lines: [] });
  const sel = selectEmployment(HISTORY, roles);
  const shown = sel.roles.map((r) => r.title);

  check("a position between two shown positions is retained with no bullets",
    sel.roles.some((r) => r.title === "Media Technician" && r.lines.length === 0), JSON.stringify(shown));
  check("so is the overlapping contract inside that span",
    shown.includes("Contract Colorist"), JSON.stringify(shown));
  check("the position older than everything shown is omitted",
    !shown.includes("Equipment Attendant"), JSON.stringify(shown));
  check("and the omission carries its reason rather than happening silently",
    sel.omitted.some((o) => /Equipment Attendant/.test(o.role) && /opens no gap/.test(o.why)),
    JSON.stringify(sel.omitted));
  check("what was kept only for the timeline is reported as such",
    sel.chronologyOnly.some((c) => /Media Technician/.test(c)), JSON.stringify(sel.chronologyOnly));
  check("selection never produces something the invariant refuses",
    refusal(() => assertChronologyIntact(HISTORY, withRoles(sel.roles))) === "",
    refusal(() => assertChronologyIntact(HISTORY, withRoles(sel.roles))));
}

// The same thing through the real assembly path, ending at the page an
// employer would read.
{
  const accepted = [
    { original: "Built pricing models for vendor contracts", claim: "Built pricing models for vendor contracts",
      evidenceIds: ["e1"], generation: "SELECTED" },
    { original: "A summary sentence.", claim: "A summary sentence.", evidenceIds: ["s1"], generation: "SELECTED" },
  ];
  const { doc, dropped } = assembleTailoredDoc(HISTORY, accepted, ["pricing", "vendor", "contracts"]);
  const shown = doc.roles.map((r) => r.title);

  check("the current position is never a candidate for omission",
    shown.includes("Operations Specialist"), JSON.stringify(shown));
  check("the recent positions stay even with nothing to say for this posting",
    shown.length >= RECENT_POSITIONS_SHOWN && RECENT_POSITIONS_SHOWN === 3, JSON.stringify(shown));
  check("older irrelevant positions come off",
    !shown.includes("Equipment Attendant"), JSON.stringify(shown));
  check("and each omission is recorded with its reason",
    dropped.some((d) => /Equipment Attendant/.test(d.line) && /opens no gap/.test(d.why)),
    JSON.stringify(dropped.filter((d) => /Attendant|Assistant/.test(d.line))));

  const html = renderResumeHtml(doc);
  const bare = doc.roles.find((r) => r.lines.length === 0);
  check("a retained chronology entry prints its employer, title and dates",
    Boolean(bare) && html.includes(bare!.title) && html.includes(bare!.employer) && html.includes(bare!.start.slice(0, 4)),
    JSON.stringify(shown));
  check("and prints no bullet under it",
    !html.includes("Maintained studio broadcast equipment") && !html.includes("Produced video for national campaigns"), "");
}

// 5. Dates are taken from the evidence and never adjusted.
{
  const moved = withRoles([CURRENT, { ...STAFF, start: "2021-01-01" }, CONTRACT, INTERIOR, OLDEST]);
  check("a changed start date is refused",
    /does not match the recorded employment/.test(refusal(() => assertChronologyIntact(HISTORY, moved))),
    refusal(() => assertChronologyIntact(HISTORY, moved)) || "it was allowed");

  const stretched = withRoles([CURRENT, STAFF, CONTRACT, { ...INTERIOR, end: "2024-01-01" }, OLDEST]);
  check("an end date stretched to close a gap is refused",
    refusal(() => assertChronologyIntact(HISTORY, stretched)) !== "", "it was allowed");

  // Year precision means the month is not known. Printing one asserts
  // knowledge the evidence does not have.
  const monthed = withRoles([CURRENT, { ...STAFF, start: "2022-06-01", startPrecision: "MONTH" }, CONTRACT, INTERIOR, OLDEST]);
  const monthWhy = refusal(() => assertChronologyIntact(HISTORY, monthed));
  check("a month invented where only the year is verified is refused", monthWhy !== "", "it was allowed");
  check("and the refusal says date precision is not adjustable",
    /date precision/.test(monthWhy), monthWhy);

  // Precision alone, with the same date, is still a different claim.
  const upgraded = withRoles([CURRENT, { ...STAFF, startPrecision: "MONTH" }, CONTRACT, INTERIOR, OLDEST]);
  check("upgrading precision without changing the date is still refused",
    refusal(() => assertChronologyIntact(HISTORY, upgraded)) !== "", "it was allowed");
}

// 6. Separate stints stay separate.
{
  const mergedEmployer = withRoles([CURRENT, STAFF, CONTRACT,
    role("Lorain County CC", "Media Technician", "2016-01-01", "2022-01-01", ["Maintained studio broadcast equipment"])]);
  const why = refusal(() => assertChronologyIntact(HISTORY, mergedEmployer));
  check("two stints at one employer cannot be merged into a single run", why !== "", "it was allowed");
  check("and the refusal says the span covers separate recorded periods",
    /separate recorded periods/.test(why) && /no confirmed continuous-relationship record/.test(why), why);

  // The same manoeuvre, dressed as one long staff role covering a
  // concurrent contract.
  const mergedOverlap = withRoles([CURRENT,
    role("Holley Performance", "Videographer", "2022-01-01", "2024-01-01", ["Produced video for national campaigns"]),
    role("Sideline Media", "Contract Colorist", "2022-01-01", "2024-01-01", ["Graded footage for broadcast delivery"], "MONTH"),
    INTERIOR]);
  check("an overlapping contract cannot be stretched to match the staff role it ran inside",
    refusal(() => assertChronologyIntact(HISTORY, mergedOverlap)) !== "", "it was allowed");
}

// 7. Overlapping roles are represented as what they were: two jobs at
//    once, each with its own dates.
{
  const both = [CURRENT, STAFF, CONTRACT, INTERIOR];
  check("a contract running inside a staff role is kept alongside it, unaltered",
    refusal(() => assertChronologyIntact(HISTORY, withRoles(both))) === ""
    && both.filter((r) => r.employer === "Sideline Media")[0]!.start === "2022-06-01", "");
  // Dropping the covered contract leaves no gap, so relevance may decide
  // it. What it may not do is change the role that remains.
  check("omitting a fully covered contract opens no gap",
    misleadingGaps(HISTORY, [CURRENT, STAFF, INTERIOR]).length === 0,
    JSON.stringify(misleadingGaps(HISTORY, [CURRENT, STAFF, INTERIOR])));
  check("but the staff role it overlapped keeps its own dates",
    refusal(() => assertChronologyIntact(HISTORY, withRoles([CURRENT, STAFF, INTERIOR]))) === "", "");
}

// 8. Employment is never invented, and never listed twice.
{
  const invented = withRoles([...HISTORY.roles, role("Gap Filler LLC", "Consultant", "2017-01-01", "2019-01-01", ["z"])]);
  check("employment the evidence does not contain is refused",
    /evidence does not contain/.test(refusal(() => assertChronologyIntact(HISTORY, invented))),
    refusal(() => assertChronologyIntact(HISTORY, invented)) || "it was allowed");
  const twice = withRoles([...HISTORY.roles, STAFF]);
  check("the same position listed twice is refused",
    /listed twice/.test(refusal(() => assertChronologyIntact(HISTORY, twice))), "it was allowed");
}

// 9. The threshold is a stated number, not a mood.
{
  const shortGap = [
    role("A Co", "Analyst", "2024-01-01", null, ["x"]),
    role("B Co", "Analyst", "2022-01-01", "2023-11-15", ["y"]),
    role("C Co", "Analyst", "2023-11-15", "2024-01-01", []),
  ];
  const master = withRoles(shortGap);
  const withoutShort = shortGap.slice(0, 2);
  check("a sub-threshold uncovered stretch is not treated as a gap",
    misleadingGaps(master, withoutShort).length === 0
    && MATERIAL_GAP_DAYS === 92, `${MATERIAL_GAP_DAYS} days`);

  const longGap = [
    role("A Co", "Analyst", "2024-01-01", null, ["x"]),
    role("B Co", "Analyst", "2022-01-01", "2023-01-01", ["y"]),
    role("C Co", "Analyst", "2023-01-01", "2024-01-01", []),
  ];
  check("a year-long one is",
    misleadingGaps(withRoles(longGap), longGap.slice(0, 2)).length === 1, "");
}

// 10. Selection never produces a document the invariant would refuse.
{
  const noneRelevant = HISTORY.roles.map((r) => ({ ...r, lines: [] }));
  const sel = selectEmployment(HISTORY, noneRelevant);
  check("with nothing relevant anywhere, what remains is still a truthful timeline",
    refusal(() => assertChronologyIntact(HISTORY, withRoles(sel.roles))) === "",
    refusal(() => assertChronologyIntact(HISTORY, withRoles(sel.roles))));
  check("and the current position survives",
    sel.roles.some((r) => r.title === "Operations Specialist"), JSON.stringify(sel.roles.map((r) => r.title)));
  check("every retained entry is reported as chronology-only",
    sel.chronologyOnly.length === sel.roles.length, JSON.stringify(sel.chronologyOnly));
}

console.log(`${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
