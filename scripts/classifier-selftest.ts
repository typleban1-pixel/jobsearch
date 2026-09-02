/**
 * Regression tests for the requirement classifier.
 *
 * Every case below is a concrete failure found in the live corpus, not an
 * invented example. The four causes they cover:
 *
 *   1. a sibling requirement's words classifying this requirement
 *   2. "master" read as a degree when it is an ordinary verb or noun
 *   3. field extraction recognising only one of three word orders
 *   4. degree language elsewhere in a sentence overriding a constraint
 *
 * The negative cases matter as much as the positive ones: a fix that
 * classifies "high school diploma or equivalent" as a skill would pass
 * every travel case and still be wrong.
 */
import { classifyRequirement } from "../lib/scoring/requirementClass.ts";

interface Case {
  name: string;
  raw: string;
  term: string;
  siblings?: string[];
  expectClass: string;
  expectField?: string | null;
  expectLevel?: string | null;
  /** OTHER is UNDECLARED, so a credential landing there is a classifier miss. */
  expectFamily?: string;
}

const CASES: Case[] = [
  // 1 + 4. One sentence, two requirements. Neither may borrow the other's words.
  { name: "bachelor's + travel, the degree half", raw: "Bachelor's degree and willingness to travel",
    term: "bachelor's degree", siblings: ["travel willingness"], expectClass: "EDUCATION", expectField: null, expectLevel: "BACHELOR" },
  { name: "bachelor's + travel, the travel half", raw: "Bachelor's degree and willingness to travel",
    term: "travel willingness", siblings: ["bachelor's degree"], expectClass: "CONSTRAINT" },

  // 2. "master" as a verb, as a noun, and as an adjective.
  { name: "eager to master the Linux shell", raw: "You're comfortable in, or eager to master, the Linux shell, Git, and container tooling like Docker",
    term: "linux shell", siblings: ["git", "docker"], expectClass: "SKILL" },
  { name: "master of organization", raw: "master of organization who can prioritize and manage a large volume of tasks with minimal supervision",
    term: "organization and task management", expectClass: "SKILL" },
  { name: "master understanding of corporate IT", raw: "A master understanding of corporate IT and operational needs, with comfort working directly with corporate teams",
    term: "corporate it and operational", expectClass: "SKILL" },
  { name: "willing to learn and master platforms", raw: "willing to learn and master certain software and platforms that are used to execute affiliate programs",
    term: "affiliate marketing software and platforms", expectClass: "SKILL" },

  // 3. Field extraction, all three word orders.
  { name: "Bachelor of Science in Nursing", raw: "Bachelor of Science in Nursing (BSN) required",
    term: "bachelor of science in nursing", expectClass: "EDUCATION", expectField: "nursing", expectLevel: "BACHELOR" },
  { name: "Welding Engineering degree", raw: "Bachelor's degree in Welding Engineering",
    term: "welding engineering degree", expectClass: "EDUCATION", expectField: "welding engineering", expectLevel: "BACHELOR" },
  { name: "quantitative field degree", raw: "Bachelor's, Master's, or Ph.D. in a quantitative field (e.g. Statistics, Mathematics, Economics)",
    term: "quantitative field degree", expectClass: "EDUCATION", expectField: "quantitative" },
  { name: "degree in computer science", raw: "Bachelor's degree or higher in computer science",
    term: "computer science degree", expectClass: "EDUCATION", expectField: "computer science" },

  // The context fallback must still work where context is genuinely this
  // requirement's own. One requirement, no siblings.
  { name: "high school diploma or equivalent", raw: "High school diploma or equivalent (Associate's or Bachelor's degree is a plus)",
    term: "high school diploma or equivalent", expectClass: "EDUCATION", expectLevel: "HIGH_SCHOOL" },

  // Context may narrow a requirement out of Fit, never resolve one into
  // it. Each of these has degree language in a sentence that belongs to
  // an alternative or to a clause the extractor never emitted.
  { name: "PhD alternative does not make ML experience an education requirement",
    raw: "2+ years of experience as a machine learning engineer or a PhD in a relevant field",
    term: "machine learning engineering experience", expectClass: "SKILL" },
  { name: "advanced-degree alternative does not reclassify construction experience",
    raw: "7+ years of relevant construction experience or an advanced degree in engineering, construction, or facilities management",
    term: "construction experience", expectClass: "SKILL" },
  { name: "unextracted degree clause does not reclassify recruiting",
    raw: "5+ years of related experience with a Bachelor's degree, or equivalent experience",
    term: "recruiting", expectClass: "SKILL" },
  // "Diplomacy" begins with "diploma".
  { name: "Diplomacy is not a diploma", raw: "Diplomacy, tact, and poise under pressure when working through customer issues",
    term: "poise under pressure", expectClass: "SKILL" },
  { name: "diplomatically is not a diploma", raw: "Skilled at persuasively and diplomatically advocating complex policy positions",
    term: "policy advocacy", expectClass: "SKILL" },

  // Regressions the fix must not introduce.
  { name: "genuine credential still gates", raw: "Active RN license in the state of Ohio",
    term: "rn license", expectClass: "GATING_CREDENTIAL" },
  { name: "generic phrase still generic", raw: "Excellent written and verbal communication",
    term: "written and verbal communication", expectClass: "GENERIC" },
  { name: "trait still a trait", raw: "Comfortable with ambiguity and a bias for action",
    term: "comfort with ambiguity", expectClass: "TRAIT" },
  { name: "plain skill stays a skill", raw: "5+ years of experience with Salesforce",
    term: "salesforce", expectClass: "SKILL" },
  { name: "sibling degree does not make a tool an education requirement",
    raw: "strong working knowledge of GSuite, Salesforce, and MS-Office products, and a Bachelor's degree",
    term: "salesforce", siblings: ["gsuite", "ms office"], expectClass: "SKILL" },
  { name: "residency restriction is a constraint", raw: "Currently unable to consider candidates residing in the following states: CA, NY, GA",
    term: "residency restriction (excluded states)", expectClass: "CONSTRAINT" },
  { name: "vague field is not a field", raw: "Degree in Engineering or related technical field and 6+ years of relevant experience",
    term: "engineering degree", expectClass: "EDUCATION", expectField: "engineering" },
  // "degree" is an ordinary English word as well as a credential.
  // Both assert the same thing: the ordinary English "degree" must not
  // produce an education requirement. Where they land afterwards differs
  // because one sentence carries a trait marker and the other does not.
  { name: "a high degree of autonomy is not education", raw: "Ability to thrive with a high degree of autonomy and ownership",
    term: "autonomy and ownership", expectClass: "TRAIT" },
  { name: "degree of ambiguity is not education", raw: "Comfortable with a significant degree of ambiguity",
    term: "comfort with ambiguity", expectClass: "SKILL" },
  // An MD is a degree and a regulated credential. It must stay a credential.
  { name: "MD stays a gating credential", raw: "Medical Doctor (MD) or Doctor of Osteopathic Medicine (DO) degree",
    term: "md or do degree", expectClass: "GATING_CREDENTIAL", expectFamily: "CLINICAL" },
  // The reversed "X degree" pattern must not capture the degree words
  // themselves and shadow the field named after them.
  { name: "MBA or advanced degree in Supply Chain", raw: "MBA or advanced degree in Supply Chain, Business, or Engineering",
    term: "mba or advanced degree", expectClass: "EDUCATION", expectField: "Supply Chain, Business, or Engineering", expectLevel: "MASTER" },
  { name: "advanced degree with no field", raw: "Advanced degree (e.g., MBA, MHA, MS in Operations Research or Analytics) is a plus",
    term: "advanced degree", expectClass: "EDUCATION", expectField: null, expectLevel: "MASTER" },
];

let failed = 0;
console.log("requirement classifier\n");
for (const c of CASES) {
  const got = classifyRequirement(c.raw, c.term, c.siblings ?? []);
  const problems: string[] = [];
  if (got.requirementClass !== c.expectClass) problems.push(`class ${got.requirementClass}, expected ${c.expectClass}`);
  if (c.expectField !== undefined && got.educationField !== c.expectField)
    problems.push(`field ${JSON.stringify(got.educationField)}, expected ${JSON.stringify(c.expectField)}`);
  if (c.expectLevel !== undefined && got.educationLevel !== c.expectLevel)
    problems.push(`level ${got.educationLevel}, expected ${c.expectLevel}`);
  if (c.expectFamily !== undefined && got.credentialFamily !== c.expectFamily)
    problems.push(`family ${got.credentialFamily}, expected ${c.expectFamily}`);
  if (problems.length) failed++;
  console.log(`  ${problems.length ? "FAIL" : "PASS"}  ${c.name}`);
  for (const p of problems) console.log(`        ${p}`);
}
console.log(`\n${failed === 0 ? "all passed" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
