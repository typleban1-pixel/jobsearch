/**
 * Model 4: unknown evidence must never improve candidacy by disappearing.
 *
 *   node scripts/candidacy-model4-selftest.ts
 *
 * Model 3 excluded every concept with a null credit from the
 * hard-requirement denominator. That is correct as far as it goes, since
 * an unresolved requirement is not a failed one and must not be counted
 * against him. But leaving the denominator is not neutral: the ratio is
 * then computed over what remains.
 *
 * SpotHero is the case. "3+ years of legal operations experience or 5+
 * years of operations experience" resolved UNKNOWN once the evidence
 * layer stopped calling it ABSENT, left the denominator, and the hard
 * ratio became 1/1. The model reported that he meets the hard
 * requirements of a job whose defining requirement it never established.
 *
 * Model 4 adds one arm and nothing else. Every assertion here is either
 * about that arm, or about a behavior that must NOT have moved.
 */
import { assessCandidacy, CANDIDACY_MODEL_VERSION, type RequirementRow } from "../lib/scoring/candidacy.ts";
import type { FitBreakdown, ScorableConcept } from "../lib/scoring/fit.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}\n         ${d}`); }
};
let seq = 0;
const C = (o: Partial<ScorableConcept> & { concept: string }): ScorableConcept => ({
  requirementClass: "SKILL", hardness: "HARD", resolution: "ABSENT", via: null, rationale: "",
  weight: 3, credit: 0, requirementIds: [`r${seq++}`], credentialFamily: null, ...o,
} as ScorableConcept);
/** An unresolved concept: UNKNOWN with no credit either way. */
const U = (o: Partial<ScorableConcept> & { concept: string }) =>
  C({ resolution: "UNKNOWN", credit: null, ...o });
const MET = (o: Partial<ScorableConcept> & { concept: string }) =>
  C({ resolution: "DIRECT", credit: 1, ...o });

const fitOf = (concepts: ScorableConcept[]): FitBreakdown => ({
  concepts, coverage: 0, evidence: 0, creditedCount: 0, achieved: 0, achievable: 0,
  excludedUnknown: 0, excludedByClass: {},
} as FitBreakdown);
const reqs = (...rs: Array<[string, string, string]>): RequirementRow[] =>
  rs.map(([id, kind, term]) => ({ id, kind, normalized_term: term, raw_text: term }));
const NOT_HELD = { CLINICAL: "NOT_HELD", LEGAL: "NOT_HELD", FINANCE: "NOT_HELD", ENGINEERING: "NOT_HELD" };
const at = (model: number) => (concepts: ScorableConcept[], requirements: RequirementRow[], title = "Operations Manager") =>
  assessCandidacy({ jobTitle: title, fit: fitOf(concepts), requirements, credentialDeclarations: NOT_HELD, modelVersion: model });
const m3 = at(3); const m4 = at(4);

console.log("\n0. the version itself:");
check("the current model is 4", CANDIDACY_MODEL_VERSION === 4, String(CANDIDACY_MODEL_VERSION));
check("model 3 remains executable", m3([MET({ concept: "x" })], reqs()).modelVersion === 3);
check("and reports itself as 3, so a stored row is attributable",
  m3([MET({ concept: "x" })], reqs()).modelVersion === 3);
check("model 4 reports itself as 4", m4([MET({ concept: "x" })], reqs()).modelVersion === 4);

console.log("\n1. role-defining HARD UNKNOWN, everything else met:");
{
  // The SpotHero shape. Under model 3 the unresolved requirement leaves
  // the denominator and 1/1 reads as a cleared bar.
  const cs = [
    U({ concept: "operations", requirementIds: ["a"] }),
    MET({ concept: "vendor management", requirementIds: ["b"] }),
    MET({ concept: "process improvement", requirementIds: ["c"] }),
  ];
  const rs = reqs(["a", "EXPERIENCE_YEARS", "5+ years of operations experience"],
                  ["b", "SKILL", "vendor management"], ["c", "SKILL", "process improvement"]);
  const before = m3(cs, rs); const after = m4(cs, rs);
  check("model 3 called it a candidate on a shrunken denominator",
    before.verdict === "APPLICATION_CANDIDATE", JSON.stringify(before.verdict));
  check("model 4 routes it to MANUAL_REVIEW", after.verdict === "MANUAL_REVIEW", JSON.stringify(after));
  check("with the new reason code", after.reasonCodes[0] === "UNRESOLVED_ROLE_DEFINING_REQUIREMENT");
  check("naming the unresolved requirement", after.unresolvedCore.includes("operations"), JSON.stringify(after.unresolvedCore));
  check("it is not counted as a gap", !after.coreGaps.includes("operations"), JSON.stringify(after.coreGaps));
  check("it is given no credit", after.hardMet === before.hardMet, `${after.hardMet} vs ${before.hardMet}`);
  check("and it is not added back to the denominator as a zero",
    after.hardTotal === before.hardTotal, `${after.hardTotal} vs ${before.hardTotal}`);
}

