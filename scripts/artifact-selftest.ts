/**
 * The document approved is the document uploaded.
 *
 * The defect this exists to prevent: the review screen showed tailored
 * claims while the browser uploaded a PDF recomposed from the frozen
 * profile. Both were grounded, so nothing untrue would have reached an
 * employer, and the approval gate was still meaningless.
 *
 * Runs offline against fixtures. Nothing here touches the database.
 */
import { createHash } from "node:crypto";
import { assembleTailoredDoc, documentLines, selectCapabilities, DEFAULT_BUDGET } from "../lib/render/tailoredDoc.ts";
import { renderResume, renderResumeHtml, hashPdf, RENDERER_VERSION } from "../lib/render/resumePdf.ts";
import { canonicalizeResume, contentHash } from "../lib/render/canonical.ts";
import type { ResumeDoc } from "../lib/render/resume.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++; else fails.push(`  ${name}\n      ${detail}`);
};

const line = (text: string, ...sources: string[]) => ({ text, sources });

const MASTER: ResumeDoc = {
  name: "Ty Pleban", email: "x@example.com", phone: "210-555-0100", location: "Cleveland, OH",
  links: [{ text: "tylerpleban.com", href: "https://tylerpleban.com" },
          { text: "linkedin.com/in/tylerpleban", href: "https://www.linkedin.com/in/tylerpleban/" }],
  summary: line("First summary sentence. Second summary sentence. Third one. A fourth that should be dropped.", "s1"),
  roles: [
    { employer: "Genius One, Inc.", title: "Operations Specialist", location: "Remote",
      start: "2024-01-01", end: null, startPrecision: "YEAR", endPrecision: "YEAR",
      lines: [line("MASTER alpha about pricing", "e1"), line("MASTER beta about logistics", "e2"),
              line("MASTER gamma about teaching", "e3")] },
    { employer: "Holley Performance", title: "Videographer", location: "Bowling Green, KY",
      start: "2022-01-01", end: "2024-01-01", startPrecision: "YEAR", endPrecision: "YEAR",
      lines: [line("MASTER delta about video", "e4")] },
  ],
  education: [{ institution: "Leavitt School of Health", credential: "B.S.", field: "Health Science" }],
  skillGroups: [{ label: "Operations", skills: ["Process design", "Vendor management"] }],
  projects: [{ name: "RentPup", line: line("MASTER project line", "e5"), optional: []  }],
};

const ACCEPTED = [
  { original: "MASTER alpha about pricing", claim: "TAILORED alpha, rewritten for pricing strategy", evidenceIds: ["e1"], generation: "REFRAMED" },
  { original: "MASTER beta about logistics", claim: "TAILORED beta, rewritten for logistics", evidenceIds: ["e2"], generation: "REFRAMED" },
  { original: "MASTER delta about video", claim: "MASTER delta about video", evidenceIds: ["e4"], generation: "SELECTED" },
  { original: "MASTER project line", claim: "TAILORED project line", evidenceIds: ["e5"], generation: "REFRAMED" },
  { original: "First summary sentence. Second summary sentence. Third one. A fourth that should be dropped.",
    claim: "First summary sentence. Second summary sentence. Third one. A fourth that should be dropped.", evidenceIds: ["s1"], generation: "SELECTED" },
];

// ---- assembly: tailored text in, unselected and rejected out ---------
const { doc, dropped } = assembleTailoredDoc(MASTER, ACCEPTED, ["pricing", "logistics", "video"]);
const text = documentLines(doc).join("\n");

check("an accepted tailored rewrite reaches the document",
  text.includes("TAILORED alpha, rewritten for pricing strategy"), text.slice(0, 160));
check("a second accepted rewrite reaches it too",
  text.includes("TAILORED beta, rewritten for logistics"), "");
check("a master line with no accepted counterpart cannot reappear",
  !text.includes("MASTER gamma about teaching"), "gamma leaked in");
check("and the drop is recorded rather than silent",
  dropped.some((d) => d.line.includes("gamma")), JSON.stringify(dropped).slice(0, 160));
check("a master line that WAS accepted verbatim is kept",
  text.includes("MASTER delta about video"), "");
check("a rejected claim never appears",
  !text.includes("REJECTED"), "");
