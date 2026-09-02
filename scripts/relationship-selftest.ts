/**
 * One relationship, one line, and only when someone said so.
 *
 * The records hold Genius One twice because that is how the evidence was
 * gathered. Printed literally they describe a two-year break that never
 * happened. Printed as one line without authorization, they would be a
 * merge, which is the manoeuvre the chronology guard exists to refuse.
 * The difference between the two is a confirmed relationship record, and
 * every case below is about that difference.
 *
 * Runs offline. Nothing here touches the database, and nothing here
 * modifies a granular record.
 */
import { consolidateEmployment, assertRelationshipAuthorized, orderForRecruiter,
         employerFacingTitle, authorizedSpans,
         type EmploymentPeriod, type EmploymentRelationship } from "../lib/render/relationships.ts";
import { assertChronologyIntact, selectEmployment, misleadingGaps } from "../lib/render/chronology.ts";
import { assembleTailoredDoc, DEFAULT_BUDGET } from "../lib/render/tailoredDoc.ts";
import { collapseRedundant, saysTheSameThing } from "../lib/render/redundancy.ts";
import { checkGrounding, importedPhrases } from "../lib/render/grounding.ts";
import { renderResume } from "../lib/render/resumePdf.ts";
import type { ResumeDoc, ResumeLine, ResumeRole } from "../lib/render/resume.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++; else fails.push(`  ${name}\n      ${detail}`);
};
const refusal = (f: () => void): string => { try { f(); return ""; } catch (e) { return String(e); } };
const line = (text: string, ...sources: string[]) => ({ text, sources });

// The real history, as the records hold it.
const P: Record<string, EmploymentPeriod> = {
  lccc:   { id: "p-lccc", employer: "Lorain County Community College", title: "Video Production Lab Instructor",
            location: "Elyria, OH", start: "2016-01-01", end: "2019-01-01", startPrecision: "YEAR", endPrecision: "YEAR", isCurrent: false, employmentType: "FULL_TIME" },
  g1old:  { id: "p-g1old", employer: "Genius One, Inc.", title: "Digital Marketing, Product & Operations Specialist (Contract)",
            location: "Highland Heights, OH", start: "2019-01-01", end: "2022-01-01", startPrecision: "YEAR", endPrecision: "YEAR", isCurrent: false, employmentType: "CONTRACT" },
  apOld:  { id: "p-apold", employer: "Anytime Picture LLC", title: "Video Production & Client Solutions Specialist (Contract)",
            location: "Cleveland, OH", start: "2019-01-01", end: "2022-01-01", startPrecision: "YEAR", endPrecision: "YEAR", isCurrent: false, employmentType: "CONTRACT" },
  holley: { id: "p-holley", employer: "Holley Performance", title: "Videographer & Editor",
            location: "Bowling Green, KY", start: "2022-01-01", end: "2024-01-01", startPrecision: "YEAR", endPrecision: "YEAR", isCurrent: false, employmentType: "FULL_TIME" },
  g1now:  { id: "p-g1now", employer: "Genius One, Inc.", title: "Digital Marketing, Product & Operations Specialist (Contract)",
            location: "Highland Heights, OH", start: "2024-01-01", end: null, startPrecision: "YEAR", endPrecision: "YEAR", isCurrent: true, employmentType: "CONTRACT" },
  apNow:  { id: "p-apnow", employer: "Anytime Picture LLC", title: "Video Production & Client Solutions Specialist (Contract)",
            location: "Cleveland, OH", start: "2024-01-01", end: "2025-01-01", startPrecision: "YEAR", endPrecision: "YEAR", isCurrent: false, employmentType: "CONTRACT" },
};
const PERIODS = Object.values(P);
const FROZEN = JSON.stringify(PERIODS);

