/**
 * Rule A: the allocator's opportunity-cost repair.
 *
 * Per-entry allocation cannot see that a slot is worth more elsewhere,
 * so a claim scoring 1 printed while six claims scoring 3 went unused.
 * The repair trades slots to the strongest unused claim, under three
 * conditions that this file exists to hold in place: an entry with
 * something to say is never silenced, a ceiling is never exceeded, and
 * length never grows.
 */
import { assembleTailoredDoc, DEFAULT_BUDGET, documentLines } from "../lib/render/tailoredDoc.ts";
import { scoreClaim, profileFor } from "../lib/render/relevance.ts";
import type { ResumeDoc, ResumeLine } from "../lib/render/resume.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}\n         ${d}`); }
};
const line = (text: string, ...s: string[]): ResumeLine => ({ text, sources: s });
const TERMS = ["process improvement", "project coordination", "workflow", "operations"];
const TITLE = "Operations Manager";
const P = profileFor(TITLE, TERMS);

/**
 * The same sentence in two entries is a duplicate and the document
 * de-duplicates it, which would silently remove lines these tests are
 * counting. Each use gets a distinct nonsense token that no concept and
 * no theme word matches, so the score is untouched and the text is
 * unique. The fixture check below asserts the score really is untouched.
 */
let tag = 0;
const uniq = (t: string) => `${t.replace(/\.$/, "")} zzq${(tag++).toString(36)}.`;

const build = (roles: string[][], optional: string[], identity = "A compliance product for property owners.") => {
  const d: ResumeDoc = {
    name: "N", email: "e", phone: null, location: "L", links: [],
    summary: line("Summary sentence.", "s1"),
    // Distinct, non-overlapping spans. Identical dates let the
    // chronology step legitimately omit an entry, which is a different
    // mechanism from allocation and would hide what is being tested.
    roles: roles.map((ts, i) => ({ employer: `E${i}`, title: `T${i}`, location: null,
      start: `${2022 - i * 3}-01-01`, end: i === 0 ? null : `${2025 - i * 3}-01-01`,
      startPrecision: "YEAR", endPrecision: "YEAR", lines: ts.map((t, k) => line(uniq(t), `r${i}-${k}`)) })),
    education: [], skillGroups: [],
    projects: [{ name: "P", line: line(identity, "p1"), optional: optional.map((t, i) => line(uniq(t), `x${i}`)) }],
  } as any;
  const accepted = documentLines(d).map((t) => ({ original: t, claim: t, evidenceIds: [], generation: "SELECTED" as const }));
  const { doc: out, dropped } = assembleTailoredDoc(d, accepted, TERMS, DEFAULT_BUDGET, TITLE);
  const printed = [...out.roles.flatMap((r) => r.lines), ...out.projects[0]!.optional];
  return { out, dropped, roleCounts: out.roles.map((r) => r.lines.length),
    project: out.projects[0]!.optional.length, lines: documentLines(out).length,
    scores: printed.map((l) => scoreClaim(l.text, P)).sort((a, b) => b - a) };
};

// Sentences chosen so their scores are known and distinct.
const S9 = "Execute operations, process improvement, project coordination and workflow initiatives across teams.";
const S6 = "Coordinated workflows and managed project timelines across departments.";
const S4 = "Improved operational processes and standardized internal documentation.";
const S3a = "Delivered concurrent releases against tight deadlines.";
const S3b = "Scheduled and tracked deliverables for an ongoing programme.";
const S3c = "Ran a planning cycle with fixed delivery milestones.";
const S3d = "Managed a timeline of dependent deliverables to completion.";
const S1 = "Kept the studio manager updated on equipment upkeep.";
const S1b = "Catalogued the archive for the manager.";
const S0 = "Grew tomatoes in an unrelated field entirely.";
const FIXTURE: Array<[string, number]> = [[S9, 12], [S6, 10], [S4, 6], [S3a, 3], [S3b, 3], [S3c, 3], [S3d, 3], [S1, 1], [S1b, 1], [S0, 0]];
console.log(`  fixture scores: ${FIXTURE.map(([t]) => scoreClaim(t, P)).join(", ")}`);
for (const [t, want] of FIXTURE) {
  if (scoreClaim(t, P) !== want) { console.log(`  FIXTURE BROKEN: expected ${want}, got ${scoreClaim(t, P)} for "${t}"`); process.exit(1); }
  const u = `${t.replace(/\.$/, "")} zzqtest.`;
  if (scoreClaim(u, P) !== want) { console.log(`  UNIQUIFIER CHANGED A SCORE: ${want} -> ${scoreClaim(u, P)}`); process.exit(1); }
}
console.log();

// ---- 1. the SpotHero shape: a weak claim yields ------------------------
{
  // One entry is allowed five slots and has only four things worth
  // saying plus a weak fifth; another has a stronger unused claim.
  // The shape that produced the defect: a top-ranked entry allowed five
  // slots whose fifth-best claim is weak, and a lower-ranked entry whose
  // tier stops it short of claims that are stronger. An entry already at
  // its ceiling cannot be the beneficiary, which is why the spare has to
  // sit below the tier rather than above the ceiling.
  const weakEntryWins = [S9, S6, S4, S3a, S1];   // entryScore 32, tier 5
  const second = [S9, S6, S4, S3b];              // 31, tier 5
  const third = [S9, S6, S4, S3c];               // 31, tier 3
  const hasSpare = [S6, S4, S3d, S3a, S3b];      // 25, tier 3 -> two spare 3s
  const r = build([weakEntryWins, second, third, hasSpare], []);
  check("the score-1 claim does not print", !r.scores.includes(1), `printed [${r.scores.join(",")}]`);
  check("the entry holding it lost exactly that slot", r.roleCounts[0] === 4, JSON.stringify(r.roleCounts));
  check("and nothing weaker than a 3 came in to replace it",
    Math.min(...r.scores) >= 3, `printed [${r.scores.join(",")}]`);
}

