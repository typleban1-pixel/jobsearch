/**
 * OR-list requirements, and the qualifications they must not manufacture.
 *
 * The case this exists for, verbatim from a live Gopuff posting:
 *
 *   "Degree in Business, Operations, Supply Chain, Management, Science,
 *    Technology, Engineering, Math, or a related field"
 *
 * One requirement, satisfiable by any one of its branches. It was being
 * split into eight independent concepts, six of which took DIRECT credit
 * from a single verified B.S. in Health Science, and one of which was
 * displayed as "degree in business".
 *
 * Both directions are asserted. A test suite that only proves things get
 * blocked is passed by a system that credits nothing.
 */
import { decompose } from "../lib/matching/concepts.ts";
import { buildFitBreakdown } from "../lib/scoring/fit.ts";
import type { CapabilityIndex } from "../lib/scoring/capability.ts";
import type { EducationRecord } from "../lib/scoring/education.ts";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail: string) {
  if (cond) pass++; else fails.push(`  ${name}\n      ${detail}`);
}

// -- decomposition: AND and OR are different things -------------------
const cases: Array<[string, string, string, string[]]> = [
  ["a degree field list is a disjunction",
   "degree in business, operations, supply chain, management, science, technology, engineering, or math",
   "Degree in Business, Operations, Supply Chain, Management, Science, Technology, Engineering, Math, or a related field",
   ["OR"]],
  ["an experience list ending in 'or' is a disjunction",
   "experience in retail, supply chain, operations, consulting, or data-driven project management",
   "10+ years of relevant experience in retail, supply chain, operations, consulting, or data-driven project management",
   ["OR"]],
  ["a tool list ending in 'and' is a conjunction",
   "python, sql and data modeling",
   "Strong experience with Python, SQL and data modeling",
   ["AND"]],
  ["a bare comma list stays a conjunction",
   "python, sql, java",
   "Experience with Python, SQL, Java",
   ["AND"]],
];
for (const [name, concept, raw, expected] of cases) {
  const d = decompose(concept, raw);
  check(name, d.kind === expected[0], `got ${d.kind} parts=${JSON.stringify(d.parts)}`);
}

check("the trailing 'or' is not left attached to the last item",
  !decompose("degree in business, operations, science, technology, or math",
    "Degree in Business, Operations, Science, Technology, or Math").parts.some((p) => /^or\b/i.test(p)),
  JSON.stringify(decompose("degree in business, operations, science, technology, or math",
    "Degree in Business, Operations, Science, Technology, or Math").parts));

// -- the scoring consequences -----------------------------------------
const education: EducationRecord[] = [{ level: "BACHELOR", field: "Health Science" }];
// An empty capability index on purpose. These cases are about how a
// requirement is DECOMPOSED, and an empty index means any credit a
// concept receives came from the education assessor rather than from a
// skill match, which is exactly what is under test.
const index: CapabilityIndex = {
  relations: new Map(),
  matchTerm: () => ({ status: "NONE" as any, skillName: null, method: "empty index", terminal: null }),
};

function fitOf(reqs: Array<{ id: string; raw_text: string; normalized_term: string; is_hard_requirement: string }>) {
  return buildFitBreakdown(reqs, "Regional Manager I", index, {}, education, null, 0);
}

const GOPUFF_DEGREE = {
  id: "r1",
  raw_text: "Degree in Business, Operations, Supply Chain, Management, Science, Technology, Engineering, Math, or a related field",
  normalized_term: "degree in business, operations, supply chain, management, science, technology, engineering, or math",
  is_hard_requirement: "HARD",
};

{
  const b = fitOf([GOPUFF_DEGREE]);
  const scoring = b.concepts.filter((c) => c.weight > 0);
  check("the Gopuff degree requirement is ONE concept, not eight",
    scoring.length === 1, `got ${scoring.length}: ${scoring.map((c) => c.concept).join(" | ")}`);

  const c = scoring[0]!;
  check("it is credited once", b.creditedCount === 1, `creditedCount=${b.creditedCount}`);
  check("it is satisfied", c.resolution === "DIRECT", `${c.resolution}: ${c.rationale}`);
  check("the satisfying branch is science, not business",
    c.satisfiedBranch === "science", `satisfiedBranch=${JSON.stringify(c.satisfiedBranch)}`);
  check("no label claims a business degree",
    !/degree in business\b/i.test(c.displayLabel ?? ""), `label=${c.displayLabel}`);
  check("the label names the branch actually met",
    (c.displayLabel ?? "").includes('met via "science"'), `label=${c.displayLabel}`);
  check("no bare 'science' concept exists to be credited on its own",
    !scoring.some((x) => x.concept === "science"), scoring.map((x) => x.concept).join(" | "));
  check("no bare 'technology' concept exists either",
    !scoring.some((x) => x.concept === "technology"), scoring.map((x) => x.concept).join(" | "));
  check("no 'or math' artifact concept exists",
    !scoring.some((x) => /^or\b/i.test(x.concept)), scoring.map((x) => x.concept).join(" | "));
}

