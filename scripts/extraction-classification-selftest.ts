/**
 * Requirement extraction: the classification failures found in the
 * 2026-09-01 candidacy audit, locked down.
 *
 * These cover the deterministic layer. The prompt itself is checked for
 * the rules those failures required, since a prompt cannot be asserted
 * against without spending money on a model call.
 */
import { readFileSync } from "node:fs";
import { reconcileHardness, dedupeRequirements, EXTRACTION_VERSION } from "../lib/llm/extractRequirements.ts";
import { htmlToText } from "../lib/ingest/normalize/text.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

const req = (raw: string, hardness: string, term = "x", kind = "SKILL") =>
  ({ raw_text: raw, is_hard_requirement: hardness, normalized_term: term, kind });

// Lincoln International — 2027 Full-Time Associate (FDD/TAS Experience Required)
//
// The posting's own quote says "Minimum of 3+ years". The model returned
// PREFERRED because the requirement is specialized, and Model 3 then
// scored the job 2/4 on PowerPoint and a transferable project-management
// claim while the actual occupational demand sat unmet and uncounted.
{
  const r = reconcileHardness(req(
    "Minimum of 3+ years of Financial Due Diligence or M&A Transaction Advisory experience", "PREFERRED"));
  check("a quote saying \"Minimum of\" cannot stay PREFERRED", r.hardness === "HARD" && r.corrected, JSON.stringify(r));
}
{
  const r = reconcileHardness(req("At least 5 years of accounting and finance experience", "PREFERRED"));
  check("\"At least N years\" cannot stay PREFERRED", r.hardness === "HARD", JSON.stringify(r));
}
{
  const r = reconcileHardness(req("Experience with quality of earnings analysis is required", "PREFERRED"));
  check("an explicit \"is required\" cannot stay PREFERRED", r.hardness === "HARD", JSON.stringify(r));
}

// The correction must never run the other way.
{
  const r = reconcileHardness(req("Preferred: minimum 3 years in a Big 4 firm", "PREFERRED"));
  check("optional wording still wins over mandatory wording", r.hardness === "PREFERRED" && !r.corrected, JSON.stringify(r));
}
{
  const r = reconcileHardness(req("Big 4 experience is a plus", "PREFERRED"));
  check("\"a plus\" stays PREFERRED", r.hardness === "PREFERRED", JSON.stringify(r));
}
{
  const r = reconcileHardness(req("Strong communication skills", "HARD"));
  check("HARD is never demoted", r.hardness === "HARD" && !r.corrected, JSON.stringify(r));
}
{
  const r = reconcileHardness(req("Familiarity with Python", "PREFERRED"));
  check("a quote with no mandatory wording is left alone", r.hardness === "PREFERRED" && !r.corrected, JSON.stringify(r));
}

// Negated mandatory wording compels nothing.
//
// The first version of reconcileHardness matched "required" anywhere and
// promoted two postings that said the opposite of a requirement.
{
  const r = reconcileHardness(req(
    "You've ever started or run a business before (not a requirement)", "PREFERRED"));
  check("\"not a requirement\" is not promoted", r.hardness === "PREFERRED" && !r.corrected, JSON.stringify(r));
}
{
  const r = reconcileHardness(req(
    "While no prior experience with LLMs and AI is required, curiosity is essential", "PREFERRED"));
  check("\"no prior experience ... is required\" is not promoted", r.hardness === "PREFERRED" && !r.corrected, JSON.stringify(r));
}
{
  const r = reconcileHardness(req("A CPA is not required for this role", "PREFERRED"));
  check("an explicit \"is not required\" is not promoted", r.hardness === "PREFERRED", JSON.stringify(r));
}
{
  // The negation guard must not swallow genuine requirements.
  const r = reconcileHardness(req("Minimum of 3 years of experience is required", "PREFERRED"));
  check("a genuine requirement is still promoted alongside the guard", r.hardness === "HARD", JSON.stringify(r));
}

// Flexport — Customs Specialist
//
// Extraction emitted "Excellent communication, interpersonal, and
// organizational skills" three times as three TRAIT rows, inflating the
// requirement count and the trait share of the posting.
{
  const line = "Excellent communication, interpersonal, and organizational skills";
  const { kept, removed } = dedupeRequirements([
    req(line, "HARD", "communication", "TRAIT"),
    req(line, "HARD", "communication", "TRAIT"),
    req(line, "HARD", "communication", "TRAIT"),
  ]);
  check("three identical trait rows collapse to one", kept.length === 1 && removed === 2, `${kept.length}/${removed}`);
}
{
  // Distinct requirements that merely sit in one sentence stay distinct.
  const { kept, removed } = dedupeRequirements([
    req("3 years in customs brokerage", "HARD", "customs brokerage", "DOMAIN"),
    req("HTS classification", "HARD", "hts classification", "SKILL"),
  ]);
  check("genuinely distinct requirements are not merged", kept.length === 2 && removed === 0, `${kept.length}`);
}
{
  // Same term under two different kinds is two facts, not one.
  const { kept } = dedupeRequirements([
    req("PowerPoint", "PREFERRED", "powerpoint", "TOOL"),
    req("PowerPoint deck-building", "HARD", "powerpoint", "SKILL"),
  ]);
  check("the same term under different kinds stays separate", kept.length === 2, `${kept.length}`);
}
{
  // Collapsing must never soften.
  const { kept } = dedupeRequirements([
    req("accounting", "PREFERRED", "accounting", "DOMAIN"),
    req("accounting required", "HARD", "accounting", "DOMAIN"),
  ]);
  check("the surviving duplicate keeps the strongest hardness",
    kept.length === 1 && kept[0]!.is_hard_requirement === "HARD", JSON.stringify(kept));
}

// UChicago — Research Technician
//
// The minimum work-experience line was destroyed by HTML normalization
// before extraction ever saw it, leaving a bachelor's degree as the only
// requirement the posting appeared to make.
{
  const html = "<p><b>Work Experience:</b></p>Minimum requirements include knowledge and skills "
    + "developed through &lt; 2 years of work experience in a related job discipline."
    + "<p style=\"text-align:left\"><br /><b>Certifications:</b></p>";
  const t = htmlToText(html);
  check("the UChicago experience sentence survives normalization",
    t.includes("2 years of work experience in a related job discipline"), t);
  check("and it is not cut off at the decoded <", !/developed through\s*$/m.test(t), t);
  const r = reconcileHardness(req(
    "Minimum requirements include knowledge and skills developed through < 2 years of work experience in a related job discipline",
    "PREFERRED"));
  check("and once visible it classifies as HARD", r.hardness === "HARD", JSON.stringify(r));
}

// The prompt must carry the rules those failures required.
{
  const src = readFileSync(new URL("../lib/llm/extractRequirements.ts", import.meta.url), "utf8");
  check("the prompt states hardness is independent of specialization",
    /INDEPENDENT of every one of the following/.test(src) && /how specialized/.test(src), "");
  check("the prompt names section headings as the strongest signal",
    /Minimum Qualifications/.test(src) && /Preferred Qualifications/.test(src), "");
  check("the prompt forbids reasoning about a candidate",
    /must not reason about one/.test(src), "");
  check("the prompt forbids promoting generic tools without employer language",
    /Do not\s+promote generic tools/.test(src), "");
  check("the prompt carries a duplicate-capability rule",
    /One requirement per distinct capability/.test(src), "");
  check("the extraction version was raised past the contaminated output",
    EXTRACTION_VERSION >= 4, String(EXTRACTION_VERSION));
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