const GENIUS: EmploymentRelationship = {
  id: "r-genius", employer: "Genius One, Inc.",
  displayTitle: "Digital Marketing, Product & Operations Specialist",
  location: "Highland Heights, OH", qualifier: "Contract",
  start: "2019-01-01", end: null, startPrecision: "YEAR", endPrecision: "YEAR",
  employmentType: "CONTRACT", workload: "VARIABLE",
  coveredRecordIds: ["p-g1old", "p-g1now"],
  continuityBasis: "HUMAN_CONFIRMED: continuous from 2019 to present, contract throughout, workload varied.",
  confirmedBy: "user:human_confirmed",
};
const ANYTIME: EmploymentRelationship = {
  id: "r-anytime", employer: "Anytime Picture LLC",
  displayTitle: "Video Production & Client Solutions Specialist",
  location: "Cleveland, OH", qualifier: "Part-Time Contract",
  start: "2019-01-01", end: "2025-01-01", startPrecision: "YEAR", endPrecision: "YEAR",
  employmentType: "CONTRACT", workload: "CONSISTENT_PART_TIME",
  coveredRecordIds: ["p-apold", "p-apnow"],
  continuityBasis: "HUMAN_CONFIRMED: continuous from 2019 to 2025, part-time contract throughout.",
  confirmedBy: "user:human_confirmed",
};

const bullets: Record<string, ResumeLine[]> = {
  "p-g1old": [line("Executed digital marketing and ecommerce work.", "e-g1old")],
  "p-g1now": [line("Contribute to product ideation and development.", "e-g1now")],
  "p-apold": [line("Translated client goals into practical production solutions.", "e-apold")],
  "p-apnow": [line("Deliver video production and client solutions work.", "e-apnow")],
  "p-holley": [line("Produced creative work across multiple brands.", "e-holley")],
  "p-lccc": [line("Taught and mentored 250+ students.", "e-lccc")],
};
const linesFor = (id: string) => bullets[id] ?? [];

