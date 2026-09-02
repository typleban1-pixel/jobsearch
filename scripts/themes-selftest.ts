/**
 * What a posting contributes to resume selection, and what it must not.
 *
 * The failure this suite exists for: roleContext filtered on the stored
 * requirement_class column, nothing has ever written to that column, so
 * the filter matched nothing for every job and every tailored resume was
 * selected against a job title and an empty theme list. The classifier
 * was right about what belongs in a theme set; it was simply never asked.
 *
 * Runs offline against the classifier.
 */
import { classifyRequirement } from "../lib/scoring/requirementClass.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++; else fails.push(`  ${name}\n      ${detail}`);
};

/** The selection rule, as prepare.ts applies it. */
const ADMINISTRATIVE_CONDITION = /\b(?:onsite|on-site|in-office|in-person|hybrid|remote work|relocat|residency|commut|visa|sponsorship|work authorization|authorized to work|clearance|days? (?:a|per) week|per week|shift work|weekend|overtime|salary|compensation|pay range|drug (?:test|screen)|background check|valid driver)/i;

const themesOf = (reqs: Array<{ raw: string; term: string }>) => {
  const siblings = reqs.map((r) => r.term);
  const out: string[] = [];
  const excluded: Record<string, number> = {};
  for (const r of reqs) {
    if (!r.term.trim()) continue;
    const cls = classifyRequirement(r.raw, r.term, siblings).requirementClass;
    if (cls !== "SKILL") { excluded[cls] = (excluded[cls] ?? 0) + 1; continue; }
    if (ADMINISTRATIVE_CONDITION.test(r.term) || ADMINISTRATIVE_CONDITION.test(r.raw)) {
      excluded["ADMINISTRATIVE"] = (excluded["ADMINISTRATIVE"] ?? 0) + 1; continue;
    }
    if (!out.includes(r.term)) out.push(r.term);
  }
  return { terms: out.slice(0, 12), excluded };
};

// The real SpotHero posting, which is what exposed this.
const SPOTHERO = [
  { raw: "Bachelor's Degree", term: "bachelor's degree" },
  { raw: "3+ years of legal operations experience", term: "legal operations experience" },
  { raw: "5+ years of operations experience and an interest in the legal field", term: "operations experience" },
  { raw: "Self-starter, with high integrity", term: "self-starter" },
  { raw: "high integrity and ability to maintain confidentiality and discretion at all times", term: "integrity and discretion" },
  { raw: "Detail-oriented problem solver who works well in a team environment", term: "detail-oriented problem solver" },
  { raw: "works well in a team environment and has excellent communication skills", term: "teamwork and communication" },
  { raw: "Ability to work on several projects simultaneously with tight (but reasonable) deadlines", term: "multitasking and deadline management" },
  { raw: "Demonstrated ability to identify and implement process improvements", term: "process improvement" },
  { raw: "This position is ineligible for visa sponsorship", term: "us work authorization, no visa sponsorship" },
  { raw: "This role will be required to be present in the Chicago HQ office at least 1 day per week", term: "chicago hybrid onsite requirement" },
  { raw: "Experience utilizing tools like OneTrust, Carta, Ironclad, and Jira", term: "legal tooling" },
];

{
  const { terms, excluded } = themesOf(SPOTHERO);
  check("a posting with real requirements produces themes",
    terms.length > 0, JSON.stringify(terms));
  check("the work requirements become themes",
    terms.includes("multitasking and deadline management") && terms.includes("process improvement"),
    JSON.stringify(terms));

  check("a degree requirement does not become a theme",
    !terms.includes("bachelor's degree") && (excluded["EDUCATION"] ?? 0) >= 1, JSON.stringify(excluded));
  check("a work-authorization constraint does not",
    !terms.some((t) => /visa|authorization/.test(t)), JSON.stringify(terms));
  check("an onsite or location condition does not",
    !terms.some((t) => /chicago|onsite|hybrid/.test(t)), JSON.stringify(terms));
  check("a personal trait does not",
    !terms.includes("integrity and discretion"), JSON.stringify(terms));
  check("and neither does generic filler",
    !terms.includes("self-starter") && !terms.includes("teamwork and communication"), JSON.stringify(terms));
  check("every exclusion is accounted for by class, not silently dropped",
    Object.values(excluded).reduce((a, b) => a + b, 0) + terms.length === SPOTHERO.length,
    `${JSON.stringify(excluded)} + ${terms.length} vs ${SPOTHERO.length}`);
}

// Requirements that name the work, across other shapes of posting.
{
  const engineering = themesOf([
    { raw: "Experience with Apache Spark", term: "apache spark" },
    { raw: "Strong Python and SQL", term: "python" },
    { raw: "BS in a quantitative field", term: "quantitative field degree" },
    { raw: "Excellent communication", term: "communication" },
  ]);
  check("technical skills survive", engineering.terms.includes("apache spark") && engineering.terms.includes("python"),
    JSON.stringify(engineering.terms));
  check("the degree gate and the filler do not",
    !engineering.terms.includes("quantitative field degree") && !engineering.terms.includes("communication"),
    JSON.stringify(engineering.terms));

  const clinical = themesOf([
    { raw: "Board Certified NP or PA", term: "board certified nurse practitioner or physician assistant" },
    { raw: "Fully licensed to practice in New Jersey", term: "new jersey medical license" },
    { raw: "Experience with opioid use disorder treatment", term: "opioid use disorder experience" },
  ]);
  check("a regulated credential is not a theme",
    !clinical.terms.some((t) => /licen|board certified/.test(t)), JSON.stringify(clinical.terms));
  check("but the clinical work itself is",
    clinical.terms.includes("opioid use disorder experience"), JSON.stringify(clinical.terms));
}

