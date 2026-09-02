/**
 * Employer-authored alternatives, held to their meaning.
 *
 *   node scripts/requirement-logic-selftest.ts
 *
 * The case behind every assertion here is real: SpotHero's "3+ years of
 * legal operations experience or 5+ years of operations experience and
 * an interest in the legal field" became two independently mandatory
 * requirements, and failing both was counted as two core gaps.
 *
 * The invariant under test is that an alternative the employer wrote
 * never becomes several requirements that must all hold, and that
 * nothing is forced to MET or ABSENT to make the arithmetic easier.
 */
import {
  collapseAlternatives, groupCredit, conjunctCredit, detectAlternativeGroups,
  type LogicalRequirement,
} from "../lib/scoring/requirementLogic.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

const req = (id: string, concept: string, credit: number | null, group?: string, conjunct?: string): LogicalRequirement =>
  ({ id, concept, credit, hardness: "HARD", alternativeGroup: group ?? null, conjunctKey: conjunct ?? null });

const creditOf = (rs: LogicalRequirement[]) => collapseAlternatives(rs).map((r) => r.credit);

console.log("\nA OR B:");
check("A absent, B met -> satisfied",
  creditOf([req("a", "A", 0, "g", "x"), req("b", "B", 1, "g", "y")])[0] === 1);
check("A met, B absent -> satisfied",
  creditOf([req("a", "A", 1, "g", "x"), req("b", "B", 0, "g", "y")])[0] === 1);
check("both absent -> not satisfied",
  creditOf([req("a", "A", 0, "g", "x"), req("b", "B", 0, "g", "y")])[0] === 0);
check("one collapsed requirement, not two",
  collapseAlternatives([req("a", "A", 0, "g", "x"), req("b", "B", 0, "g", "y")]).length === 1);

console.log("\nUNKNOWN stays UNKNOWN:");
check("one unknown, other absent -> unresolved, not absent",
  creditOf([req("a", "A", null, "g", "x"), req("b", "B", 0, "g", "y")])[0] === null);
check("one unknown, other MET -> satisfied, because something is established",
  creditOf([req("a", "A", null, "g", "x"), req("b", "B", 1, "g", "y")])[0] === 1);
check("both unknown -> unresolved",
  creditOf([req("a", "A", null, "g", "x"), req("b", "B", null, "g", "y")])[0] === null);

console.log("\nA AND B stays conjunctive:");
{
  const c = creditOf([req("a", "A", 1), req("b", "B", 0)]);
  check("ungrouped requirements pass through untouched", c.length === 2 && c[0] === 1 && c[1] === 0, JSON.stringify(c));
  check("a failing conjunct is still a failure", conjunctCredit([req("a", "A", 1), req("b", "B", 0)]) === 0);
  check("an unknown conjunct member is unresolved", conjunctCredit([req("a", "A", 1), req("b", "B", null)]) === null);
  check("a definite failure beats an unknown",
    conjunctCredit([req("a", "A", 0), req("b", "B", null)]) === 0);
}

console.log("\nA OR (B AND C):");
{
  // Exactly SpotHero's shape: one path, or another path with two parts.
  const shape = (a: number | null, b: number | null, c: number | null) =>
    groupCredit([req("a", "A", a, "g", "p1"), req("b", "B", b, "g", "p2"), req("c", "C", c, "g", "p2")]);
  check("A alone satisfies it", shape(1, 0, 0) === 1);
  check("B and C together satisfy it", shape(0, 1, 1) === 1);
  check("B without C does not", shape(0, 1, 0) === 0);
  check("C without B does not", shape(0, 0, 1) === 0);
  check("nothing satisfied -> not satisfied", shape(0, 0, 0) === 0);
  check("A unknown and the pair incomplete -> unresolved", shape(null, 1, 0) === null);
}

console.log("\nthe shapes the corpus actually contains:");
{
  // "Bachelor's degree or equivalent experience"
  check("degree OR equivalent experience, degree held -> satisfied",
    groupCredit([req("d", "bachelor's degree", 1, "g", "a"), req("e", "equivalent experience", 0, "g", "b")]) === 1);
  check("degree OR equivalent experience, neither established -> unresolved, not absent",
    groupCredit([req("d", "bachelor's degree", null, "g", "a"), req("e", "equivalent experience", null, "g", "b")]) === null);

  // "3+ years specialized OR 5+ years broader"
  check("specialized absent, broader met -> satisfied",
    groupCredit([req("s", "legal operations", 0, "g", "a"), req("b", "operations", 1, "g", "b")]) === 1);
  check("specialized absent, broader UNRESOLVED -> unresolved, which is SpotHero's true state",
    groupCredit([req("s", "legal operations", 0, "g", "a"), req("b", "operations", null, "g", "b")]) === null);
}