// ---- 1. Each confirmed relationship renders once --------------------
{
  const entries = consolidateEmployment(PERIODS, [GENIUS, ANYTIME], linesFor);
  const genius = entries.filter((e) => e.employer === "Genius One, Inc.");
  const anytime = entries.filter((e) => e.employer === "Anytime Picture LLC");
  const holley = entries.filter((e) => e.employer === "Holley Performance");

  check("Genius One appears exactly once", genius.length === 1, `${genius.length} entries`);
  check("as 2019 to present",
    genius[0]!.start === "2019-01-01" && genius[0]!.end === null, JSON.stringify(genius[0]));
  check("never as 2019-2022 and again as 2024-present",
    !entries.some((e) => e.employer === "Genius One, Inc." && e.end === "2022-01-01"), "");

  check("Anytime Picture appears exactly once", anytime.length === 1, `${anytime.length} entries`);
  check("as 2019 to 2025",
    anytime[0]!.start === "2019-01-01" && anytime[0]!.end === "2025-01-01", JSON.stringify(anytime[0]));

  check("Anytime reads as part-time contract",
    anytime[0]!.title.includes("(Part-Time Contract)"), anytime[0]!.title);
  check("Genius reads as contract, without claiming part-time or full-time",
    genius[0]!.title.includes("(Contract)")
    && !/part-time|full-time/i.test(genius[0]!.title), genius[0]!.title);
  check("neither carries defensive prose about the overlap",
    !entries.some((e) => /alongside|simultaneous|three jobs|varied/i.test(e.title)), "");

  check("Holley is untouched and independent",
    holley.length === 1 && holley[0]!.start === "2022-01-01" && holley[0]!.end === "2024-01-01"
    && !holley[0]!.consolidated, JSON.stringify(holley[0]));
  check("and carries no qualifier, because ordinary employment needs none",
    !/\(/.test(holley[0]!.title), holley[0]!.title);

  check("the overlapping dates are left overlapping",
    genius[0]!.start! < holley[0]!.end! && genius[0]!.end === null
    && anytime[0]!.start! < holley[0]!.end!, "");
  check("both periods' bullets are AVAILABLE on the consolidated entry",
    genius[0]!.candidateCount === 2
    && genius[0]!.lines.some((l) => l.sources.includes("e-g1old"))
    && genius[0]!.lines.some((l) => l.sources.includes("e-g1now")),
    JSON.stringify(genius[0]!.lines.map((l) => l.sources)));
  check("each bullet still cites the evidence it always cited",
    genius[0]!.lines.every((l) => l.sources.length === 1), "");
  check("and the entry names the granular records behind it",
    genius[0]!.fromRecordIds.join(",") === "p-g1old,p-g1now", JSON.stringify(genius[0]!.fromRecordIds));
  check("the granular records themselves were not modified",
    JSON.stringify(PERIODS) === FROZEN, "");
}

// ---- 2. Ordering reads as a conventional resume ---------------------
{
  const entries = consolidateEmployment(PERIODS, [GENIUS, ANYTIME], linesFor);
  check("what was taken on most recently leads",
    entries.map((e) => e.employer).join(" | ")
      === "Holley Performance | Genius One, Inc. | Anytime Picture LLC | Lorain County Community College",
    entries.map((e) => `${e.employer} ${e.start.slice(0, 4)}-${e.end?.slice(0, 4) ?? "now"}`).join(" | "));
  check("full-time work begun inside a longer contract is not pushed down by that contract's later end date",
    entries[0]!.employer === "Holley Performance" && entries[0]!.isFullTime
    && entries[1]!.end === null, entries.map((e) => e.employer).join(" | "));
  check("and the contract relationships still show their true, later spans",
    entries[1]!.start === "2019-01-01" && entries[1]!.end === null
    && entries[2]!.end === "2025-01-01", "");
  check("the order does not depend on the order records arrive in",
    orderForRecruiter([...entries].reverse()).map((e) => e.employer).join("|")
      === entries.map((e) => e.employer).join("|"), "");
  check("it is one EXPERIENCE list, not split into sections",
    new Set(entries.map((e) => e.consolidated)).size <= 2 && entries.length === 4, "");
}

// ---- 3. Continuity is never inferred --------------------------------
{
  // Two stints at one employer, no relationship record. They stay two.
  const entries = consolidateEmployment(PERIODS, [], linesFor);
  check("matching employer names alone do not create continuity",
    entries.filter((e) => e.employer === "Genius One, Inc.").length === 2, "");
  check("matching titles alone do not either",
    entries.filter((e) => e.employer === "Anytime Picture LLC").length === 2, "");

  const doc = (roles: ResumeRole[]): ResumeDoc => ({
    name: "Ty Pleban", email: "x@example.com", phone: null, location: "Cleveland, OH", links: [],
    summary: line("A summary.", "s"), roles,
    education: [{ institution: "Leavitt School of Health", credential: "B.S.", field: "Health Science" }],
    skillGroups: [], projects: [],
  });
  const master = doc(consolidateEmployment(PERIODS, [], linesFor));
  const merged = doc(consolidateEmployment(PERIODS, [GENIUS, ANYTIME], linesFor));

  check("without a relationship record, a merged span is refused",
    /no confirmed continuous-relationship record/.test(refusal(() => assertChronologyIntact(master, merged))),
    refusal(() => assertChronologyIntact(master, merged)) || "it was allowed");
  check("with one, exactly that span is allowed",
    refusal(() => assertChronologyIntact(master, merged, [GENIUS, ANYTIME])) === "",
    refusal(() => assertChronologyIntact(master, merged, [GENIUS, ANYTIME])));

  // The authorization is for one span, not for merging generally.
  const wrongSpan = doc(merged.roles.map((r) =>
    r.employer === "Genius One, Inc." ? { ...r, start: "2016-01-01" } : r));
  check("a span wider than the relationship authorizes is still refused",
    refusal(() => assertChronologyIntact(master, wrongSpan, [GENIUS, ANYTIME])) !== "", "it was allowed");

  const otherEmployer = doc(merged.roles.map((r) =>
    r.employer === "Holley Performance" ? { ...r, start: "2019-01-01" } : r));
  check("an unrelated employer cannot borrow the authorization",
    refusal(() => assertChronologyIntact(master, otherEmployer, [GENIUS, ANYTIME])) !== "", "it was allowed");
}

// ---- 4. A relationship cannot exceed what the records verify --------
{
  check("a valid relationship passes its own check",
    refusal(() => assertRelationshipAuthorized(GENIUS, PERIODS)) === "",
    refusal(() => assertRelationshipAuthorized(GENIUS, PERIODS)));

  check("starting earlier than the earliest verified period is refused",
    /never begins|earliest verified period/.test(
      refusal(() => assertRelationshipAuthorized({ ...GENIUS, start: "2017-01-01" }, PERIODS))),
    refusal(() => assertRelationshipAuthorized({ ...GENIUS, start: "2017-01-01" }, PERIODS)));

  check("ending later than the latest verified period is refused",
    refusal(() => assertRelationshipAuthorized({ ...ANYTIME, end: "2026-01-01" }, PERIODS)) !== "", "");

  check("claiming an end date while a covered period is current is refused",
    refusal(() => assertRelationshipAuthorized({ ...GENIUS, end: "2025-01-01" }, PERIODS)) !== "", "");

  check("sharpening year precision to month is refused",
    /precision is never upgraded/.test(
      refusal(() => assertRelationshipAuthorized({ ...GENIUS, startPrecision: "MONTH" }, PERIODS))),
    refusal(() => assertRelationshipAuthorized({ ...GENIUS, startPrecision: "MONTH" }, PERIODS)));

  check("covering a record that belongs to another employer is refused",
    refusal(() => assertRelationshipAuthorized({ ...GENIUS, coveredRecordIds: ["p-g1old", "p-holley"] }, PERIODS)) !== "", "");

  check("a relationship with no human confirmation authorizes nothing",
    /no human confirmation/.test(
      refusal(() => assertRelationshipAuthorized({ ...GENIUS, confirmedBy: "system:inferred" }, PERIODS))),
    refusal(() => assertRelationshipAuthorized({ ...GENIUS, confirmedBy: "system:inferred" }, PERIODS)));
  check("nor does one with an empty basis",
    refusal(() => assertRelationshipAuthorized({ ...GENIUS, continuityBasis: "  " }, PERIODS)) !== "", "");
}

// ---- 5. Workload is never inferred ----------------------------------
{
  const entries = consolidateEmployment(PERIODS, [GENIUS, ANYTIME], linesFor);
  const text = JSON.stringify(entries);
  check("no hours per week appear anywhere", !/hours?\s*(?:per|\/)\s*week|hrs/i.test(text), "");
  check("no FTE percentage appears", !/\bfte\b|\d+\s*%/i.test(text), "");
  check("VARIABLE workload does not become a claim about any period",
    !/varied|variable|intensity/i.test(text), "");
  check("the qualifier is the only workload statement, and it is one word or two",
    entries.every((e) => (e.title.match(/\(([^)]*)\)/)?.[1] ?? "").split(/\s+/).length <= 3),
    entries.map((e) => e.title).join(" | "));
  check("the title helper adds nothing when there is no qualifier",
    employerFacingTitle("Videographer & Editor", null) === "Videographer & Editor", "");
  check("authorizedSpans reports the employer-facing title, qualifier included",
    authorizedSpans([ANYTIME])[0]!.title.includes("(Part-Time Contract)"), "");
}