console.log("\n2. role-defining HARD UNKNOWN alongside other gaps:");
{
  // Two genuine gaps is still MULTIPLE_CORE_GAPS. A REJECT that model 3
  // reached must not soften into MANUAL_REVIEW.
  const cs = [
    U({ concept: "operations", requirementIds: ["a"] }),
    C({ concept: "operations research", requirementIds: ["b"] }),
    C({ concept: "operations planning", requirementIds: ["c"] }),
  ];
  const rs = reqs(["a", "EXPERIENCE_YEARS", "operations"], ["b", "SKILL", "operations research"],
                  ["c", "SKILL", "operations planning"]);
  check("two real gaps still REJECT under model 4", m4(cs, rs).verdict === "REJECT", JSON.stringify(m4(cs, rs)));
  check("and for the same reason as model 3", m4(cs, rs).reasonCodes[0] === m3(cs, rs).reasonCodes[0]);
}
{
  // One gap with support would have been a STRETCH. An unresolved
  // role-defining requirement on top of it is not assessable from here.
  const cs = [
    U({ concept: "operations", requirementIds: ["a"] }),
    C({ concept: "operations analytics", requirementIds: ["b"] }),
    MET({ concept: "vendor management", requirementIds: ["c"] }),
    MET({ concept: "process improvement", requirementIds: ["d"] }),
    MET({ concept: "forecasting", requirementIds: ["e"] }),
  ];
  const rs = reqs(["a", "EXPERIENCE_YEARS", "operations"], ["b", "SKILL", "operations analytics"],
                  ["c", "SKILL", "vendor management"], ["d", "SKILL", "process improvement"], ["e", "SKILL", "forecasting"]);
  check("model 3 made it a STRETCH", m3(cs, rs).verdict === "STRETCH", JSON.stringify(m3(cs, rs)));
  check("model 4 sends it to a person instead", m4(cs, rs).verdict === "MANUAL_REVIEW", JSON.stringify(m4(cs, rs)));
}
{
  // One gap WITHOUT support is a REJECT in model 3, and the more
  // conservative answer wins.
  const cs = [U({ concept: "operations", requirementIds: ["a"] }),
              C({ concept: "operations analytics", requirementIds: ["b"] })];
  const rs = reqs(["a", "EXPERIENCE_YEARS", "operations"], ["b", "SKILL", "operations analytics"]);
  check("an unsupported core gap still REJECTs", m4(cs, rs).verdict === "REJECT", JSON.stringify(m4(cs, rs)));
}

console.log("\n3. role-defining HARD MET: ordinary evaluation:");
{
  const cs = [MET({ concept: "operations", requirementIds: ["a"] }),
              MET({ concept: "vendor management", requirementIds: ["b"] })];
  const rs = reqs(["a", "EXPERIENCE_YEARS", "operations"], ["b", "SKILL", "vendor management"]);
  check("model 4 agrees with model 3 exactly", m4(cs, rs).verdict === m3(cs, rs).verdict, JSON.stringify(m4(cs, rs)));
  check("and it is a candidate", m4(cs, rs).verdict === "APPLICATION_CANDIDATE");
  check("nothing is flagged unresolved", m4(cs, rs).unresolvedCore.length === 0);
}

console.log("\n4. role-defining HARD ABSENT: existing gap behavior:");
{
  const cs = [C({ concept: "operations", requirementIds: ["a"] }),
              MET({ concept: "vendor management", requirementIds: ["b"] }),
              MET({ concept: "process improvement", requirementIds: ["c"] })];
  const rs = reqs(["a", "EXPERIENCE_YEARS", "operations"], ["b", "SKILL", "vendor management"], ["c", "SKILL", "process improvement"]);
  check("ABSENT is a gap, not an unknown", m4(cs, rs).coreGaps.includes("operations"), JSON.stringify(m4(cs, rs).coreGaps));
  check("and model 4 decides it exactly as model 3", m4(cs, rs).verdict === m3(cs, rs).verdict, JSON.stringify(m4(cs, rs)));
  check("nothing is flagged unresolved", m4(cs, rs).unresolvedCore.length === 0);
}

