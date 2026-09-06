/**
 * Project evidence, from unreachable to selected.
 *
 * What is being tested is that a project's optional claims obey the same
 * rules an employment bullet obeys, and that three things which are NOT
 * true of employment hold as well: a non-current statement cannot be
 * reframed, a statement that restates the project description does not
 * appear, and a large evidence pool does not buy a larger section.
 */
import { projectClaims, implementationState, mayBeReframed } from "../lib/render/projectEvidence.ts";
import { assembleTailoredDoc, DEFAULT_BUDGET, documentLines, normalizeProse } from "../lib/render/tailoredDoc.ts";
import { checkGrounding } from "../lib/render/grounding.ts";
import { renderResumeHtml } from "../lib/render/resumePdf.ts";
import type { ResumeDoc, FrozenRow } from "../lib/render/resume.ts";
import { readFileSync } from "node:fs";

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}\n         ${detail}`); }
};

const PROJECT = "11111111-1111-1111-1111-111111111111";
const ev = (id: string, summary: string, detail = "CURRENT. x") =>
  ({ source_table: "evidence", row_id: id, row_data: { id, summary, detail } });
const link = (evidenceId: string, employer_facing = true, project_id = PROJECT) =>
  ({ source_table: "project_evidence", row_id: evidenceId, row_data: { project_id, evidence_id: evidenceId, employer_facing } });

// ---- 1. implementation state ----------------------------------------
check("CURRENT is read from the detail", implementationState({ detail: "CURRENT. Established 2026." }) === "CURRENT");
check("BUILT_BUT_PAUSED is read", implementationState({ detail: "BUILT_BUT_PAUSED. x" }) === "BUILT_BUT_PAUSED");
check("a detail with no state reads as NONE", implementationState({ detail: "Something else." }) === "NONE");
check("a missing detail reads as NONE", implementationState({}) === "NONE");
check("CURRENT evidence may be reframed", mayBeReframed("CURRENT"));
check("stateless evidence may be reframed", mayBeReframed("NONE"));
for (const s of ["BUILT_BUT_PAUSED", "PARTIAL", "CONDITIONAL"] as const) {
  check(`${s} evidence may not be reframed`, !mayBeReframed(s));
}

// ---- 2. the pool -----------------------------------------------------
{
  const rows: FrozenRow[] = [
    ev("a1", "Does the first thing."), ev("a2", "Does the second thing."),
    ev("a3", "Never printable."), ev("a4", "Belongs to another project."),
    link("a1"), link("a2"), link("a3", false), link("a4", true, "22222222-2222-2222-2222-222222222222"),
  ] as any;
  const claims = projectClaims(PROJECT, rows);
  check("only linked, employer-facing evidence becomes a claim",
    claims.map((c) => c.line.sources[0]).join(",") === "a1,a2", JSON.stringify(claims.map((c) => c.line.text)));
  check("a claim is the statement verbatim", claims[0]!.line.text === "Does the first thing.");
  check("and cites exactly the row it came from", JSON.stringify(claims[0]!.line.sources) === '["a1"]');
  check("evidence linked to another project is not offered", !claims.some((c) => c.line.sources[0] === "a4"));

  const orphan = projectClaims(PROJECT, [link("gone")] as any);
  check("a link whose evidence is not in this version yields nothing", orphan.length === 0);
}

// ---- 3. selection ----------------------------------------------------
const line = (text: string, ...s: string[]) => ({ text, sources: s });
const doc = (optional: string[][]): ResumeDoc => ({
  name: "N", email: "e", phone: null, location: "L", links: [],
  summary: line("Summary sentence.", "s1"),
  roles: [{ employer: "E", title: "T", location: null, start: "2020-01-01", end: null,
    startPrecision: "YEAR", endPrecision: "YEAR", lines: [line("A role bullet about process improvement.", "r1")] }],
  education: [], skillGroups: [],
  projects: [{
    name: "P",
    line: line("A property-compliance monitoring system that checks city data sources.", "p1"),
    optional: optional.map(([t, id]) => line(t!, id!)),
  }],
} as any);

const accept = (d: ResumeDoc) => documentLines(d).map((t) => ({ original: t, claim: t, evidenceIds: [], generation: "SELECTED" }));

{
  const d = doc([
    ["Coordinates workflows across departments and manages project timelines.", "x1"],
    ["Grows tomatoes in an unrelated field entirely.", "x2"],
  ]);
  const { doc: out, dropped } = assembleTailoredDoc(d, accept(d), ["process improvement", "project coordination", "workflow"], DEFAULT_BUDGET, "Operations Manager");
  const kept = out.projects[0]!.optional.map((l) => l.text);
  check("a relevant project claim is selected", kept.some((t) => /Coordinates workflows/.test(t)), JSON.stringify(kept));
  check("a zero-relevance project claim is not",
    !kept.some((t) => /tomatoes/.test(t)) && dropped.some((x) => /tomatoes/.test(x.line) && /no measured relevance/.test(x.why)),
    JSON.stringify(dropped));
}
{
  // Space is not a reason. Every claim here is irrelevant, but the
  // posting speaks to what the project IS (a monitoring system that
  // checks data sources), so the project stays on its identity alone.
  const d = doc([["Grows tomatoes.", "x1"], ["Paints fences.", "x2"], ["Bakes bread.", "x3"]]);
  const { doc: out } = assembleTailoredDoc(d, accept(d), ["data monitoring", "system checks"], DEFAULT_BUDGET, "Data Operations");
  check("an empty allowance is not filled with irrelevant claims", out.projects[0]!.optional.length === 0,
    JSON.stringify(out.projects[0]!.optional.map((l) => l.text)));
  check("a project relevant on its identity survives with no optional claims", out.projects.length === 1);
}
{
  // Appear when relevant, not always: when NOTHING about the project --
  // identity or claims -- speaks to the posting, it is dropped rather
  // than printed as an unexplained line. This is the Part-16 rule.
  const d = doc([["Grows tomatoes.", "x1"], ["Paints fences.", "x2"], ["Bakes bread.", "x3"]]);
  const { doc: out, dropped } = assembleTailoredDoc(d, accept(d), ["e-billing", "contract lifecycle"], DEFAULT_BUDGET, "Legal Operations");
  check("a project with no relevance to the posting is dropped", out.projects.length === 0,
    JSON.stringify(out.projects.map((p) => p.name)));
  check("and the drop is recorded with a reason",
    dropped.some((x) => /property-compliance monitoring/.test(x.line) && /no measured relevance/.test(x.why)),
    JSON.stringify(dropped.map((x) => x.why)));
}
{
  // Eight relevant claims, ceiling of three.
  const many = Array.from({ length: 8 }, (_, i) =>
    [`Coordinates ${["workflow", "process", "project", "schedule", "delivery", "planning", "operations", "documentation"][i]} work across teams number ${i}.`, `x${i}`]);
  const d = doc(many);
  const { doc: out, dropped } = assembleTailoredDoc(d, accept(d), ["process improvement", "project coordination", "workflow", "operations"], DEFAULT_BUDGET, "Operations Manager");
  check("the project ceiling holds against a large pool",
    out.projects[0]!.optional.length === DEFAULT_BUDGET.maxPerProject, String(out.projects[0]!.optional.length));
  check("and says so when it drops one",
    dropped.some((x) => /beyond the 3 optional claim/.test(x.why)), JSON.stringify(dropped.map((x) => x.why).slice(0, 3)));
}
{
  // A restatement of the project description earns nothing.
  const d = doc([["A property-compliance monitoring system checking city data sources.", "x1"],
                 ["Coordinates workflows across departments and teams.", "x2"]]);
  const { doc: out, dropped } = assembleTailoredDoc(d, accept(d), ["process improvement", "workflow", "monitoring", "compliance"], DEFAULT_BUDGET, "Operations Manager");
  check("a claim restating the project description is dropped",
    !out.projects[0]!.optional.some((l) => /property-compliance monitoring system checking/.test(l.text))
    && dropped.some((x) => /says substantially what the project description/.test(x.why)),
    JSON.stringify(out.projects[0]!.optional.map((l) => l.text)));
}

// ---- 3b. the project competes for space on the same terms ------------
//
// The rule: a project reads its allowance off a ranking that includes
// the roles, at its own rank, using the one tier table. Its presence
// does not demote a role.
//
// Every sentence below is deliberately distinct in wording. Near-copies
// are collapsed by redundancy before anything is ranked, which is
// correct and which makes them useless for testing allocation.
{
  // Three lines each, because an entry is ranked on the sum of its best
  // lines. A role holding one sentence genuinely contributes less than a
  // project holding three, and a fixture giving every role a single line
  // is testing something other than allocation.
  const ROLE_LINES: string[][] = [
    ["Coordinated workflows and managed project timelines across departments.",
     "Improved operational processes and standardized internal documentation.",
     "Ran project planning and delivery for concurrent client engagements."],
    ["Managed scheduling, priorities and deadlines for a busy production team.",
     "Streamlined an approval process spanning several internal departments.",
     "Owned operational documentation and the procedures behind it."],
    ["Delivered concurrent projects against shifting priorities and deadlines.",
     "Coordinated planning between operations and external partners.",
     "Maintained the workflow tooling the team depended on."],
    ["Planned and executed process improvement work across the department.",
     "Tracked project delivery schedules and reported on progress.",
     "Documented operational procedures for repeatable handover."],
  ];
  // Strong pool: several claims that speak directly to the themes.
  const OPTIONAL = [
    "Automated a recurring compliance workflow that recomputes statuses on a schedule.",
    "Structured the system as interconnected subsystems with separate operational concerns.",
    "Built a deadline detection process that identifies changes between snapshots.",
    "Designed an intake process for classifying incoming records against known rules.",
    "Standardized how property obligations are documented and tracked over time.",
    "Coordinated third-party service integrations across billing and messaging.",
  ];
  // Weak-but-nonzero pool: each of these matches one concept and no
  // theme word, scoring 3, so the project ranks below every role while
  // still having more relevant claims than it can be given.
  const THIN = [
    "Delivered concurrent releases against tight deadlines.",
    "Scheduled and tracked deliverables for an ongoing programme.",
    "Ran a planning cycle with fixed delivery milestones.",
    "Managed a timeline of dependent deliverables to completion.",
  ];
  const WEAK_OPTIONAL = ["Grew tomatoes in an unrelated field entirely.", "Painted fences on weekends.",
                         "Baked bread for a local market.", "Collected vintage postage stamps."];
  const WEAK: string[][] = WEAK_OPTIONAL.map((t) => [t]);
  const TERMS = ["process improvement", "project coordination", "workflow", "operations"];
  const IDENTITY = "A compliance monitoring product that standardizes operational workflows for property owners.";

  const build = (roleLines: string[][], optional: string[]) => {
    const d: ResumeDoc = {
      name: "N", email: "e", phone: null, location: "L", links: [],
      summary: line("Summary sentence.", "s1"),
      roles: roleLines.map((ts, i) => ({ employer: `E${i}`, title: `T${i}`, location: null,
        start: "2020-01-01", end: null, startPrecision: "YEAR", endPrecision: "YEAR",
        lines: ts.map((t, k) => line(t, `r${i}-${k}`)) })),
      education: [], skillGroups: [],
      projects: [{ name: "P", line: line(IDENTITY, "p1"), optional: optional.map((t, i) => line(t, `x${i}`)) }],
    } as any;
    const { doc: out, dropped: dr } = assembleTailoredDoc(d, accept(d), TERMS, DEFAULT_BUDGET, "Operations Manager");
    return { dr, roleCounts: out.roles.map((r) => r.lines.length), project: out.projects[0]!.optional.length };
  };

  // Four relevant roles, a project that ranks below all of them.
  {
    const r = build(ROLE_LINES, THIN);
    check("a project ranking below every role takes the bottom tier, not a flat 3",
      r.project === 2, `kept ${r.project}`);
    check("and the reason names an earned allowance, not a fixed ceiling",
      r.dr.some((x) => /beyond the 2 optional claim\(s\) this posting earned it/.test(x.why)),
      JSON.stringify(r.dr.map((x) => x.why).slice(0, 3)));
  }
  // The same roles, with and without the project.
  {
    const without = build(ROLE_LINES, []);
    const with_ = build(ROLE_LINES, OPTIONAL);
    check("a project's presence never demotes a role",
      JSON.stringify(without.roleCounts) === JSON.stringify(with_.roleCounts),
      `${JSON.stringify(without.roleCounts)} vs ${JSON.stringify(with_.roleCounts)}`);
  }
  // Roles that say nothing, a project that says a great deal.
  {
    const r = build(WEAK, OPTIONAL);
    check("a project outranking every role earns more than a bottom-ranked role would",
      r.project === DEFAULT_BUDGET.maxPerProject, `kept ${r.project}`);
    check("and irrelevant roles still print nothing", r.roleCounts.every((n) => n === 0),
      JSON.stringify(r.roleCounts));
  }
  // Zero is zero, whatever the rank.
  {
    const r = build(ROLE_LINES, WEAK_OPTIONAL);
    check("a project whose every claim scores zero gets no allowance at all",
      r.project === 0, `kept ${r.project}`);
  }
  // A restatement of the identity line cannot inflate the rank.
  {
    // A near-copy of the identity line, scoring well on its own, must
    // still be dropped before anything is ranked.
    const restatement = "A compliance monitoring product standardizing operational workflow for property owners.";
    const r = build(WEAK, [restatement, OPTIONAL[0]!]);
    check("a claim restating the identity line does not count toward the rank",
      r.project === 1 && r.dr.some((x) => /says substantially what the project description/.test(x.why)),
      `kept ${r.project}: ${JSON.stringify(r.dr.map((x) => x.why))}`);
  }
  // The cap reduces and never grants.
  {
    const r = build(WEAK, OPTIONAL);
    check("the project cap limits and never grants", r.project <= DEFAULT_BUDGET.maxPerProject,
      `kept ${r.project}`);
  }
}

// ---- 4. the state guard ----------------------------------------------
{
  const paused = "RentPup has a filing-assistance workflow built end to end. The customer-facing request path was deliberately switched off in August 2026 pending legal review.";
  const base = { evidenceIds: ["e1"], sourceText: paused, original: paused };
  const same = checkGrounding({ ...base, claim: paused, implementationState: "BUILT_BUT_PAUSED" });
  check("paused evidence passes in its own words",
    same.checks.find((c) => c.check === "NO_STATE_ESCALATION")!.ok, JSON.stringify(same.failedCheck));
  const rewritten = checkGrounding({ ...base, implementationState: "BUILT_BUT_PAUSED",
    claim: "Built an end-to-end filing-assistance workflow covering upload, authorization, review and confirmation." });
  check("and is refused the moment it is reworded",
    !rewritten.checks.find((c) => c.check === "NO_STATE_ESCALATION")!.ok, "");
  for (const s of ["PARTIAL", "CONDITIONAL"]) {
    const r = checkGrounding({ ...base, implementationState: s, claim: "A shorter version of the same thing." });
    check(`${s} evidence is refused a rewrite`, !r.checks.find((c) => c.check === "NO_STATE_ESCALATION")!.ok);
  }
  const current = checkGrounding({ ...base, implementationState: "CURRENT", claim: "A shorter version of the same thing." });
  check("CURRENT evidence is not constrained by this check",
    current.checks.find((c) => c.check === "NO_STATE_ESCALATION")!.ok);
  const none = checkGrounding({ ...base, claim: "A shorter version of the same thing." });
  check("and neither is evidence that declares no state",
    none.checks.find((c) => c.check === "NO_STATE_ESCALATION")!.ok);
}

// ---- 5. whitespace ----------------------------------------------------
check("a doubled space collapses", normalizeProse("work.  Experience since 2016.") === "work. Experience since 2016.");
check("a space before punctuation goes", normalizeProse("word , next") === "word, next");
check("single spacing is untouched", normalizeProse("a b c.") === "a b c.");
check("no word is changed", normalizeProse("Taught 250+ students, translating workflows.") === "Taught 250+ students, translating workflows.");
{
  const d = doc([]);
  d.summary = line("First sentence here. Second sentence here. Third sentence here.", "s1");
  const { doc: out } = assembleTailoredDoc(d, accept(d), ["process"], DEFAULT_BUDGET, "Operations Manager");
  check("the sentence join no longer doubles the space", !/ {2}/.test(out.summary.text), JSON.stringify(out.summary.text));
}
{
  // The regression that matters: nothing the renderer prints has a run.
  const d = doc([["Coordinates workflows across departments.", "x1"]]);
  const { doc: out } = assembleTailoredDoc(d, accept(d), ["workflow", "process improvement"], DEFAULT_BUDGET, "Operations Manager");
  const runs = documentLines(out).filter((t) => / {2}|\s+[.,;:!?]/.test(t));
  check("no rendered line carries repeated whitespace", runs.length === 0, JSON.stringify(runs));
  const html = renderResumeHtml(out);
  const body = html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, "\n");
  const bad = body.split("\n").filter((l) => / {2}/.test(l.trim()) && l.trim());
  check("and neither does the rendered document", bad.length === 0, JSON.stringify(bad.slice(0, 3)));
  check("the renderer prints the optional claims", /Coordinates workflows across departments/.test(html));
}

// ---- 6. the guard is wired into the real path ------------------------
{
  const prepare = readFileSync("lib/applications/prepare.ts", "utf8");
  check("composition computes the fixed state from the rows a claim cites",
    /implementationState\(row\.row_data\)/.test(prepare) && /implementationState: fixedState\(/.test(prepare), "");
  const tailor = readFileSync("lib/render/tailor.ts", "utf8");
  check("and tailoring passes it to the grounding checks",
    /implementationState: source\.implementationState/.test(tailor), "");
  const composer = readFileSync("lib/render/resume.ts", "utf8");
  check("the composer builds the project pool from links, not from source",
    /optional: \[\.\.\.traction/.test(composer) && /projectClaims\(p\.row_id, rows\)/.test(composer), "");
  check("every project line, optional included, is gated by allLines",
    /p\.optional\]/.test(composer), "");
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