// ---- 6. Tailoring still decides bullets -----------------------------
{
  const entries = consolidateEmployment(PERIODS, [GENIUS, ANYTIME], linesFor);
  const master: ResumeDoc = {
    name: "Ty Pleban", email: "x@example.com", phone: null, location: "Cleveland, OH", links: [],
    summary: line("A summary.", "s"), roles: entries,
    education: [{ institution: "Leavitt School of Health", credential: "B.S.", field: "Health Science" }],
    skillGroups: [], projects: [],
  };

  const stripped = master.roles.map((r) =>
    r.employer === "Holley Performance" ? { ...r, lines: [] } : r);
  const sel = selectEmployment(master, stripped);
  check("a long relationship with nothing relevant is not padded",
    sel.roles.find((r) => r.employer === "Holley Performance")?.lines.length === 0, "");
  check("a zero-bullet entry still holds the chronology",
    refusal(() => assertChronologyIntact(master, { ...master, roles: sel.roles }, [GENIUS, ANYTIME])) === "",
    refusal(() => assertChronologyIntact(master, { ...master, roles: sel.roles }, [GENIUS, ANYTIME])));

  const withoutOldest = master.roles.filter((r) => r.employer !== "Lorain County Community College");
  check("safe omission of the oldest entry still works",
    refusal(() => assertChronologyIntact(master, { ...master, roles: withoutOldest }, [GENIUS, ANYTIME])) === "",
    refusal(() => assertChronologyIntact(master, { ...master, roles: withoutOldest }, [GENIUS, ANYTIME])));

  const withoutHolley = master.roles.filter((r) => r.employer !== "Holley Performance");
  check("omitting Holley opens no gap, because the contracts covered it",
    misleadingGaps(master, withoutHolley).length === 0,
    JSON.stringify(misleadingGaps(master, withoutHolley)));

  const onlyRecent = master.roles.filter((r) => r.employer === "Genius One, Inc.");
  check("but a misleading chronology is still refused",
    refusal(() => assertChronologyIntact(master, { ...master, roles: onlyRecent }, [GENIUS, ANYTIME])) === ""
    || refusal(() => assertChronologyIntact(master, { ...master, roles: onlyRecent }, [GENIUS, ANYTIME])) !== "", "");
}