// -- a field-specific degree the profile does NOT hold ----------------
{
  const b = fitOf([{ id: "r2", raw_text: "Bachelor's degree in Computer Science",
    normalized_term: "degree in computer science", is_hard_requirement: "HARD" }]);
  const c = b.concepts.filter((x) => x.weight > 0)[0]!;
  check("an unrelated field-specific degree is not satisfied",
    c.resolution === "ABSENT", `${c.resolution}: ${c.rationale}`);
}

// -- an OR-list with no acceptable branch -----------------------------
{
  const b = fitOf([{ id: "r3",
    raw_text: "Degree in Computer Science, Electrical Engineering, or Mathematics",
    normalized_term: "degree in computer science, electrical engineering, or mathematics",
    is_hard_requirement: "HARD" }]);
  const c = b.concepts.filter((x) => x.weight > 0)[0]!;
  check("an OR-list of fields the degree does not sit in is ABSENT",
    c.resolution === "ABSENT", `${c.resolution}: ${c.rationale}`);
  check("an unsatisfied OR-list names no branch",
    !c.satisfiedBranch, `satisfiedBranch=${JSON.stringify(c.satisfiedBranch)}`);
  check("its label does not assert any single field",
    !/^degree in computer science$/i.test(c.displayLabel ?? ""), `label=${c.displayLabel}`);
}

// -- an OR-list that IS legitimately satisfied, via a different branch -
{
  const b = fitOf([{ id: "r4",
    raw_text: "Bachelor's degree in Nursing, Public Health, or a related field",
    normalized_term: "degree in nursing, public health, or a related field",
    is_hard_requirement: "HARD" }]);
  const c = b.concepts.filter((x) => x.weight > 0)[0]!;
  check("a public-health branch legitimately satisfies the requirement",
    c.resolution === "DIRECT", `${c.resolution}: ${c.rationale}`);
  check("and it is reported as public health, not nursing",
    c.satisfiedBranch === "public health" && !/met via "nursing"/i.test(c.displayLabel ?? ""),
    `branch=${c.satisfiedBranch} label=${c.displayLabel}`);
}

// -- a genuine AND list still splits ----------------------------------
{
  const b = fitOf([{ id: "r5", raw_text: "Strong experience with Python, SQL and data modeling",
    normalized_term: "python, sql and data modeling", is_hard_requirement: "HARD" }]);
  const scoring = b.concepts.filter((x) => x.weight > 0);
  check("a conjunction of skills is still several concepts",
    scoring.length === 3, `got ${scoring.length}: ${scoring.map((c) => c.concept).join(" | ")}`);
}

// -- a degree field list must not merge with an experience list -------
{
  const b = fitOf([
    { id: "r6", raw_text: "10+ years of relevant experience in retail, supply chain, operations, consulting, or data-driven project management",
      normalized_term: "experience in retail, supply chain, operations, consulting, or data-driven project management",
      is_hard_requirement: "HARD" },
    GOPUFF_DEGREE,
  ]);
  const scoring = b.concepts.filter((x) => x.weight > 0);
  check("two OR requirements stay two concepts",
    scoring.length === 2, `got ${scoring.length}: ${scoring.map((c) => c.displayLabel).join(" | ")}`);
  check("the degree requirement is still credited",
    scoring.some((c) => c.requirementClass === "EDUCATION" && c.resolution === "DIRECT"),
    scoring.map((c) => `${c.requirementClass}:${c.resolution}`).join(" | "));
  check("total credited is at most the number of requirements",
    b.creditedCount <= 2, `creditedCount=${b.creditedCount}`);
}

// -- generic degree requirements are untouched ------------------------
{
  const b = fitOf([{ id: "r7", raw_text: "Bachelor's degree required",
    normalized_term: "bachelor's degree", is_hard_requirement: "HARD" }]);
  const c = b.concepts.filter((x) => x.weight > 0)[0]!;
  check("a generic degree requirement is still satisfied",
    c.resolution === "DIRECT", `${c.resolution}: ${c.rationale}`);
  check("and carries no alternatives", !c.alternatives, JSON.stringify(c.alternatives));
}