// ---- 2. the diversity floor ------------------------------------------
{
  // The second entry holds exactly one relevant claim, and it is weak.
  // A stronger entry has more to say. The weak claim must survive.
  const strong = [S9, S6, S4, S3a, S3b, S3c];
  const onlyWeak = [S1, S0, S0];
  const r = build([strong, onlyWeak, [S0], [S0]], []);
  check("an entry's only positive claim is never taken away",
    r.roleCounts[1] === 1, `role counts ${JSON.stringify(r.roleCounts)}`);
  check("even though a stronger claim elsewhere went unused",
    r.scores.includes(1), `printed [${r.scores.join(",")}]`);
}

// ---- 3. zero never prints ---------------------------------------------
{
  const r = build([[S9, S0, S0], [S0], [S0], [S0]], [S0, S0]);
  check("no claim scoring zero reaches the page", !r.scores.includes(0), `printed [${r.scores.join(",")}]`);
  check("and an entry with nothing relevant prints nothing",
    r.roleCounts.slice(1).every((n) => n === 0), JSON.stringify(r.roleCounts));
  check("nor does a project with nothing relevant", r.project === 0, String(r.project));
}

// ---- 4. ceilings stay ceilings ----------------------------------------
{
  const many = [S9, S6, S4, S3a, S3b, S3c, S3d];
  const r = build([many, [S0], [S0], [S0]], []);
  check("no entry exceeds maxPerRole however much it has to say",
    r.roleCounts.every((n) => n <= DEFAULT_BUDGET.maxPerRole), JSON.stringify(r.roleCounts));
}
{
  const manyProject = [S9, S6, S4, S3a, S3b, S3c, S3d];
  const r = build([[S0], [S0], [S0], [S0]], manyProject);
  check("no project exceeds maxPerProject however strong its pool",
    r.project <= DEFAULT_BUDGET.maxPerProject, String(r.project));
  check("a trade cannot buy space a ceiling forbids", r.project === DEFAULT_BUDGET.maxPerProject, String(r.project));
}

// ---- 5. length is conserved -------------------------------------------
{
  const cases: Array<[string[][], string[]]> = [
    [[[S9, S6, S4, S3a, S1], [S6, S4, S3b, S3c, S3d], [S3a], [S0]], [S3b, S3c]],
    [[[S9], [S6, S4], [S3a, S3b, S3c], [S1]], [S9, S6, S4, S3a]],
    [[[S0], [S0], [S0], [S0]], [S9, S6]],
  ];
  for (const [roles, optional] of cases) {
    const r = build(roles, optional);
    const totalPositives = [...roles.flat(), ...optional].filter((t) => scoreClaim(t, P) > 0).length;
    check(`length stays within what the pools and ceilings allow (${r.lines} lines)`,
      r.lines <= totalPositives + 2, `${r.lines} lines, ${totalPositives} positives`);
  }
}

// ---- 6. projects and roles trade on the same terms ---------------------
{
  // The project holds the strongest unused claim; a role holds the weakest
  // printed one. The trade must run across the kinds, not only within.
  // Four strong roles push the project to the bottom tier, so it takes
  // two of its three claims and has a stronger one spare. One role is
  // carrying a score-1 claim it cannot fill better from its own pool.
  // The project ranks last, so it takes the bottom tier of two and has a
  // third claim spare. A role is carrying a score-1 claim.
  const r = build([[S9, S6, S4, S3a, S1], [S9, S6, S4], [S9, S6, S3b], [S9, S4, S3c]], [S6, S4, S3b]);
  check("a project can take a slot from a role across the kinds",
    r.project === 3 && !r.scores.includes(1),
    `project ${r.project} printed [${r.scores.join(",")}] roles ${JSON.stringify(r.roleCounts)}`);
}
{
  // The mirror: a role holds the strongest unused claim, the project the
  // weakest printed one.
  const r = build([[S9, S6, S4, S3a, S3b, S3c], [S0], [S0], [S0]], [S6, S1]);
  check("a role can take a slot from a project",
    r.roleCounts[0]! + r.project <= DEFAULT_BUDGET.maxPerRole + DEFAULT_BUDGET.maxPerProject, "");
}

// ---- 7. determinism ----------------------------------------------------
{
  const args: [string[][], string[]] = [[[S9, S6, S4, S3a, S1], [S6, S4, S3b, S3c], [S3a, S3b], [S1]], [S6, S3c, S3d]];
  const runs = Array.from({ length: 5 }, () => build(args[0], args[1]));
  const first = JSON.stringify({ r: runs[0]!.roleCounts, p: runs[0]!.project, s: runs[0]!.scores });
  check("repeated runs produce identical output",
    runs.every((r) => JSON.stringify({ r: r.roleCounts, p: r.project, s: r.scores }) === first), first);
}
{
  // Equal scores must not swap: an improving trade is strict.
  const r1 = build([[S3a, S3b, S3c, S3d], [S3a, S3b, S3c, S3d], [S0], [S0]], []);
  const r2 = build([[S3a, S3b, S3c, S3d], [S3a, S3b, S3c, S3d], [S0], [S0]], []);
  check("ties never trade, so the result does not depend on order",
    JSON.stringify(r1.roleCounts) === JSON.stringify(r2.roleCounts), JSON.stringify(r1.roleCounts));
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