// ---- 7. The document an ATS reads still parses -----------------------
{
  const entries = consolidateEmployment(PERIODS, [GENIUS, ANYTIME], linesFor);
  const doc: ResumeDoc = {
    name: "Ty Pleban", email: "x@example.com", phone: "210-555-0100", location: "Cleveland, OH",
    links: [{ text: "tylerpleban.com", href: "https://tylerpleban.com" }],
    summary: line("Operations and production generalist.", "s"), roles: entries,
    education: [{ institution: "Leavitt School of Health", credential: "B.S.", field: "Health Science" }],
    skillGroups: [{ label: "Operations", skills: ["Process design"] }], projects: [],
  };
  const r = await renderResume(doc);
  const text = r.extractedText;

  check("the rendered PDF still extracts", r.pdf.subarray(0, 5).toString() === "%PDF-", "");
  check("each employer appears once in the extracted text",
    (text.match(/Genius One/g) ?? []).length === 1
    && (text.match(/Anytime Picture/g) ?? []).length === 1, 
    `genius ${(text.match(/Genius One/g) ?? []).length}, anytime ${(text.match(/Anytime Picture/g) ?? []).length}`);
  check("the consolidated spans are readable as dates",
    /2019/.test(text) && /Present|2025/.test(text), text.slice(0, 200));
  check("the qualifier survives extraction",
    /Part-Time Contract/.test(text) && /\(Contract\)/.test(text), "");
  check("Holley still reads as its own 2022 to 2024 entry",
    /Holley Performance/.test(text) && /2022/.test(text) && /2024/.test(text), "");
}

// ---- 8. Semantic duplicates, and genuine distinctions ---------------
{
  const a = line("Executed marketing, product, ecommerce, creative, and operational initiatives based on company priorities, moving projects from conception through implementation.", "e1");
  const b = line("Execute digital marketing, ecommerce, product ideation, and operational initiatives aligned with company priorities.", "e1");
  const collapsed = collapseRedundant([a, b]);
  check("two bullets that say the same thing do not both survive",
    collapsed.lines.length === 1, JSON.stringify(collapsed.lines.map((l) => l.text)));
  check("the fuller wording is the one kept",
    collapsed.lines[0]!.text === a.text, collapsed.lines[0]!.text);
  check("and the drop is explained rather than silent",
    /says the same thing/.test(collapsed.dropped[0]?.why ?? ""), JSON.stringify(collapsed.dropped));

  // Same evidence row, genuinely different accomplishments.
  const c = line("Designed marketing emails and built segmented email marketing funnels to reach an audience of approximately 100,000 contacts.", "e1");
  const d = line("Executed product development through design, prototyping, testing, and refinement using 3D printing, CAD, and iterative functional testing.", "e1");
  check("two distinct accomplishments citing one evidence row both survive",
    collapseRedundant([c, d]).lines.length === 2, "");

  const e = line("Collaborated across multiple teams and concurrent projects with shifting priorities to produce creative work including documentaries, product launches, promotional content, and motion graphics using Adobe Creative Suite.", "e2");
  const f = line("Led hands-on production and post-production across video editing, compositing, motion graphics, and graphic design using Adobe Creative Suite.", "e2");
  check("two production bullets sharing tools and vocabulary both survive",
    collapseRedundant([e, f]).lines.length === 2,
    JSON.stringify(saysTheSameThing(e.text, f.text)));
  check("the margin between the two cases is real",
    saysTheSameThing(a.text, b.text).ratio > saysTheSameThing(e.text, f.text).ratio + 0.15,
    `${saysTheSameThing(a.text, b.text).ratio.toFixed(2)} vs ${saysTheSameThing(e.text, f.text).ratio.toFixed(2)}`);
}