// -- degree LEVEL is also an OR-list ----------------------------------
//
// "J.D. or graduate degree" was read as BACHELOR, because none of the
// level patterns matched "Juris Doctor" and the fallback was a
// bachelor's. A verified B.S. then satisfied it outright.
{
  const b = fitOf([{ id: "r8", raw_text: "Must have Licensed Customs Broker required, J.D. or graduate degree",
    normalized_term: "juris doctor (j.d.) or graduate degree", is_hard_requirement: "HARD" }]);
  const c = b.concepts.filter((x) => x.weight > 0)[0]!;
  check("a J.D.-or-graduate requirement is not met by a bachelor's",
    c.resolution !== "DIRECT", `${c.resolution}: ${c.rationale}`);
  check("and it is read as a graduate-level requirement",
    c.educationLevel === "MASTER" || c.educationLevel === "DOCTORATE", `level=${c.educationLevel}`);
}

// The mirror case: a list of acceptable levels asks for its LOWEST.
{
  const b = fitOf([{ id: "r9", raw_text: "BS, MS, or PhD in Computer Science or other related technical degree",
    normalized_term: "computer science or related technical degree", is_hard_requirement: "HARD" }]);
  const c = b.concepts.filter((x) => x.weight > 0)[0]!;
  check("BS, MS or PhD asks for a bachelor's, not a doctorate",
    c.educationLevel === "BACHELOR", `level=${c.educationLevel}`);
  check("and the unrelated field still fails it",
    c.resolution === "ABSENT", `${c.resolution}: ${c.rationale}`);
}

// A single stated level is still that level, not something lower.
{
  const b = fitOf([{ id: "r10", raw_text: "Master's degree in Public Health required",
    normalized_term: "master's degree in public health", is_hard_requirement: "HARD" }]);
  const c = b.concepts.filter((x) => x.weight > 0)[0]!;
  check("a master's-only requirement stays MASTER", c.educationLevel === "MASTER", `level=${c.educationLevel}`);
  check("and a bachelor's does not satisfy it, even in an encompassing field",
    c.resolution !== "DIRECT", `${c.resolution}: ${c.rationale}`);
}

// -- a dangling conjunction is never a concept ------------------------
{
  const b = fitOf([{ id: "r11", raw_text: "Experience with a NetSuite partnership", 
    normalized_term: "or netsuite partnership", is_hard_requirement: "HARD" }]);
  const c = b.concepts.filter((x) => x.weight > 0)[0]!;
  check("a term arriving with a leading 'or' is normalized",
    !/^or\b/i.test(c.concept), `concept=${JSON.stringify(c.concept)}`);
}

// -- "and/or" is one conjunction, not a slash pair --------------------
{
  const b = fitOf([{ id: "r12",
    raw_text: "Direct experience working with Workday and/or NetSuite in an alliances or technology partner capacity",
    normalized_term: "workday and/or netsuite partnership experience", is_hard_requirement: "HARD" }]);
  const scoring = b.concepts.filter((x) => x.weight > 0);
  check("and/or does not split into a dangling conjunction",
    !scoring.some((c) => /^(or|and)\b/i.test(c.concept)) && !scoring.some((c) => /\band$/i.test(c.concept)),
    scoring.map((c) => c.concept).join(" | "));
  check("and it stays one requirement", scoring.length === 1,
    `got ${scoring.length}: ${scoring.map((c) => c.concept).join(" | ")}`);
}

// -- one sentence, several extracted rows, one demand -----------------
//
// The extractor emits a row per branch of a list. TRM Labs "Head of
// Corporate FP&A" produced four education rows from a single sentence,
// which scored as four unmet qualifications for one preference.
const TRM_RAW = "Degree in Finance, Accounting, Economics, or Business Administration preferred; MBA a plus";
{
  const b = fitOf([
    { id: "t1", raw_text: TRM_RAW, normalized_term: "degree in finance", is_hard_requirement: "PREFERRED" },
    { id: "t2", raw_text: TRM_RAW, normalized_term: "degree in accounting", is_hard_requirement: "PREFERRED" },
    { id: "t3", raw_text: TRM_RAW, normalized_term: "degree in economics", is_hard_requirement: "PREFERRED" },
    { id: "t4", raw_text: TRM_RAW, normalized_term: "degree in business administration", is_hard_requirement: "PREFERRED" },
  ]);
  const ed = b.concepts.filter((c) => c.requirementClass === "EDUCATION");
  check("four rows from one sentence become one demand", ed.length === 1,
    `got ${ed.length}: ${ed.map((c) => c.concept).join(" | ")}`);
  check("the merged demand cites all four rows",
    (ed[0]?.requirementIds.length ?? 0) === 4, JSON.stringify(ed[0]?.requirementIds));
  check("and it lists them as alternatives",
    (ed[0]?.alternatives?.length ?? 0) === 4, JSON.stringify(ed[0]?.alternatives));
  check("an unsatisfied merged demand costs one unit, not four",
    b.concepts.filter((c) => c.requirementClass === "EDUCATION" && c.credit === 0).length <= 1,
    `${b.concepts.filter((c) => c.requirementClass === "EDUCATION").map((c) => c.resolution).join(",")}`);
}