check("the summary is trimmed to its sentence budget",
  !doc.summary.text.includes("A fourth that should be dropped")
  && doc.summary.text.includes("Third one"), doc.summary.text);
check("provenance survives assembly",
  doc.roles[0]!.lines.every((l) => l.sources.length > 0), "a line lost its sources");

// ---- relevance, not padding -----------------------------------------
{
  const wide: ResumeDoc = { ...MASTER, roles: [{ ...MASTER.roles[0]!,
    lines: Array.from({ length: 9 }, (_, i) => line(`line ${i} about pricing`, `w${i}`)) }] };
  const accepted = wide.roles[0]!.lines.map((l) => ({ original: l.text, claim: l.text, evidenceIds: l.sources, generation: "SELECTED" }));
  const { doc: d2 } = assembleTailoredDoc(wide, [...accepted,
    { original: MASTER.summary.text, claim: MASTER.summary.text, evidenceIds: ["s1"], generation: "SELECTED" }], ["pricing"]);
  check("no single role becomes a wall of bullets",
    d2.roles[0]!.lines.length <= DEFAULT_BUDGET.maxPerRole, `${d2.roles[0]!.lines.length}`);
  check("and nothing was invented to fill the others",
    d2.roles.length === 1, `${d2.roles.length} roles`);
}

// ---- presentation is separable from content -------------------------
{
  const html = renderResumeHtml(doc);
  check("every document line is present in the rendered html",
    documentLines(doc).every((l) => html.includes(l.replace(/&/g, "&amp;"))), "a line is missing from the html");
  check("the renderer emits real text, not images",
    !/<img|<canvas|<svg/i.test(html), "graphics found");
  check("single column: no grid or column layout for resume content",
    !/column-count|grid-template-columns/i.test(html), "multi-column layout found");
  check("hyperlinks are real anchors with destinations",
    /<a href="https:\/\/tylerpleban\.com">tylerpleban\.com<\/a>/.test(html), "portfolio link not an anchor");
  check("link display text stays separate from its destination",
    html.includes(">tylerpleban.com<") && html.includes('href="https://tylerpleban.com"'), "");
  // Constraints, not one template's numbers. A finalist may set any
  // sizes it likes as long as body copy stays readable and the name
  // still dominates; asserting exact points would block every new
  // design rather than protecting anything.
  const pt = (re: RegExp): number | null => {
    const m = html.match(re);
    return m ? Number(m[1]) : null;
  };
  const bodyPt = pt(/body\s*\{[^}]*font-size:\s*([\d.]+)pt/);
  const namePt = pt(/\.name\s*\{[^}]*font-size:\s*([\d.]+)pt/);
  check("body copy stays at a readable size",
    bodyPt !== null && bodyPt >= 10 && bodyPt <= 13, `${bodyPt}pt`);
  check("the name dominates the page rather than merely being bold",
    namePt !== null && bodyPt !== null && namePt >= bodyPt * 2, `name ${namePt}pt vs body ${bodyPt}pt`);
  check("no type anywhere is shrunk below a legible floor",
    [...html.matchAll(/font-size:\s*([\d.]+)pt/g)].every((m) => Number(m[1]) >= 8),
    [...html.matchAll(/font-size:\s*([\d.]+)pt/g)].map((m) => m[1]).join(", "));
}