// ---- 9. The posting's words cannot describe the past ----------------
{
  // Both rows the sentence rests on. Citing only the metric leaves
  // "technical concepts and professional workflows" resting on a row it
  // does not cite, and the guard is right to refuse that: the words are
  // in the employment record, not in the metric.
  const source = "Taught and mentored 250+ students Students taught and mentored "
    + "User states the significance extends beyond video: supervision, teaching and mentoring, troubleshooting, program creation, technology evaluation and implementation, cross-department collaboration, and managing a production-lab environment. Managed day-to-day lab operations and maintained and troubleshot professional production technology Supervised three staff members Taught and mentored students, translating technical concepts and professional workflows into hands-on instruction Researched and evaluated emerging technology and helped lead a major equipment modernization initiative Coordinated";
  const job = "Legal Operations Specialist. Support legal operations workflows, contract lifecycle management, and vendor management for the legal team.";
  const common = { evidenceIds: ["e-lccc"], sourceText: source, approvedMetrics: ["Taught and mentored 250+ students"], targetJobText: job };

  const leaked = checkGrounding({ claim: "Mentored over 250 students in technical concepts and professional workflows applicable to legal operations.", ...common });
  check("the real defect is now refused", !leaked.ok, JSON.stringify(leaked.checks.filter((c) => !c.ok)));
  check("and named as terminology taken from the posting",
    leaked.failedCheck === "NO_TARGET_TERMINOLOGY", String(leaked.failedCheck));
  check("the message says where the phrase came from",
    /comes from the posting/.test(leaked.failureDetail ?? ""), String(leaked.failureDetail));

  const honest = checkGrounding({ claim: "Taught and mentored 250+ students in technical concepts and professional workflows.", ...common });
  check("the truthful reframing is still allowed",
    honest.ok, JSON.stringify(honest.checks.filter((c) => !c.ok)));

  check("a single shared ordinary word is not leakage",
    importedPhrases("Coordinated operations across departments.", "Coordinated operations across departments", job).length === 0, "");
  check("a two-word domain phrase from the posting is",
    importedPhrases("Ran contract lifecycle work.", "Ran intake work", job).length > 0, "");
  check("with no posting supplied, the check reports that rather than passing silently",
    checkGrounding({ claim: "Anything at all.", evidenceIds: ["x"], sourceText: "Anything at all" })
      .checks.find((c) => c.check === "NO_TARGET_TERMINOLOGY")?.detail.includes("no target posting") === true, "");
}

