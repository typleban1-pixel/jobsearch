/**
 * Locks the false-negative fix the Instawork Product Operations Analyst
 * exposed (model 4):
 *   - a junior-seniority target ("early-career") is positioning, not an
 *     absent occupational capability;
 *   - d:0 with real transferable coverage, no defining occupational gap, and
 *     at least half the discriminating hard requirements met is a reasonable
 *     STRETCH, not an auto-REJECT;
 *   - a different occupation (low hard ratio) or a real occupational gap or
 *     no transferable foothold still REJECTs -- precision preserved.
 *   node scripts/candidacy-reasonable-applicant-selftest.ts
 */
import { assessCandidacy, isJuniorSeniorityTarget } from "../lib/scoring/candidacy.ts";
import type { FitBreakdown, ScorableConcept } from "../lib/scoring/fit.ts";
import type { RequirementRow } from "../lib/scoring/candidacy.ts";

let bad = 0;
const ok = (c: boolean, w: string, got?: unknown) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${c ? "" : "  got=" + JSON.stringify(got)}`); if (!c) bad++; };

const C = (o: Partial<ScorableConcept> & { concept: string }): ScorableConcept => ({
  requirementClass: "SKILL", hardness: "HARD", resolution: "ABSENT", via: null, rationale: "",
  weight: 1, credit: 0, isBaseline: false, requirementIds: [o.concept], ...o,
} as ScorableConcept);
const fitOf = (concepts: ScorableConcept[]): FitBreakdown => ({
  concepts, coverage: 0, evidence: 0, creditedCount: 0, achieved: 0, achievable: 0, excludedUnknown: 0, excludedByClass: {},
} as FitBreakdown);
const req = (id: string, kind: string): RequirementRow => ({ id, kind, normalized_term: id, raw_text: id } as RequirementRow);
const run = (concepts: ScorableConcept[], requirements: RequirementRow[], title = "Product Operations Analyst") =>
  assessCandidacy({ jobTitle: title, fit: fitOf(concepts), requirements, credentialDeclarations: {} });

ok(isJuniorSeniorityTarget("early-career professional"), "'early-career professional' is a junior-seniority target");
ok(isJuniorSeniorityTarget("recent graduate"), "'recent graduate' is junior-seniority");
ok(!isJuniorSeniorityTarget("5+ years of operations experience"), "'5+ years' is NOT junior-seniority (a real duration)");

// Instawork shape: early-career (excluded) + one substantive transferable, hard 1/1.
{
  const concepts = [
    C({ concept: "early-career professional", resolution: "ABSENT", credit: 0, requirementIds: ["y"] }),
    C({ concept: "spreadsheet", resolution: "TRANSFERABLE", credit: 0.5, requirementIds: ["s"] }),
  ];
  const r = run(concepts, [req("y", "EXPERIENCE_YEARS"), req("s", "TOOL")]);
  ok(r.verdict === "STRETCH" && r.reasonCodes[0] === "NO_DIRECT_BUT_TRANSFERABLE",
    "d:0 + transferable substance + no occ gap + ratio 1/1 -> STRETCH NO_DIRECT_BUT_TRANSFERABLE (Instawork)", r.verdict + "/" + r.reasonCodes[0]);
  ok(r.occupational.length === 0, "early-career is excluded from the occupational set", r.occupational);
}
// DevOps-intern shape: 1 transferable, 7 absent substantive -> ratio 1/8 -> REJECT.
{
  const concepts = [
    C({ concept: "git", resolution: "TRANSFERABLE", credit: 0.5, requirementIds: ["g"] }),
    ...Array.from({ length: 7 }, (_, i) => C({ concept: `eng skill ${i}`, resolution: "ABSENT", credit: 0, requirementIds: [`e${i}`] })),
  ];
  const r = run(concepts, [req("g", "TOOL"), ...Array.from({ length: 7 }, (_, i) => req(`e${i}`, "SKILL"))], "DevOps/SRE Intern");
  ok(r.verdict === "REJECT" && r.reasonCodes[0] === "NO_DIRECT_EVIDENCE",
    "d:0 + only 1/8 hard met (a different occupation) -> stays REJECT", r.verdict + "/" + r.reasonCodes[0]);
}
// A real occupational gap with d:0 -> REJECT (occAbsent present).
{
  const concepts = [
    C({ concept: "spreadsheet", resolution: "TRANSFERABLE", credit: 0.5, requirementIds: ["s"] }),
    C({ concept: "product marketing", resolution: "ABSENT", credit: 0, requirementClass: "SKILL", requirementIds: ["pm"] }),
  ];
  const r = run(concepts, [req("s", "TOOL"), req("pm", "DOMAIN")], "Product Marketing Manager");
  ok(r.verdict === "REJECT", "d:0 + a real occupational/domain gap -> stays REJECT", r.verdict + "/" + r.reasonCodes[0]);
}
// d:0 with no transferable foothold at all -> REJECT.
{
  const concepts = [C({ concept: "accounting", resolution: "ABSENT", credit: 0, requirementIds: ["a"] })];
  const r = run(concepts, [req("a", "SKILL")], "Accountant");
  ok(r.verdict === "REJECT" && r.reasonCodes[0] === "NO_DIRECT_EVIDENCE", "d:0 + zero transferable -> REJECT", r.verdict + "/" + r.reasonCodes[0]);
}

console.log(bad ? `\n${bad} FAILED` : `\ncandidacy-reasonable-applicant-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
