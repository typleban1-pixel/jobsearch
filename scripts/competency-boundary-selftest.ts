/**
 * Where a personal quality ends and a workplace responsibility begins.
 *
 * The extractor labels both TRAIT. Taxonomy 3 then took every TRAIT out
 * of Fit, which was right for "creativity" and wrong for
 * "cross-functional collaboration": one describes what someone is like,
 * the other describes work they were accountable for and can evidence.
 *
 * The rule must not become a way to reclassify soft requirements into
 * capabilities wholesale. Most of this file is the other direction.
 */
import { classifyRequirement, isDemonstrableCompetency, TAXONOMY_VERSION } from "../lib/scoring/requirementClass.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}\n         ${d}`); }
};
const asTrait = (term: string) => classifyRequirement(`Looking for ${term}`, term, [], "TRAIT").requirementClass;

check("the taxonomy version records the change", TAXONOMY_VERSION === 4, String(TAXONOMY_VERSION));

// ---- 1. competencies stay in Fit ---------------------------------------
const COMPETENCIES = [
  "cross-functional collaboration", "cross-department collaboration", "cross-team collaboration",
  "cross-functional communication", "cross-functional influence", "interdepartmental coordination",
  "stakeholder management", "stakeholder influence", "communication and stakeholder management",
  "communication and cross-functional collaboration", "systems thinking",
  "project leadership", "program management", "independent project ownership",
  "end-to-end project ownership and independence", "mentoring", "mentorship",
  "process improvement", "vendor management", "change management",
];
for (const t of COMPETENCIES) {
  check(`"${t.slice(0, 48)}" stays a capability`, asTrait(t) === "SKILL", asTrait(t));
  check(`  and is recognised as demonstrable`, isDemonstrableCompetency(t), "");
}

// ---- 2. genuine traits stay traits -------------------------------------
const TRAITS = [
  "self-motivation", "self-starter", "self-motivated", "creativity", "comfort with ambiguity",
  "ambiguity tolerance", "detail-oriented", "integrity", "adaptability", "enthusiasm",
  "positivity", "intellectual curiosity", "mission alignment", "drive and perseverance",
  "learning agility", "poise under pressure", "culture fit", "passion and tenacity",
  "coachability", "rapid onboarding ability", "process improvement orientation",
  "ability to work in fast-paced environment", "professional interpersonal interaction",
];
for (const t of TRAITS) {
  check(`"${t.slice(0, 48)}" is not a capability`, asTrait(t) !== "SKILL", asTrait(t));
  check(`  and is not treated as demonstrable`, !isDemonstrableCompetency(t), "");
}

// ---- 3. the dangerous direction ----------------------------------------
{
  // A disposition wearing a competency word must not slip through.
  for (const t of ["coachability", "eagerness to mentor", "desire to manage projects",
                   "willingness to collaborate cross-functionally", "passion for process improvement",
                   "interest in stakeholder management", "comfort with cross-functional work"]) {
    check(`"${t.slice(0, 46)}" is vetoed as a disposition`, !isDemonstrableCompetency(t), "");
  }
}

// ---- 4. nothing else moves ---------------------------------------------
{
  // Tools, credentials, education and technical skills are untouched:
  // the rule fires only where the extractor said TRAIT.
  const cases: Array<[string, string, string, string]> = [
    ["Experience with Salesforce", "salesforce", "TOOL", "SKILL"],
    ["Proficiency in SQL", "sql", "SKILL", "SKILL"],
    ["Registered nurse license required", "rn license", "CREDENTIAL", "GATING_CREDENTIAL"],
    ["Bachelor's Degree", "bachelor's degree", "EDUCATION", "EDUCATION"],
    ["5+ years of operations experience", "operations experience", "EXPERIENCE_YEARS", "SKILL"],
    ["Must reside in California", "california residency", "LOGISTICAL", "CONSTRAINT"],
    ["Experience with e-billing systems", "e-billing systems", "TOOL", "SKILL"],
  ];
  for (const [raw, term, kind, want] of cases) {
    const got = classifyRequirement(raw, term, [], kind as any).requirementClass;
    check(`${kind} "${term.slice(0, 32)}" is still ${want}`, got === want, got);
  }
  // A competency term labelled something other than TRAIT is unaffected,
  // because the override only ever fires on a TRAIT label.
  check("a LOGISTICAL competency-looking term is still a CONSTRAINT",
    classifyRequirement("On-site coordination", "on-site cross-team coordination", [], "LOGISTICAL").requirementClass === "CONSTRAINT", "");
}

// ---- 5. the override cannot create a gate ------------------------------
{
  const a = classifyRequirement("Mentoring experience", "mentoring", [], "TRAIT");
  check("an overruled TRAIT becomes SKILL, never a credential or degree",
    a.requirementClass === "SKILL", a.requirementClass);
  check("and no credential family is attached", a.credentialFamily === null, String(a.credentialFamily));
}

// ---- 6. omitting the kind is unchanged ---------------------------------
for (const t of ["cross-functional collaboration", "creativity", "self-motivation"]) {
  check(`"${t.slice(0, 40)}" without a kind still falls through to SKILL`,
    classifyRequirement(`Looking for ${t}`, t, [], null).requirementClass === "SKILL", "");
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