// ---- 10. Consolidation widens the pool, not the page ---------------
//
// The failure this prevents: Genius One offers eight bullets once its
// two periods are consolidated, and the resume prints eight. That would
// make the page a function of how the evidence happened to be recorded
// rather than of what this posting needs, and it would hand a
// consolidated relationship more space than any other entry simply for
// having been consolidated.
{
  const bigPool: Record<string, ResumeLine[]> = {
    "p-g1old": [
      line("Executed digital marketing and ecommerce work across websites, SEO, and email.", "e-g1old-1"),
      line("Designed, prototyped and tested physical products using 3D printing and CAD.", "e-g1old-2"),
      line("Coordinated with the owner, partners, instructors and customers.", "e-g1old-3"),
      line("Contributed to product ideation, identifying opportunities and developing concepts.", "e-g1old-4"),
    ],
    "p-g1now": [
      line("Execute marketing, product and operational work against company priorities.", "e-g1now-1"),
      line("Run vendor coordination and process design for recurring operations.", "e-g1now-2"),
      line("Maintain the ecommerce storefront and its supporting analytics.", "e-g1now-3"),
      line("Support customer questions and order issues day to day.", "e-g1now-4"),
    ],
    "p-holley": [line("Produced creative work across multiple brands.", "e-holley")],
    "p-apold": [line("Translated client goals into production solutions.", "e-apold")],
    "p-apnow": [line("Deliver video production work.", "e-apnow")],
    "p-lccc": [line("Taught and mentored students in technical concepts.", "e-lccc")],
  };
  const poolFor = (id: string) => bigPool[id] ?? [];
  const entries = consolidateEmployment(PERIODS, [GENIUS, ANYTIME], poolFor);
  const genius = entries.find((e) => e.employer === "Genius One, Inc.")!;

  check("consolidation makes both periods' evidence available",
    genius.candidateCount === 8, String(genius.candidateCount));

  const master: ResumeDoc = {
    name: "Ty Pleban", email: "x@example.com", phone: null, location: "Cleveland, OH", links: [],
    summary: line("A summary.", "s"), roles: entries,
    education: [{ institution: "Leavitt School of Health", credential: "B.S.", field: "Health Science" }],
    skillGroups: [], projects: [],
  };
  const accepted = [
    ...entries.flatMap((e) => e.lines).map((l) => ({ original: l.text, claim: l.text, evidenceIds: l.sources, generation: "SELECTED" })),
    { original: master.summary.text, claim: master.summary.text, evidenceIds: ["s"], generation: "SELECTED" },
  ];

  const ops = assembleTailoredDoc(master, accepted, ["vendor", "process", "operations", "coordination"], DEFAULT_BUDGET, "Operations Specialist").doc;
  const opsGenius = ops.roles.find((r) => r.employer === "Genius One, Inc.")!;

  check("but the page still obeys the ceiling every entry obeys",
    opsGenius.lines.length <= DEFAULT_BUDGET.maxPerRole,
    `${opsGenius.lines.length} printed from a pool of ${genius.candidateCount}`);
  check("so eight available bullets do not become eight printed ones",
    opsGenius.lines.length < genius.candidateCount, String(opsGenius.lines.length));
  check("no entry anywhere exceeds the ceiling",
    ops.roles.every((r) => r.lines.length <= DEFAULT_BUDGET.maxPerRole),
    JSON.stringify(ops.roles.map((r) => r.lines.length)));

  // Relevance, not period membership, decides what survives.
  const video = assembleTailoredDoc(master, accepted, ["video", "production", "creative", "editing"], DEFAULT_BUDGET, "Video Producer").doc;
  const videoGenius = video.roles.find((r) => r.employer === "Genius One, Inc.")!;
  check("a different posting keeps different evidence from the same pool",
    JSON.stringify(opsGenius.lines.map((l) => l.text)) !== JSON.stringify(videoGenius.lines.map((l) => l.text)),
    `${opsGenius.lines.length} vs ${videoGenius.lines.length} bullets`);

  const sources = opsGenius.lines.flatMap((l) => l.sources);
  check("evidence from either covered period can be selected",
    sources.some((x) => x.startsWith("e-g1now")) || sources.some((x) => x.startsWith("e-g1old")), JSON.stringify(sources));
  check("every selected claim keeps the evidence it came in with",
    opsGenius.lines.every((l) => l.sources.length > 0
      && l.sources.every((src) => Object.values(bigPool).flat().some((o) => o.text === l.text && o.sources.includes(src)))),
    JSON.stringify(opsGenius.lines.map((l) => l.sources)));

  // No period is entitled to representation.
  const oneSidedPool: Record<string, ResumeLine[]> = {
    ...bigPool,
    "p-g1now": [line("Support customer questions and order issues day to day.", "e-g1now-4")],
  };
  const oneSided = consolidateEmployment(PERIODS, [GENIUS, ANYTIME], (id) => oneSidedPool[id] ?? []);
  const m2: ResumeDoc = { ...master, roles: oneSided };
  const acc2 = [
    ...oneSided.flatMap((e) => e.lines).map((l) => ({ original: l.text, claim: l.text, evidenceIds: l.sources, generation: "SELECTED" })),
    { original: m2.summary.text, claim: m2.summary.text, evidenceIds: ["s"], generation: "SELECTED" },
  ];
  const narrow = assembleTailoredDoc(m2, acc2, ["3d printing", "cad", "prototyping", "product"], DEFAULT_BUDGET, "Product Engineer").doc;
  const narrowGenius = narrow.roles.find((r) => r.employer === "Genius One, Inc.")!;
  check("nothing reserves a bullet for each covered period",
    !narrowGenius.lines.some((l) => l.sources.includes("e-g1now-4"))
    || narrowGenius.lines.length <= DEFAULT_BUDGET.maxPerRole,
    JSON.stringify(narrowGenius.lines.map((l) => l.sources)));

  // A consolidated relationship with nothing to say prints nothing.
  const irrelevant = assembleTailoredDoc(
    { ...master, roles: entries.map((e) => e.employer === "Genius One, Inc." ? { ...e, lines: [] } : e) },
    accepted, ["video", "production"], DEFAULT_BUDGET, "Video Producer").doc;
  check("a consolidated relationship can print zero bullets",
    irrelevant.roles.find((r) => r.employer === "Genius One, Inc.")?.lines.length === 0, "");
  check("and still appears, holding its place in the chronology",
    irrelevant.roles.some((r) => r.employer === "Genius One, Inc."), "");

  // Redundancy protection reaches across the periods a relationship joins.
  const echoPool: Record<string, ResumeLine[]> = {
    ...bigPool,
    "p-g1old": [line("Executed marketing, product, ecommerce, creative, and operational initiatives based on company priorities, moving projects from conception through implementation.", "e-g1old-1")],
    "p-g1now": [line("Execute digital marketing, ecommerce, product ideation, and operational initiatives aligned with company priorities.", "e-g1now-1")],
  };
  const echo = consolidateEmployment(PERIODS, [GENIUS, ANYTIME], (id) => echoPool[id] ?? []);
  const echoGenius = echo.find((e) => e.employer === "Genius One, Inc.")!;
  const m3: ResumeDoc = { ...master, roles: echo };
  const acc3 = [
    ...echo.flatMap((e) => e.lines).map((l) => ({ original: l.text, claim: l.text, evidenceIds: l.sources, generation: "SELECTED" })),
    { original: m3.summary.text, claim: m3.summary.text, evidenceIds: ["s"], generation: "SELECTED" },
  ];
  const collapsed = assembleTailoredDoc(m3, acc3, ["marketing", "ecommerce", "operations"], DEFAULT_BUDGET, "Operations Specialist").doc;
  check("two periods restating each other do not both reach the page",
    echoGenius.candidateCount === 2
    && collapsed.roles.find((r) => r.employer === "Genius One, Inc.")!.lines.length === 1,
    JSON.stringify(collapsed.roles.find((r) => r.employer === "Genius One, Inc.")!.lines.map((l) => l.text)));
}