// The two states that must never look like an ordinary run.
{
  const none = themesOf([]);
  check("a posting with no requirements yields no themes", none.terms.length === 0, "");
  const adminOnly = themesOf([
    { raw: "Bachelor's Degree", term: "bachelor's degree" },
    { raw: "Must be authorized to work in the US", term: "us work authorization" },
    { raw: "Excellent communication", term: "communication" },
  ]);
  check("a posting of nothing but conditions yields no themes",
    adminOnly.terms.length === 0, JSON.stringify(adminOnly.terms));
  check("and says which classes accounted for that",
    Object.keys(adminOnly.excluded).length > 0, JSON.stringify(adminOnly.excluded));
}

// The rule is on computed classification, never on the stored column.
{
  const src = await import("node:fs").then((fs) => fs.readFileSync("lib/applications/prepare.ts", "utf8"));
  check("the administrative exclusion lives in selection, not in the classifier",
    /ADMINISTRATIVE_CONDITION/.test(src)
    && !(await import("node:fs")).readFileSync("lib/scoring/requirementClass.ts", "utf8").includes("ADMINISTRATIVE_CONDITION"),
    "changing the classifier would move Fit scores corpus-wide");
  check("selection classifies in memory rather than reading requirement_class",
    /classifyRequirement\(/.test(src) && !/requirement_class === "SKILL"/.test(src), "");
  check("a themeless posting is reported rather than passing quietly",
    /themeless/.test(src) && /console\.warn/.test(src), "");
  check("the scorer receives the themes themselves, not the context sentence",
    /const contextTerms = themes\.terms\.length/.test(src), "");
  check("selection is deterministic: no randomness anywhere in the path",
    !/Math\.random/.test(src), "");
  check("provenance is still a separate gate from relevance",
    /auditClaim\(/.test(src) && /provenanceFailure/.test(src), "");
}

// ---- the stored classification columns are not a source of truth ----
//
// requirement_class, concept and taxonomy_version were added by
// migration 0015 and nothing has ever written to them. Reading one as
// though it were populated is the defect that made every tailored
// resume select against an empty theme set, so nothing outside the
// audit that measures the emptiness may read them again.
{
  const fs = await import("node:fs");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (!/node_modules|\.next|\.runs|\.git/.test(full)) walk(full); }
      else if (/\.tsx?$/.test(e.name)) files.push(full);
    }
  };
  for (const root of ["lib", "scripts", "app"]) { try { walk(root); } catch { /* app may not exist */ } }

  const strip = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
  // The audit script exists to measure that the columns are empty, and
  // this suite names them in its own assertions.
  const permitted = /requirement-class-audit\.ts$|themes-selftest\.ts$/;

  // The target is job_requirements.taxonomy_version, the dead column.
  // job_candidacy has a taxonomy_version of its own that IS read, and
  // must be: it is what makes a stored verdict stale when the classifier
  // changes. So the bare identifier is only an offence in a file that
  // also touches job_requirements; requirement_class exists nowhere else
  // and stays an unconditional offence.
  const offenders = files.filter((f) => !permitted.test(f)).filter((f) => {
    const src = strip(fs.readFileSync(f, "utf8"));
    if (/\brequirement_class\b/.test(src)) return true;
    // Only a taxonomy_version read FROM job_requirements is the dead
    // column. Every select against that table is inspected by its own
    // column list, so a file may name job_candidacy.taxonomy_version and
    // query job_requirements in the same breath without tripping this.
    const selects = [...src.matchAll(/from\(\s*["'`]job_requirements["'`]\s*\)\s*\.select\(\s*["'`]([^"'`]*)["'`]/g)]
      .map((m) => m[1] ?? "");
    return selects.some((cols) => /\btaxonomy_version\b/.test(cols));
  });
  check("nothing reads the stored requirement_class or taxonomy_version",
    offenders.length === 0, offenders.join(", "));

  const writers = files.filter((f) => {
    const src = strip(fs.readFileSync(f, "utf8"));
    return /(insert|update)\([^)]*requirement_class/.test(src);
  });
  check("and nothing writes them, so they cannot drift from the classifier",
    writers.length === 0, writers.join(", "));

  const prepare = strip(fs.readFileSync("lib/applications/prepare.ts", "utf8"));
  check("resume selection classifies from the requirement text",
    /classifyRequirement\(/.test(prepare), "");
}

// ---- allowance is a ceiling on relevant lines, not a quota ----------
{
  const fs = await import("node:fs");
  const src = fs.readFileSync("lib/render/tailoredDoc.ts", "utf8");
  // The allocator now hands out slots against pools, so the property
  // lives in how a pool is built rather than in a Math.min over a
  // "relevant" count. What must remain true is that nothing scoring zero
  // is ever in a pool, and that the opening allocation is bounded by the
  // number of scoring lines rather than by the ceiling alone.
  check("the ceiling counts only lines with measured relevance",
    /pool: x\.scored\.filter\(\(s\) => s\.score > 0\)/.test(src)
    && /taken: Math\.min\(x\.scored\.filter\(\(s\) => s\.score > 0\)\.length/.test(src)
    && /if \(x\.score === 0\)/.test(src), "");
  check("and a trade can never hand a slot to a claim scoring zero",
    /const relevant = x\.scored\.filter\(\(s\) => s\.score > 0\)\.length/.test(src), "");
  check("and a line dropped for having no relevance says so, distinctly from one that lost on rank",
    /no measured relevance to this posting/.test(src) && /said less about this posting/.test(src), "");
}

console.log(`${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