console.log("\nthe collapsed requirement reports honestly:");
{
  const [g] = collapseAlternatives([
    req("s", "legal operations", 0, "g", "a"), req("b", "operations", 1, "g", "b"),
  ]);
  check("it names the alternation, not one half of it", g!.concept === "legal operations or operations", g!.concept);
  check("it records which alternative carried it", g!.satisfiedBy === "operations", String(g!.satisfiedBy));
  check("it still points at both original rows", g!.covers.length === 2, JSON.stringify(g!.covers));
}

console.log("\nwhat must NOT be treated as an alternative:");
{
  // A single requirement whose text merely contains the word "or".
  const single = [{ id: "1", rawText: "Excellent written or verbal communication skills" }];
  check("an ordinary 'or' inside one requirement forms no group",
    detectAlternativeGroups(single).size === 0, JSON.stringify([...detectAlternativeGroups(single)]));

  // Two genuinely distinct requirements that happen to sit near an "or".
  const distinct = [
    { id: "1", rawText: "3 years in customs brokerage" },
    { id: "2", rawText: "HTS classification" },
  ];
  check("two unrelated requirements form no group", detectAlternativeGroups(distinct).size === 0);

  // A group of one is not an alternative.
  check("a lone member of a group is passed through, not made unfalsifiable",
    creditOf([req("a", "A", 0, "g", "x")])[0] === 0);
}

console.log("\nconjunctions must NOT be read as alternations:");
{
  // Every one of these was wrongly grouped by a first version of the
  // detector, which accepted any "or" anywhere in the outer text and so
  // matched the "or" inside the FIRST clause while ignoring the "and"
  // that actually joins the two. Grouping them would make a genuine
  // conjunction satisfiable by half, which overstates the candidate.
  const conjunctions: Array<[string, string, string]> = [
    ["and after an internal or",
     "Lives in or in proximity to market and willingness to travel 25% or more",
     "willingness to travel 25% or more"],
    ["and after a degree alternation",
     "Degree in engineering or related technical field and 15+ years of relevant experience",
     "15+ years of relevant experience"],
    ["with after a degree alternation",
     "BS or MS in Computer Science or other technical degree with 5+ years of experience as an Applied Scientist",
     "5+ years of experience as an Applied Scientist"],
    ["with after an internal or",
     "3-4 years of experience teaching or delivering training, with at least 1 year in a scaled delivery model",
     "at least 1 year in a scaled delivery model"],
  ];
  for (const [label, outer, inner] of conjunctions) {
    const g = detectAlternativeGroups([{ id: "1", rawText: outer }, { id: "2", rawText: inner }]);
    check(`"${label}" forms no group`, g.size === 0, JSON.stringify([...g]));
  }
}

console.log("\ngenuine alternations are still found:");
{
  const alternations: Array<[string, string]> = [
    ["Associate degree OR 2 years relevant work experience", "2 years relevant work experience"],
    ["3+ years of legal operations experience or 5+ years of operations experience", "5+ years of operations experience"],
  ];
  for (const [outer, inner] of alternations) {
    const g = detectAlternativeGroups([{ id: "1", rawText: outer }, { id: "2", rawText: inner }]);
    check(`"${outer.slice(0, 46)}..." is grouped`, g.size === 2, JSON.stringify([...g]));
  }
}

console.log("\nthe real SpotHero text, detected without an LLM:");
{
  const real = [
    { id: "A", rawText: "3+ years of legal operations experience or 5+ years of operations experience and an interest in the legal field" },
    { id: "B", rawText: "5+ years of operations experience and an interest in the legal field" },
    { id: "C", rawText: "Bachelor's Degree" },
  ];
  const g = detectAlternativeGroups(real);
  check("the two alternatives are grouped", g.get("A") !== undefined && g.get("A") === g.get("B"),
    JSON.stringify([...g]));
  check("the unrelated degree requirement is left alone", !g.has("C"));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("employer-authored alternatives keep their meaning");