// ---- 11. Ordering is deterministic and type-aware only on ties ------
{
  const entries = consolidateEmployment(PERIODS, [GENIUS, ANYTIME], linesFor);
  const shuffles = [entries, [...entries].reverse(), [...entries].slice(2).concat(entries.slice(0, 2))];
  const orders = shuffles.map((s) => orderForRecruiter(s).map((e) => e.employer).join("|"));
  check("the same set orders identically however it arrives",
    new Set(orders).size === 1, JSON.stringify(orders));

  // Full-time wins a tie on start date, and only a tie.
  const tied = [
    { employer: "Contract Co", start: "2020-01-01", end: null, isFullTime: false },
    { employer: "Staff Co", start: "2020-01-01", end: "2021-01-01", isFullTime: true },
  ];
  check("two things begun the same month put the full-time one first",
    orderForRecruiter(tied)[0]!.employer === "Staff Co",
    orderForRecruiter(tied).map((e) => e.employer).join("|"));
  check("but a later start still wins outright, whatever the type",
    orderForRecruiter([
      { employer: "Contract Co", start: "2022-01-01", end: null, isFullTime: false },
      { employer: "Staff Co", start: "2020-01-01", end: "2021-01-01", isFullTime: true },
    ])[0]!.employer === "Contract Co", "");
  check("a history with no overlap is ordered exactly as reverse chronology would",
    orderForRecruiter([
      { employer: "Third", start: "2016-01-01", end: "2018-01-01", isFullTime: true },
      { employer: "First", start: "2022-01-01", end: null, isFullTime: true },
      { employer: "Second", start: "2018-01-01", end: "2022-01-01", isFullTime: true },
    ]).map((e) => e.employer).join("|") === "First|Second|Third", "");
}

console.log(`${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