console.log("\n5. non-role-defining HARD UNKNOWN changes nothing:");
{
  // Unrelated to the title, backed by one requirement row, not
  // occupational. An incidental unknown.
  const cs = [MET({ concept: "vendor management", requirementIds: ["b"] }),
              MET({ concept: "process improvement", requirementIds: ["c"] }),
              U({ concept: "tableau", requirementIds: ["a"] })];
  const rs = reqs(["a", "SKILL", "tableau"], ["b", "SKILL", "vendor management"], ["c", "SKILL", "process improvement"]);
  check("no escalation", m4(cs, rs).verdict === m3(cs, rs).verdict, JSON.stringify(m4(cs, rs)));
  check("and it is not listed as unresolved core", m4(cs, rs).unresolvedCore.length === 0, JSON.stringify(m4(cs, rs).unresolvedCore));
}

console.log("\n6. SOFT/PREFERRED UNKNOWN never escalates:");
{
  const cs = [U({ concept: "operations", hardness: "PREFERRED", requirementIds: ["a"] }),
              MET({ concept: "vendor management", requirementIds: ["b"] }),
              MET({ concept: "process improvement", requirementIds: ["c"] })];
  const rs = reqs(["a", "EXPERIENCE_YEARS", "operations"], ["b", "SKILL", "vendor management"], ["c", "SKILL", "process improvement"]);
  check("a preferred unknown is not material", m4(cs, rs).verdict === m3(cs, rs).verdict, JSON.stringify(m4(cs, rs)));
  check("even when it names the role", m4(cs, rs).unresolvedCore.length === 0);
  const un = [U({ concept: "operations", hardness: "UNCLEAR", requirementIds: ["a"] }), ...cs.slice(1)];
  check("an UNCLEAR unknown is not material either", m4(un, rs).verdict === m3(un, rs).verdict, JSON.stringify(m4(un, rs)));
}

console.log("\n7. credential gating is untouched:");
{
  const cs = [U({ concept: "certified public accountant", requirementClass: "GATING_CREDENTIAL",
                  credentialFamily: "FINANCE", requirementIds: ["a"] }),
              MET({ concept: "operations", requirementIds: ["b"] })];
  const rs = reqs(["a", "CREDENTIAL", "cpa"], ["b", "EXPERIENCE_YEARS", "operations"]);
  check("an unknown gate is still UNKNOWN_GATING_CREDENTIAL",
    m4(cs, rs).reasonCodes[0] === "UNKNOWN_GATING_CREDENTIAL", JSON.stringify(m4(cs, rs)));
  check("identical to model 3", m4(cs, rs).verdict === m3(cs, rs).verdict && m4(cs, rs).reasonCodes[0] === m3(cs, rs).reasonCodes[0]);
  check("and a gating credential never appears in unresolvedCore",
    m4(cs, rs).unresolvedCore.length === 0, JSON.stringify(m4(cs, rs).unresolvedCore));
  // A declared NOT_HELD gate still REJECTs ahead of everything.
  const dq = [C({ concept: "cpa", requirementClass: "GATING_CREDENTIAL", credentialFamily: "FINANCE", requirementIds: ["a"] }),
              U({ concept: "operations", requirementIds: ["b"] })];
  check("a disqualifying credential still REJECTs ahead of the new arm",
    m4(dq, rs).reasonCodes[0] === "DISQUALIFYING_CREDENTIAL", JSON.stringify(m4(dq, rs)));
}

console.log("\n8. hardTotal === 0 behavior is unchanged:");
{
  const cs = [MET({ concept: "bachelor degree", requirementClass: "EDUCATION", isBaseline: true, requirementIds: ["a"] })];
  const rs = reqs(["a", "EDUCATION", "bachelor degree"]);
  check("no discriminating requirement is still MANUAL_REVIEW",
    m4(cs, rs).reasonCodes[0] === "NO_DISCRIMINATING_REQUIREMENTS", JSON.stringify(m4(cs, rs)));
  check("identical to model 3", m4(cs, rs).reasonCodes[0] === m3(cs, rs).reasonCodes[0]);
  // An unresolved BASELINE requirement is not material either.
  const b = [U({ concept: "bachelor degree", requirementClass: "EDUCATION", isBaseline: true, requirementIds: ["a"] }),
             MET({ concept: "operations", requirementIds: ["b"] })];
  const brs = reqs(["a", "EDUCATION", "bachelor degree"], ["b", "EXPERIENCE_YEARS", "operations"]);
  check("an unresolved baseline degree does not escalate",
    m4(b, brs).verdict === m3(b, brs).verdict, JSON.stringify(m4(b, brs)));
}

