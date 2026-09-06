#!/usr/bin/env -S node --env-file=.env.local
/**
 * Model-6 zero-adjacency guard: a scorable posting whose discriminating
 * requirements are affirmatively unmet, with no direct discriminating match
 * and no transferable adjacency, becomes REJECT instead of a STRETCH resting
 * on a bare baseline degree. Recall is preserved: any transferable foothold,
 * any met requirement, a thin posting, or unresolved (unknown) requirements
 * all keep a job OUT of the reject arm. Model 5 read-back is unchanged.
 *   node scripts/candidacy-zero-adjacency-selftest.ts
 */
import { assessCandidacy, type RequirementRow } from "../lib/scoring/candidacy.ts";
import type { FitBreakdown, ScorableConcept } from "../lib/scoring/fit.ts";
let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };
let seq = 0;
const C = (o: Partial<ScorableConcept> & { concept: string }): ScorableConcept => ({
  requirementClass: "SKILL", hardness: "HARD", resolution: "ABSENT", via: null, rationale: "",
  weight: 3, credit: 0, requirementIds: [`r${seq++}`], credentialFamily: null, ...o,
} as ScorableConcept);
const fit = (concepts: ScorableConcept[]): FitBreakdown => ({
  concepts, coverage: 0, evidence: 0, creditedCount: 0, achieved: 0, achievable: 0,
  excludedUnknown: 0, excludedByClass: {}, scorable: true, unscorableReason: null,
} as FitBreakdown);
const reqs = (n: number): RequirementRow[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, kind: "SKILL", normalized_term: `t${i}`, raw_text: `t${i}` }));
const DEGREE = C({ concept: "bachelor degree", requirementClass: "EDUCATION", resolution: "DIRECT", credit: 1, isBaseline: true } as any);
const ABS = (name: string) => C({ concept: name, resolution: "ABSENT", credit: 0 });
const TRANS = (name: string) => C({ concept: name, resolution: "TRANSFERABLE", credit: 0.5 });
const MET = (name: string) => C({ concept: name, resolution: "DIRECT", credit: 1 });
const UNK = (name: string) => C({ concept: name, resolution: "UNKNOWN", credit: null } as any);
const run = (concepts: ScorableConcept[], model: number) =>
  assessCandidacy({ jobTitle: "Specialist", fit: fit(concepts), requirements: reqs(concepts.length), credentialDeclarations: {}, modelVersion: model });

// NEGATIVE CONTROL: baseline degree + 4 affirmatively-absent discriminating,
// zero transferable, zero met -> model 6 REJECT, model 5 STRETCH.
{
  const cs = [DEGREE, ABS("c++"), ABS("python"), ABS("probability"), ABS("trading")];
  const r6 = run(cs, 6), r5 = run(cs, 5);
  ok(r6.verdict === "REJECT" && r6.reasonCodes[0] === "ZERO_ADJACENCY_MISMATCH", "zero-adjacency mismatch -> model 6 REJECT", `${r6.verdict}/${r6.reasonCodes[0]}`);
  ok(r5.verdict === "STRETCH", "same case -> model 5 still STRETCH (read-back unchanged)", r5.verdict);
}
// POSITIVE: one transferable foothold -> NOT rejected (recall preserved).
{
  const r6 = run([DEGREE, ABS("c++"), ABS("python"), ABS("probability"), TRANS("operations")], 6);
  ok(r6.verdict !== "REJECT", "one transferable adjacency -> not rejected", r6.verdict);
}
// POSITIVE: a met discriminating requirement -> NOT rejected.
{
  const r6 = run([DEGREE, MET("process improvement"), ABS("c++"), ABS("python")], 6);
  ok(r6.verdict !== "REJECT", "some hard requirement met -> not rejected", `${r6.verdict} ${r6.hardMet}/${r6.hardTotal}`);
}
// POSITIVE: thin posting (< 3 discriminating) -> never auto-rejects on this arm.
{
  const r6 = run([DEGREE, ABS("c++"), ABS("python")], 6);
  ok(r6.reasonCodes[0] !== "ZERO_ADJACENCY_MISMATCH", "thin posting (2 discriminating) -> not zero-adjacency reject", `${r6.verdict}/${r6.reasonCodes[0]}`);
}
// POSITIVE: unresolved (unknown) requirements -> a person decides, not REJECT.
{
  const r6 = run([DEGREE, UNK("c++"), UNK("python"), UNK("probability")], 6);
  ok(r6.verdict !== "REJECT", "unresolved/unknown requirements -> not rejected (uncertainty is a person's call)", `${r6.verdict}/${r6.reasonCodes[0]}`);
}
// POSITIVE: material-gap STRETCH with transferable occupational adjacency stays STRETCH.
{
  const cs = [DEGREE, TRANS("customer success"), ABS("technical product support"), ABS("priority management")];
  const r6 = run(cs, 6);
  ok(r6.verdict !== "REJECT", "transferable occupational adjacency + absent specialty -> STRETCH, not reject", r6.verdict);
}
console.log(bad ? `\n${bad} FAILED` : `\ncandidacy-zero-adjacency-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
