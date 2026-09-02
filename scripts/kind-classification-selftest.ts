/**
 * The extractor's kind, and how far it is allowed to reach.
 *
 * The defect: classifyRequirement discarded job_requirements.kind and
 * defaulted every unrecognised requirement to SKILL. Half of all TRAIT
 * and LOGISTICAL requirements in the corpus -- 2,978 of 6,000 -- were
 * scored as missing professional capabilities. "Coachability" cost what
 * a missing licence costs.
 *
 * The fix is narrow and this file is mostly about its limits. A kind may
 * only take a requirement OUT of Fit. It may never manufacture a match,
 * never assign a gate, and never override text that positively decided
 * the class.
 */
import { classifyRequirement, TAXONOMY_VERSION } from "../lib/scoring/requirementClass.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}\n         ${d}`); }
};
const cls = (raw: string, term: string, kind: any = null, sib: string[] = []) =>
  classifyRequirement(raw, term, sib, kind);

check("the taxonomy version records the change", TAXONOMY_VERSION === 4, String(TAXONOMY_VERSION));

// ---- 1. the SpotHero requirements, exactly as extracted ---------------
const SPOTHERO: Array<[string, string, string, string]> = [
  ["Ability to work independently, with appropriate oversight, as well as part of a team of attorneys and business professionals",
   "independent work and collaboration", "TRAIT", "TRAIT"],
  ["Ability to work on several projects simultaneously with tight (but reasonable) deadlines",
   "multitasking and deadline management", "TRAIT", "TRAIT"],
  ["Detail-oriented problem solver who works well in a team environment and has excellent communication skills",
   "detail-oriented problem solver", "TRAIT", "TRAIT"],
  ["Excited to work in a start-up environment and to grow with the team",
   "startup environment comfort", "TRAIT", "TRAIT"],
  ["This role will be required to be present in the Chicago HQ office at least 1 day per week",
   "chicago office presence", "LOGISTICAL", "CONSTRAINT"],
];
for (const [raw, term, kind, want] of SPOTHERO) {
  const got = cls(raw, term, kind);
  check(`"${term.slice(0, 42)}" is ${want}, not a missing skill`,
    got.requirementClass === want, `${got.requirementClass} (${got.reason})`);
}

// ---- 2. the requirements that must STAY capabilities -------------------
const REAL: Array<[string, string, string]> = [
  ["3+ years of legal operations experience", "legal operations experience", "EXPERIENCE_YEARS"],
  ["Experience with e-billing systems", "e-billing systems", "TOOL"],
  ["Experience utilizing tools like OneTrust, Carta, Ironclad, and Jira", "onetrust, carta, ironclad, jira", "TOOL"],
  ["Demonstrated ability to identify and implement process improvements", "process improvement", "SKILL"],
  ["Experience with e-commerce or technology company", "e-commerce or technology industry experience", "DOMAIN"],
  ["Experience working in or closely with an in-house legal team", "in-house legal team experience", "EXPERIENCE_YEARS"],
  ["5+ years of operations experience", "operations experience", "EXPERIENCE_YEARS"],
];
for (const [raw, term, kind] of REAL) {
  const got = cls(raw, term, kind);
  check(`"${term.slice(0, 42)}" is still a SKILL`, got.requirementClass === "SKILL", `${got.requirementClass}`);
}