console.log("\n9. an empty posting is still POSTING_NOT_ASSESSED:");
check("nothing extracted is unchanged", m4([], reqs()).reasonCodes[0] === "POSTING_NOT_ASSESSED");

console.log("\n10. A OR B, collapsed by the OR grouping upstream:");
{
  // fit collapses the alternation into one concept before candidacy sees
  // it, so these are the three states that concept can arrive in.
  const others = [MET({ concept: "vendor management", requirementIds: ["c"] }),
                  MET({ concept: "process improvement", requirementIds: ["d"] })];
  const rs = reqs(["a", "EXPERIENCE_YEARS", "3+ years of legal operations experience"],
                  ["b", "EXPERIENCE_YEARS", "5+ years of operations experience"],
                  ["c", "SKILL", "vendor management"], ["d", "SKILL", "process improvement"]);
  const title = "Legal Operations Specialist";

  const unresolved = [U({ concept: "legal operations or operations", requirementIds: ["a", "b"] }), ...others];
  check("both branches unresolved -> MANUAL_REVIEW",
    m4(unresolved, rs, title).verdict === "MANUAL_REVIEW", JSON.stringify(m4(unresolved, rs, title)));
  check("and model 3 would have called it a candidate",
    m3(unresolved, rs, title).verdict === "APPLICATION_CANDIDATE", JSON.stringify(m3(unresolved, rs, title)));

  const satisfied = [MET({ concept: "legal operations or operations", requirementIds: ["a", "b"] }), ...others];
  check("one branch met -> normal scoring",
    m4(satisfied, rs, title).verdict === m3(satisfied, rs, title).verdict
    && m4(satisfied, rs, title).verdict === "APPLICATION_CANDIDATE", JSON.stringify(m4(satisfied, rs, title)));

  const absent = [C({ concept: "legal operations or operations", requirementIds: ["a", "b"] }), ...others];
  check("both branches absent -> normal gap behavior",
    m4(absent, rs, title).verdict === m3(absent, rs, title).verdict, JSON.stringify(m4(absent, rs, title)));
  check("and it is reported as a gap, not an unknown",
    m4(absent, rs, title).coreGaps.length === 1 && m4(absent, rs, title).unresolvedCore.length === 0);
}

console.log("\n11. the invariant, stated directly:");
{
  // Model 4 may only ever be equal to or stricter than model 3. This
  // enumerates every verdict pair that could arise and asserts none of
  // them is a loosening.
  const rank: Record<string, number> = { REJECT: 0, MANUAL_REVIEW: 1, STRETCH: 2, APPLICATION_CANDIDATE: 3 };
  const pool = [
    () => [U({ concept: "operations", requirementIds: ["a"] }), MET({ concept: "vendor management", requirementIds: ["b"] })],
    () => [U({ concept: "operations", requirementIds: ["a"] }), C({ concept: "operations analytics", requirementIds: ["b"] })],
    () => [MET({ concept: "operations", requirementIds: ["a"] }), MET({ concept: "vendor management", requirementIds: ["b"] })],
    () => [C({ concept: "operations", requirementIds: ["a"] }), MET({ concept: "vendor management", requirementIds: ["b"] })],
    () => [U({ concept: "tableau", requirementIds: ["a"] }), MET({ concept: "vendor management", requirementIds: ["b"] })],
    () => [U({ concept: "operations", hardness: "PREFERRED", requirementIds: ["a"] }), MET({ concept: "vendor management", requirementIds: ["b"] })],
  ];
  const rs = reqs(["a", "EXPERIENCE_YEARS", "operations"], ["b", "SKILL", "vendor management"]);
  let loosened = 0;
  for (const make of pool) {
    const a = m3(make(), rs); const b = m4(make(), rs);
    if (rank[b.verdict]! > rank[a.verdict]!) { loosened++; console.log(`      LOOSENED ${a.verdict} -> ${b.verdict}`); }
  }
  check("model 4 is never more permissive than model 3", loosened === 0, `${loosened} loosened`);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("unknown evidence cannot improve candidacy by disappearing");