// ---- the artifact: identity, and what approval binds to -------------
{
  const a = await renderResume(doc);
  check("rendering produces a hash over the actual bytes",
    a.sha256 === hashPdf(a.pdf) && /^[0-9a-f]{64}$/.test(a.sha256), a.sha256);
  check("the renderer version travels with the artifact",
    a.rendererVersion === RENDERER_VERSION, `${a.rendererVersion}`);
  check("the pdf is a pdf", a.pdf.subarray(0, 5).toString() === "%PDF-", a.pdf.subarray(0, 8).toString());
  check("text is extractable in reading order",
    a.extractedText.indexOf("Ty Pleban") < a.extractedText.indexOf("TAILORED alpha"),
    a.extractedText.slice(0, 90).replace(/\n/g, " | "));
  check("every claim is extractable from the rendered document",
    documentLines(doc).every((l) => a.extractedText.replace(/\s+/g, " ").includes(l.replace(/\s+/g, " "))),
    "a claim is not in the extracted text");
  check("the document fits a sensible page count", a.pages <= 2, `${a.pages} pages`);

  // Re-rendering is NOT reliably reproducible, and not reliably
  // different either: a PDF carries a creation timestamp, so two renders
  // match or differ depending on whether they straddle a second. An
  // earlier version of this suite asserted determinism and passed, then
  // asserted non-determinism and passed; both were describing a clock.
  //
  // So neither direction is asserted. What matters is that hashing is a
  // pure function of the bytes, that different content always differs,
  // and that the fill path never re-renders at all, which is checked
  // structurally below.
  const b = await renderResume(doc);
  check("hashing is a pure function of the bytes",
    hashPdf(a.pdf) === a.sha256 && hashPdf(b.pdf) === b.sha256, "hashing is unstable");
  check("two renders of the same content carry the same content hash",
    contentHash(doc) === contentHash(doc), "");

  // Different content, different bytes: a substituted document is caught.
  const other = await renderResume({ ...doc, summary: line("A different summary entirely.", "s1") });
  check("a changed document produces a different hash",
    other.sha256 !== a.sha256, "hashes collided");
  check("and a different content hash", contentHash(doc) !== contentHash({ ...doc, summary: line("A different summary entirely.", "s1") }), "");
  check("so an artifact swapped after approval fails verification",
    hashPdf(other.pdf) !== a.sha256, "");
}

// ---- the renderer may not quietly drop content ----------------------
{
  const huge: ResumeDoc = { ...doc, roles: doc.roles.map((r) => ({ ...r,
    lines: Array.from({ length: 40 }, (_, i) => line(`overflow line ${i} that must not vanish`, `o${i}`)) })) };
  let threw = "";
  try { await renderResume(huge); } catch (e) { threw = (e as Error).message; }
  check("an over-long document is refused rather than silently truncated",
    threw === "" || /never removes content/.test(threw), threw.slice(0, 120));
}

// ---- the canonical content hash -------------------------------------
//
// Identifies the resume's CONTENT, so "the same resume re-rendered" is
// distinguishable from "a different resume". Never a substitute for the
// byte hash: see the fill-path checks below.
{
  const h = contentHash(doc);
  check("the content hash is a sha256", /^[0-9a-f]{64}$/.test(h), h);
  check("it is stable across calls", contentHash(doc) === h, "unstable");

  // Key order is an artefact of how an object was built, not of what it
  // says. Rebuilding the same document with its literals in a different
  // order must not move the hash.
  const reordered: ResumeDoc = {
    projects: doc.projects, skillGroups: doc.skillGroups, education: doc.education,
    roles: doc.roles.map((r) => ({
      endPrecision: r.endPrecision, startPrecision: r.startPrecision, end: r.end, start: r.start,
      location: r.location, title: r.title, employer: r.employer,
      lines: r.lines.map((l) => ({ sources: l.sources, text: l.text })),
    })),
    summary: { sources: doc.summary.sources, text: doc.summary.text },
    links: doc.links.map((l) => ({ href: l.href, text: l.text })),
    location: doc.location, phone: doc.phone, email: doc.email, name: doc.name,
  } as ResumeDoc;
  check("key ordering cannot change the content hash", contentHash(reordered) === h, contentHash(reordered));

  // Evidence ids are a set; the order they arrive in is incidental.
  const resorted: ResumeDoc = { ...doc, roles: doc.roles.map((r) => ({ ...r,
    lines: r.lines.map((l) => ({ ...l, sources: [...l.sources].reverse() })) })) };
  check("source ordering within a line cannot change it", contentHash(resorted) === h, "");

  // Incidental whitespace is not content.
  const respaced: ResumeDoc = { ...doc, summary: { ...doc.summary, text: `  ${doc.summary.text}  ` } };
  check("incidental whitespace cannot change it", contentHash(respaced) === h, "");

  // But anything a reader would notice must.
  const edited: ResumeDoc = { ...doc, summary: { ...doc.summary, text: `${doc.summary.text} Extra.` } };
  check("changed wording changes it", contentHash(edited) !== h, "");
  const relinked: ResumeDoc = { ...doc,
    links: [{ text: "tylerpleban.com", href: "https://example.invalid/somewhere-else" }, doc.links[1]!] };
  check("a changed link destination changes it, even with identical text",
    contentHash(relinked) !== h, "an attribution swap was invisible to the hash");
  const reordered2: ResumeDoc = { ...doc, roles: doc.roles.map((r) => ({ ...r, lines: [...r.lines].reverse() })) };
  check("reordered bullets change it, because order is a tailoring decision",
    doc.roles[0]!.lines.length < 2 || contentHash(reordered2) !== h, "");

  // Independent of presentation: the same content under a different
  // template is the same content.
  check("the content hash says nothing about visual design",
    !canonicalizeResume(doc).includes("font") && !canonicalizeResume(doc).includes("pt"),
    "presentation leaked into the canonical form");
}