// ---- 3. a kind may never manufacture a match or a gate -----------------
{
  // The dangerous direction: a kind that would REMOVE a real gap, or
  // create a credential the text never stated.
  const a = cls("Registered nurse license required", "rn license", "TRAIT");
  check("a TRAIT label cannot demote a real gating credential",
    a.requirementClass === "GATING_CREDENTIAL", `${a.requirementClass}`);
  const b = cls("Bachelor's Degree", "bachelor's degree", "TRAIT");
  check("a TRAIT label cannot demote an education requirement",
    b.requirementClass === "EDUCATION", `${b.requirementClass}`);
  // The honest boundary: SKILL is the FALLBACK, not a positive match.
  // There is no skill pattern to protect, so a TRAIT label does move a
  // skill-looking term out of Fit. That is why the map covers only two
  // kinds, and why both were verified against the corpus first: of 1,081
  // distinct TRAIT terms that change class, none names a tool or
  // technology, and the most common are self-motivation, creativity and
  // comfort with ambiguity. The safety here rests on extractor accuracy
  // for these two labels, and this case records that dependency rather
  // than pretending it does not exist.
  const c = cls("Experience with Python and distributed systems", "python", "TRAIT");
  check("a TRAIT label DOES move an unmatched term, because SKILL is only the fallback",
    c.requirementClass === "TRAIT" && c.evidence === "KIND", `${c.requirementClass} (${c.evidence})`);
  check("and the same term keeps SKILL when the extractor labels it correctly",
    cls("Experience with Python", "python", "TOOL").requirementClass === "SKILL", "");
  const d = cls("Some unrecognised phrase entirely", "some unrecognised phrase entirely", "CREDENTIAL");
  check("a CREDENTIAL label cannot promote an unmatched phrase to a gate",
    d.requirementClass === "SKILL", `${d.requirementClass}`);
  const e = cls("Some unrecognised phrase entirely", "some unrecognised phrase entirely", "EDUCATION");
  check("an EDUCATION label cannot promote an unmatched phrase to a degree",
    e.requirementClass === "SKILL", `${e.requirementClass}`);
}

// ---- 4. kinds that must not change anything ----------------------------
for (const kind of ["SKILL", "TOOL", "DOMAIN", "EXPERIENCE_YEARS", "OTHER", "LEGAL", "CREDENTIAL", "EDUCATION"]) {
  const got = cls("An unrecognised capability phrase", "an unrecognised capability phrase", kind);
  check(`kind ${kind} still falls through to SKILL`, got.requirementClass === "SKILL", got.requirementClass);
}
{
  // LEGAL is deliberately untouched: its unmatched cases are genuinely mixed.
  const a = cls("Must maintain HIPAA compliance", "hipaa compliance", "LEGAL");
  check("a LEGAL label leaves hipaa compliance a skill", a.requirementClass === "SKILL", a.requirementClass);
}

// ---- 5. omitting the kind reproduces the old behaviour -----------------
for (const [raw, term] of [["Excited to work in a start-up environment", "startup environment comfort"],
                           ["Present in the Chicago HQ one day per week", "chicago office presence"]] as const) {
  check(`"${term.slice(0, 30)}" without a kind is unchanged from taxonomy 2`,
    cls(raw, term, null).requirementClass === "SKILL", cls(raw, term, null).requirementClass);
}

// ---- 6. the evidence field says where the decision came from -----------
{
  const k = cls("Excited to work in a start-up environment", "startup environment comfort", "TRAIT");
  check("a kind-decided class is marked KIND", k.evidence === "KIND", k.evidence);
  check("and explains itself", /extractor labelled TRAIT/.test(k.reason), k.reason);
  const t = cls("Bachelor's Degree", "bachelor's degree", "TRAIT");
  check("a text-decided class is still marked TERM", t.evidence === "TERM", t.evidence);
}

// ---- 7. logistics are not charged twice --------------------------------
{
  // Eligibility already ruled on where the job is. A LOGISTICAL
  // requirement must not also appear as an absent capability.
  for (const [raw, term] of [["Must reside in California", "california residency"],
                             ["On-site commitment required", "on-site commitment"],
                             ["Must be able to reach and extend arms overhead", "reach and extend arms overhead"],
                             ["In-office participation in Chicago", "in-office participation chicago"]] as const) {
    const got = cls(raw, term, "LOGISTICAL");
    check(`"${term.slice(0, 34)}" is a CONSTRAINT`, got.requirementClass === "CONSTRAINT", got.requirementClass);
  }
}

// ---- 8. real traits from the corpus ------------------------------------
for (const term of ["coachability", "commercial acumen", "executive presentation skills",
                    "problem-solving and ambiguity tolerance", "fast-paced team environment"]) {
  const got = cls(`Looking for ${term}`, term, "TRAIT");
  check(`"${term.slice(0, 38)}" is a TRAIT`, got.requirementClass === "TRAIT", got.requirementClass);
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