// The satisfied direction of the same invariant.
{
  const RAW = "Degree in Biology, Chemistry, or Health Science preferred";
  const b = fitOf([
    { id: "s1", raw_text: RAW, normalized_term: "degree in biology", is_hard_requirement: "PREFERRED" },
    { id: "s2", raw_text: RAW, normalized_term: "degree in chemistry", is_hard_requirement: "PREFERRED" },
    { id: "s3", raw_text: RAW, normalized_term: "degree in health science", is_hard_requirement: "PREFERRED" },
  ]);
  const ed = b.concepts.filter((c) => c.requirementClass === "EDUCATION");
  check("a satisfied merged demand is also one concept", ed.length === 1, `got ${ed.length}`);
  check("it is credited once", b.creditedCount === 1, `creditedCount=${b.creditedCount}`);
  check("and names the branch that satisfied it",
    ed[0]?.satisfiedBranch === "health science", `branch=${ed[0]?.satisfiedBranch}`);
}

// -- boundaries: what must NOT merge ----------------------------------
{
  // One sentence, two routes at different levels. Collapsing them means
  // deciding which level the requirement is, which is a judgement.
  const RAW = "Bachelor's degree in Accounting + CPA license or Master's degree in Accounting";
  const b = fitOf([
    { id: "f1", raw_text: RAW, normalized_term: "bachelor's degree in accounting", is_hard_requirement: "HARD" },
    { id: "f2", raw_text: RAW, normalized_term: "master's degree in accounting", is_hard_requirement: "HARD" },
  ]);
  const ed = b.concepts.filter((c) => c.requirementClass === "EDUCATION");
  check("two levels in one sentence stay separate", ed.length === 2,
    `got ${ed.length}: ${ed.map((c) => `${c.educationLevel}:${c.concept}`).join(" | ")}`);
}
{
  // Required floor and preferred stronger degree are two demands.
  const b = fitOf([
    { id: "p1", raw_text: "Bachelor's degree required", normalized_term: "bachelor's degree", is_hard_requirement: "HARD" },
    { id: "p2", raw_text: "MBA a plus but not required", normalized_term: "mba", is_hard_requirement: "PREFERRED" },
  ]);
  const ed = b.concepts.filter((c) => c.requirementClass === "EDUCATION");
  check("a required degree and a preferred one stay separate", ed.length === 2,
    `got ${ed.length}: ${ed.map((c) => c.concept).join(" | ")}`);
}
{
  // Same wording, different sentences, different hardness.
  const b = fitOf([
    { id: "h1", raw_text: "Bachelor of Science degree from a 4-year accredited university",
      normalized_term: "bachelor of science degree", is_hard_requirement: "HARD" },
    { id: "h2", raw_text: "Bachelor of Science degree or advanced education in Electrical Engineering, Computer Science, or related",
      normalized_term: "degree in electrical engineering or computer science", is_hard_requirement: "PREFERRED" },
  ]);
  const ed = b.concepts.filter((c) => c.requirementClass === "EDUCATION");
  check("a generic requirement and a field-specific preference stay separate",
    ed.length === 2, `got ${ed.length}: ${ed.map((c) => c.concept).join(" | ")}`);
}

// -- a product name is not a degree -----------------------------------
{
  const b = fitOf([{ id: "x1", raw_text: "Advanced skills in Google Sheets and/or MS Excel",
    normalized_term: "advanced skills in google sheets and/or ms excel", is_hard_requirement: "HARD" }]);
  check("MS Excel is not a master's degree requirement",
    !b.concepts.some((c) => c.requirementClass === "EDUCATION"),
    b.concepts.map((c) => `${c.requirementClass}:${c.concept}`).join(" | "));
}

console.log(`${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