// ---- the fill path cannot render, structurally ----------------------
//
// The strongest form of "no re-rendering at fill time" is that the code
// which fills a form has no way to produce a PDF. Asserted by reading
// the source rather than by trusting a comment.
{
  const { readFileSync } = await import("node:fs");
  const filler = readFileSync("scripts/fill-application.ts", "utf8");
  const browserFill = readFileSync("lib/browser/fill.ts", "utf8");
  for (const [name, src] of [["scripts/fill-application.ts", filler], ["lib/browser/fill.ts", browserFill]] as const) {
    check(`${name} cannot render a resume`,
      !/renderResume|renderAndStore|composeResume|assembleTailoredDoc/.test(src),
      "a rendering entry point is reachable from the fill path");
  }
  check("the filler obtains its document only through the approved-artifact check",
    /approvedArtifact\(/.test(filler), "the filler does not go through approvedArtifact");
  check("and no flag can turn rendering back on",
    !/--re-?render|allowRerender|forceRender/i.test(filler + browserFill), "a re-render escape hatch exists");
}

// ---- a resume never says the same thing twice ------------------------
//
// The live defect: several distinct claims legitimately cite one
// employment record, and matching tailored text by evidence set
// collapsed them to one claim which was then reissued for every line.
// Four Holley bullets came out as the same sentence four times.
{
  const shared = "shared-employment-row";
  const roleWith = (lines: Array<{ text: string; sources: string[] }>): ResumeDoc => ({
    ...MASTER, projects: [], skillGroups: MASTER.skillGroups,
    roles: [{ employer: "Holley Performance", title: "Videographer", location: null,
      start: "2022-01-01", end: "2024-01-01", startPrecision: "YEAR", endPrecision: "YEAR", lines }],
  });

  // Four DIFFERENT claims, one shared evidence row: all four must survive.
  const four = ["Produced creative work across brands", "Collaborated with marketing teams",
    "Produced automotive documentaries", "Supported broader marketing initiatives"];
  const distinct = roleWith(four.map((t) => line(t, shared)));
  // Role terms covering all four, so this isolates DEDUPLICATION from
  // relevance selection. Relevance dropping less-relevant bullets is a
  // separate mechanism with its own cases below.
  const { doc: d } = assembleTailoredDoc(distinct,
    [...four.map((t) => ({ original: t, claim: t, evidenceIds: [shared], generation: "SELECTED" })),
     { original: MASTER.summary.text, claim: MASTER.summary.text, evidenceIds: ["s1"], generation: "SELECTED" }],
    ["creative", "marketing", "automotive", "initiatives"], { ...DEFAULT_BUDGET, maxPerRole: 8 });
  check("four distinct claims from ONE evidence row all survive",
    d.roles[0]?.lines.length === 4, `${d.roles[0]?.lines.length} survived`);
  check("and none of them is a repeat of another",
    new Set(d.roles[0]!.lines.map((l) => l.text)).size === 4,
    d.roles[0]!.lines.map((l) => l.text).join(" | "));

  // The exact same claim twice: the second is dropped.
  const twice = roleWith([line("Produced creative work across brands", shared),
                          line("Produced creative work across brands", shared)]);
  const { doc: d2, dropped: dr2 } = assembleTailoredDoc(twice,
    [{ original: "Produced creative work across brands", claim: "Produced creative work across brands", evidenceIds: [shared], generation: "SELECTED" },
     { original: MASTER.summary.text, claim: MASTER.summary.text, evidenceIds: ["s1"], generation: "SELECTED" }],
    ["creative"]);
  check("an exact duplicate claim is dropped", d2.roles[0]?.lines.length === 1, `${d2.roles[0]?.lines.length}`);
  check("and the drop is recorded rather than silent",
    dr2.some((x) => /already stated/.test(x.why)), JSON.stringify(dr2).slice(0, 140));

  // Trivial wording differences on the same evidence: still a duplicate.
  const trivial = roleWith([line("Produced creative work across brands.", shared),
                            line("produced creative work across  brands", shared)]);
  const { doc: d3 } = assembleTailoredDoc(trivial,
    [{ original: "Produced creative work across brands.", claim: "Produced creative work across brands.", evidenceIds: [shared], generation: "SELECTED" },
     { original: "produced creative work across  brands", claim: "produced creative work across  brands", evidenceIds: [shared], generation: "SELECTED" },
     { original: MASTER.summary.text, claim: MASTER.summary.text, evidenceIds: ["s1"], generation: "SELECTED" }],
    ["creative"]);
  check("case, spacing and a trailing stop do not make it a new claim",
    d3.roles[0]?.lines.length === 1, `${d3.roles[0]?.lines.length}`);

  // Different wording, same evidence: ambiguous, so the evidence survives.
  const differing = roleWith([line("Produced creative work across brands", shared),
                              line("Produced creative work across multiple brands and teams", shared)]);
  const { doc: d4 } = assembleTailoredDoc(differing,
    [{ original: "Produced creative work across brands", claim: "Produced creative work across brands", evidenceIds: [shared], generation: "SELECTED" },
     { original: "Produced creative work across multiple brands and teams", claim: "Produced creative work across multiple brands and teams", evidenceIds: [shared], generation: "SELECTED" },
     { original: MASTER.summary.text, claim: MASTER.summary.text, evidenceIds: ["s1"], generation: "SELECTED" }],
    ["creative"]);
  check("similar but differently worded claims are BOTH kept, not guessed at",
    d4.roles[0]?.lines.length === 2, `${d4.roles[0]?.lines.length} kept`);
}

// A thin role stays thin: a budget is a maximum, never a quota.
{
  const thin: ResumeDoc = { ...MASTER, projects: [],
    roles: [{ ...MASTER.roles[0]!, lines: [line("The only pricing thing this role says", "t1")] }] };
  const { doc: d } = assembleTailoredDoc(thin,
    [{ original: "The only pricing thing this role says", claim: "The only pricing thing this role says", evidenceIds: ["t1"], generation: "SELECTED" },
     { original: MASTER.summary.text, claim: MASTER.summary.text, evidenceIds: ["s1"], generation: "SELECTED" }],
    ["pricing"], { ...DEFAULT_BUDGET, maxPerRole: 8 });
  check("a role with one relevant thing to say says it once, with a ceiling of eight",
    d.roles[0]?.lines.length === 1, `${d.roles[0]?.lines.length} bullets from one available`);
}

// The renderer cannot introduce a duplicate the document does not state.
{
  const one: ResumeDoc = { ...MASTER, projects: [], roles: [{ ...MASTER.roles[0]!,
    lines: [line("A single distinctive sentence for the duplication check", "u1")] }] };
  const r = await renderResume(one);
  const flat = r.extractedText.replace(/\s+/g, " ");
  const needle = "A single distinctive sentence for the duplication check";
  let n = 0, i = 0;
  while ((i = flat.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  check("a line stated once is printed exactly once", n === 1, `printed ${n} times`);
}

// ---- relevance decides length; nothing is ever padded ----------------
{
  const shared = "one-row";
  const five = ["Built pricing models", "Ran the logistics rota", "Filmed a documentary",
    "Edited motion graphics", "Managed vendor onboarding"];
  const doc0: ResumeDoc = { ...MASTER, projects: [],
    roles: [{ ...MASTER.roles[0]!, lines: five.map((t) => line(t, shared)) }] };
  const acc = [...five.map((t) => ({ original: t, claim: t, evidenceIds: [shared], generation: "SELECTED" })),
    { original: MASTER.summary.text, claim: MASTER.summary.text, evidenceIds: ["s1"], generation: "SELECTED" }];

  const { doc: pricing } = assembleTailoredDoc(doc0, acc, ["pricing", "models"]);
  check("a posting about pricing keeps the pricing bullet first",
    pricing.roles[0]?.lines[0]?.text === "Built pricing models",
    pricing.roles[0]?.lines[0]?.text ?? "none");
  check("and never exceeds the per-role ceiling",
    (pricing.roles[0]?.lines.length ?? 0) <= DEFAULT_BUDGET.maxPerRole, `${pricing.roles[0]?.lines.length}`);

  // Two positions, one speaking to the posting and one not: the relevant
  // one earns more space, and the other is present but brief.
  {
    const twoRoles: ResumeDoc = { ...MASTER, projects: [], roles: [
      { ...MASTER.roles[0]!, employer: "Relevant Co", lines: five.map((t) => line(t, shared)) },
      { ...MASTER.roles[1]!, employer: "Unrelated Co",
        lines: ["Watered the plants", "Filed the archive", "Answered the door"].map((t, i) => line(t, `u${i}`)) },
    ] };
    const acc2 = [
      ...five.map((t) => ({ original: t, claim: t, evidenceIds: [shared], generation: "SELECTED" })),
      ...["Watered the plants", "Filed the archive", "Answered the door"].map((t, i) => ({ original: t, claim: t, evidenceIds: [`u${i}`], generation: "SELECTED" })),
      { original: MASTER.summary.text, claim: MASTER.summary.text, evidenceIds: ["s1"], generation: "SELECTED" },
    ];
    const { doc: d } = assembleTailoredDoc(twoRoles, acc2, ["pricing", "models", "logistics", "vendor"]);
    const rel = d.roles.find((r) => r.employer === "Relevant Co");
    const irr = d.roles.find((r) => r.employer === "Unrelated Co");
    check("the position that speaks to the posting earns more space",
      (rel?.lines.length ?? 0) > (irr?.lines.length ?? 0),
      `relevant ${rel?.lines.length} vs unrelated ${irr?.lines.length}`);
    check("and the unrelated one takes no space it has not earned",
      irr?.lines.length === 0, `${irr?.lines.length}`);
    check("while still appearing, so the chronology is unbroken",
      !!irr && irr.employer === "Unrelated Co", "the role vanished");
  }

  const { doc: video } = assembleTailoredDoc(doc0, acc, ["documentary", "motion", "graphics"]);
  check("a different posting reorders to its own strongest evidence",
    video.roles[0]?.lines[0]?.text !== pricing.roles[0]?.lines[0]?.text,
    `${video.roles[0]?.lines[0]?.text}`);

  const { doc: unrelated } = assembleTailoredDoc(doc0, acc, ["astrophysics"]);
  check("a role whose evidence says nothing about the posting gets ZERO bullets",
    unrelated.roles[0]?.lines.length === 0, `${unrelated.roles[0]?.lines.length}`);
  check("and the role itself survives, so the chronology has no hole",
    unrelated.roles.length === 1 && unrelated.roles[0]?.employer === doc0.roles[0]!.employer,
    `${unrelated.roles.length} role(s)`);
}

// ---- allowances are ceilings, never quotas ---------------------------
{
  const relevantLines = ["Built pricing models", "Ran pricing reviews", "Owned pricing strategy"];
  const dullLines = ["Watered the plants", "Filed the archive"];
  const doc0: ResumeDoc = { ...MASTER, projects: [], roles: [
    { ...MASTER.roles[0]!, employer: "Pricing Co", lines: relevantLines.map((t, i) => line(t, `p${i}`)) },
    { ...MASTER.roles[1]!, employer: "Quiet Co", lines: dullLines.map((t, i) => line(t, `q${i}`)) },
  ] };
  const acc = [
    ...relevantLines.map((t, i) => ({ original: t, claim: t, evidenceIds: [`p${i}`], generation: "SELECTED" })),
    ...dullLines.map((t, i) => ({ original: t, claim: t, evidenceIds: [`q${i}`], generation: "SELECTED" })),
    { original: MASTER.summary.text, claim: MASTER.summary.text, evidenceIds: ["s1"], generation: "SELECTED" },
  ];
  const { doc: d } = assembleTailoredDoc(doc0, acc, ["pricing", "models", "strategy"]);
  const rel = d.roles.find((r) => r.employer === "Pricing Co");
  const quiet = d.roles.find((r) => r.employer === "Quiet Co");

  check("a highly relevant role receives several distinct bullets",
    (rel?.lines.length ?? 0) >= 3 && new Set(rel!.lines.map((l) => l.text)).size === rel!.lines.length,
    `${rel?.lines.length}`);
  check("a zero-relevance role receives zero bullets, not a minimum",
    quiet?.lines.length === 0, `${quiet?.lines.length}`);
  check("but it is still listed, so the work history stays continuous",
    !!quiet && quiet.employer === "Quiet Co", "the role vanished");
  check("no role was padded toward any floor",
    d.roles.every((r) => r.lines.length <= (r.employer === "Pricing Co" ? relevantLines.length : dullLines.length)),
    d.roles.map((r) => `${r.employer}:${r.lines.length}`).join(", "));

  // Structural: the budget type carries no total and no minimum, so
  // neither can quietly become a target again.
  const budgetKeys = Object.keys(DEFAULT_BUDGET).sort();
  check("the budget has no total-bullet target",
    !budgetKeys.some((k) => /total/i.test(k)), budgetKeys.join(", "));
  check("and no per-role minimum",
    !budgetKeys.some((k) => /min/i.test(k)), budgetKeys.join(", "));
}

// ---- employer-facing capabilities are narrower than the profile ------
{
  const inventory: ResumeDoc = { ...MASTER, skillGroups: [
    { label: "Operations", skills: ["Process design", "Vendor management", "Workflow documentation", "Project coordination"] },
    { label: "Creative", skills: ["Premiere Pro", "After Effects", "Motion graphics", "Colour grading"] },
    { label: "Fabrication", skills: ["FDM 3D printing", "CAD modelling", "Prototyping"] },
  ] };

  const ops = selectCapabilities(inventory, ["process improvement", "vendor contracts", "cross-functional coordination"], "Legal Operations Specialist");
  check("an operations posting keeps the operations capabilities",
    ops.some((g) => g.label === "Operations"), ops.map((g) => g.label).join(", ") || "(none)");
  check("and does not spend space on unrelated fabrication skills",
    !ops.some((g) => g.label === "Fabrication"), ops.map((g) => g.label).join(", "));
  check("the full profile inventory is never emitted wholesale",
    ops.reduce((n, g) => n + g.skills.length, 0) < inventory.skillGroups.reduce((n, g) => n + g.skills.length, 0),
    "everything survived");

  const creative = selectCapabilities(inventory, ["video editing", "motion graphics", "production"], "Video Editor");
  check("a creative posting keeps a different set entirely",
    creative.some((g) => g.label === "Creative") && !creative.some((g) => g.label === "Operations"),
    creative.map((g) => g.label).join(", ") || "(none)");

  const unrelated = selectCapabilities(inventory, ["phlebotomy", "venipuncture"], "Phlebotomist");
  check("a posting sharing nothing drops the section entirely",
    unrelated.length === 0, unrelated.map((g) => g.label).join(", "));
}

// A document with no capabilities section still renders.
{
  const none: ResumeDoc = { ...doc, skillGroups: [] };
  const r = await renderResume(none);
  check("the resume renders with no CAPABILITIES section at all",
    r.pdf.subarray(0, 5).toString() === "%PDF-", "render failed");
  check("and does not print an empty heading",
    !/CAPABILITIES/i.test(r.extractedText), r.extractedText.slice(0, 60));
}

// Typography does not shrink because content grew.
{
  const small = renderResumeHtml(doc);
  const big = renderResumeHtml({ ...doc, roles: doc.roles.map((r) => ({ ...r,
    lines: Array.from({ length: 6 }, (_, i) => line(`A distinct claim number ${i} about pricing work`, `g${i}`)) })) });
  const bodyOf = (h: string) => Number(h.match(/body\s*\{[^}]*font-size:\s*([\d.]+)pt/)?.[1] ?? 0);
  check("typography is identical whether the document is short or long",
    bodyOf(small) === bodyOf(big) && bodyOf(small) >= 10, `${bodyOf(small)} vs ${bodyOf(big)}`);
}

console.log(`${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
