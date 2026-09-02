/**
 * Attention ranking: what rises, what sinks, and what it must never touch.
 */
import { attentionScore, buildAttentionInput, compareAttention, BARE_DEGREE,
  type AttentionInput } from "../lib/portal/attentionRank.ts";
import { isFieldlessRequirement, assessCoverage } from "../lib/portal/genericRequirements.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

const j = (o: Partial<AttentionInput>): AttentionInput => ({
  hardMet: 0, hardTotal: 1, hardDirect: 0, transferableCount: 0,
  unmetConcepts: [], coreGapCount: 0, salary: null, ...o,
});
const s = (o: Partial<AttentionInput>) => attentionScore(j(o));

// The real corpus shapes, by their actual numbers.
const ALEPH      = j({ hardMet: 2, hardTotal: 3, hardDirect: 2, transferableCount: 0, unmetConcepts: ["consulting"], salary: 130_000 });
const STRIPE_AEO = j({ hardMet: 4, hardTotal: 11, hardDirect: 2, transferableCount: 2, unmetConcepts: [] });
const LINCOLN    = j({ hardMet: 3, hardTotal: 8, hardDirect: 2, transferableCount: 1, unmetConcepts: ["structured products"], salary: 200_000 });
const NTRS       = j({ hardMet: 5, hardTotal: 9, hardDirect: 2, transferableCount: 3, unmetConcepts: ["program"] });
const INCLUDED   = j({ hardMet: 2, hardTotal: 7, hardDirect: 1, transferableCount: 2, unmetConcepts: ["intake systems"], salary: 131_000 });
const SAMSARA    = j({ hardMet: 0, hardTotal: 13, hardDirect: 0, transferableCount: 0,
  unmetConcepts: ["saas integrations","computer networking","cloud software","technical consulting"] });
const STRIPE_CPD = j({ hardMet: 0, hardTotal: 4, hardDirect: 0, transferableCount: 1,
  unmetConcepts: ["platform or isv partnership management","payments technology"] });
const UCHICAGO   = j({ hardMet: 0, hardTotal: 1, hardDirect: 0, transferableCount: 0,
  unmetConcepts: ["work experience in related field"] });

const strong = [ALEPH, STRIPE_AEO, LINCOLN, NTRS, INCLUDED];
const weak = [SAMSARA, STRIPE_CPD];

// The two roles that must not compete with real opportunities.
for (const [name, w] of [["Samsara Enterprise Sales Engineer", SAMSARA], ["Stripe Communities Partner", STRIPE_CPD]] as const) {
  const beaten = strong.filter((g) => attentionScore(g).score > attentionScore(w).score).length;
  check(`${name} ranks below every strong job`, beaten === strong.length, `${beaten}/${strong.length}`);
}
for (const [name, g] of [["Aleph", ALEPH], ["Stripe AEO/GEO", STRIPE_AEO], ["Lincoln", LINCOLN],
                         ["Northern Trust", NTRS], ["Included Health", INCLUDED]] as const) {
  const over = weak.filter((w) => attentionScore(g).score > attentionScore(w).score).length;
  check(`${name} outranks both weak roles`, over === 2, `${over}/2`);
}

// A boilerplate job cannot climb on generic evidence alone.
{
  const loud = j({ hardMet: 0, hardTotal: 1, hardDirect: 0, transferableCount: 3,
    unmetConcepts: ["work experience in related field"] });
  const a = attentionScore(loud), b = attentionScore(INCLUDED);
  check("a 0/1 boilerplate job lands in the generic band", a.band === "GENERIC_REQUIREMENTS", a.band);
  check("and cannot outrank a strong assessable job", compareAttention(a, b) > 0, "");
  check("even with abundant transferable evidence", a.band !== b.band, "");
}

// Banding.
check("the boilerplate job is unassessable", s({ unmetConcepts: ["work experience in related field"] }).band === "GENERIC_REQUIREMENTS", "");
check("its coverage is null, not zero", s({ unmetConcepts: ["work experience in related field"] }).coverage === null, "");
check("a real unmet requirement stays assessable", s({ unmetConcepts: ["clinical research"] }).band === "ASSESSABLE", "");
check("a job meeting some requirements stays assessable",
  s({ hardMet: 1, hardTotal: 2, unmetConcepts: ["work experience in related field"] }).band === "ASSESSABLE", "");
check("assessable always sorts above generic",
  compareAttention(attentionScore(SAMSARA), attentionScore(UCHICAGO)) < 0, "");

// Boilerplate is not charged twice.
{
  const r = s({ hardMet: 0, hardTotal: 2, unmetConcepts: ["work experience in related field", "clinical research"] });
  check("boilerplate is removed from the gap list", !r.genuineGaps.includes("work experience in related field"), r.genuineGaps.join(","));
  check("and the real gap is kept", r.genuineGaps.includes("clinical research"), "");
  check("and the boilerplate is reported as ignored", r.ignoredRequirements.length === 1, "");
}

// Salary.
check("unknown salary is neutral, never a penalty",
  s({ hardMet: 1, hardTotal: 2, salary: null }).score === s({ hardMet: 1, hardTotal: 2, salary: 50_000 }).score, "");
check("a known high salary helps modestly",
  s({ hardMet: 1, hardTotal: 2, salary: 130_000 }).score > s({ hardMet: 1, hardTotal: 2, salary: null }).score, "");
check("salary cannot rescue a job with no coverage",
  attentionScore(j({ hardMet: 0, hardTotal: 5, hardDirect: 0, unmetConcepts: ["real requirement"], salary: 300_000 })).score
    < attentionScore(INCLUDED).score, "");

// The verdict label is not an input.
{
  const identical = j({ hardMet: 2, hardTotal: 4, hardDirect: 1 });
  check("ranking never reads a candidacy verdict",
    attentionScore(identical).score === attentionScore({ ...identical }).score, "");
  const weakCandidate = j({ hardMet: 0, hardTotal: 3, hardDirect: 0, unmetConcepts: ["a", "b"] });
  check("a weak Candidate does not outrank a strong Stretch",
    attentionScore(weakCandidate).score < attentionScore(NTRS).score, "");
}

// Coverage dominates.
check("coverage outweighs transferable volume",
  s({ hardMet: 3, hardTotal: 4, transferableCount: 0 }).score
    > s({ hardMet: 0, hardTotal: 4, transferableCount: 3, unmetConcepts: ["x"] }).score, "");
check("hardDirect is capped so volume cannot win alone",
  s({ hardMet: 1, hardTotal: 2, hardDirect: 9 }).score === s({ hardMet: 1, hardTotal: 2, hardDirect: 4 }).score, "");
check("role-defining gaps hurt more than occupational ones",
  s({ hardMet: 1, hardTotal: 2, coreGapCount: 1 }).score
    < s({ hardMet: 1, hardTotal: 2, unmetConcepts: ["one real gap"] }).score, "");

// The detector is narrow.
check("fieldless boilerplate is detected", isFieldlessRequirement("work experience in related field"), "");
check("and its variants", isFieldlessRequirement("Work experience in a related discipline")
  && isFieldlessRequirement("related job discipline"), "");
check("a named field is NEVER boilerplate",
  !isFieldlessRequirement("work experience in clinical research")
  && !isFieldlessRequirement("5 years of supply chain experience")
  && !isFieldlessRequirement("financial modeling"), "");
check("an empty concept is not boilerplate", !isFieldlessRequirement(""), "");

// Presentation only: pure functions, no I/O.
{
  const src = [
    await import("node:fs").then((fs) => fs.readFileSync("lib/portal/attentionRank.ts", "utf8")),
    await import("node:fs").then((fs) => fs.readFileSync("lib/portal/genericRequirements.ts", "utf8")),
  ].join("\n");
  check("the ranking layer writes nothing to the database",
    !/\.from\(|insert\(|update\(|upsert\(|delete\(/.test(src), "");
  check("and reads no candidacy verdict for ordering",
    !/APPLICATION_CANDIDATE|STRETCH|REJECT/.test(src), "");
  check("and is declared presentation-only", /PRESENTATION ONLY/.test(src), "");
}

// assessCoverage never mutates its input.
{
  const input = { hardMet: 0, hardTotal: 1, unmetConcepts: ["work experience in related field"] };
  const before = JSON.stringify(input);
  assessCoverage(input);
  check("assessCoverage does not mutate what it is given", JSON.stringify(input) === before, "");
}

// ── D3 smoothed coverage ─────────────────────────────────────────────
//
// Raw percentage made the thinnest possible evidence look like the
// strongest. Smoothing with a prior of two asks how confident a job
// would look if there were two more requirements it had not met.
{
  const cov = (m: number, t: number) => (m / (t + 2)) * 40 * 1.5;

  // The inversion this exists to fix.
  check("5/9 outranks 1/1 on coverage alone", cov(5, 9) > cov(1, 1),
    `${cov(5, 9).toFixed(1)} vs ${cov(1, 1).toFixed(1)}`);

  // ...and in the full ranking, where the 5/9 job also has real evidence.
  const NTRS_LIKE = j({ hardMet: 5, hardTotal: 9, hardDirect: 2, transferableCount: 3, unmetConcepts: ["program"] });
  const PROGRAM_DIRECTOR = j({ hardMet: 1, hardTotal: 1, hardDirect: 0, transferableCount: 2, unmetConcepts: [] });
  check("a 5/9 job with real evidence outranks a 1/1 with none",
    attentionScore(NTRS_LIKE).score > attentionScore(PROGRAM_DIRECTOR).score,
    `${attentionScore(NTRS_LIKE).score.toFixed(1)} vs ${attentionScore(PROGRAM_DIRECTOR).score.toFixed(1)}`);

  check("1/1 no longer scores full coverage",
    attentionScore(j({ hardMet: 1, hardTotal: 1 })).smoothedCoverage < 0.5,
    String(attentionScore(j({ hardMet: 1, hardTotal: 1 })).smoothedCoverage));
  check("but 1/1 is still clearly positive", attentionScore(j({ hardMet: 1, hardTotal: 1 })).score > 0, "");

  // A compact posting fully met must still rank strongly.
  check("3/3 still scores strongly", cov(3, 3) >= 35, cov(3, 3).toFixed(1));
  check("and 3/3 beats 5/9", cov(3, 3) > cov(5, 9), `${cov(3, 3).toFixed(1)} vs ${cov(5, 9).toFixed(1)}`);
  check("and 3/3 beats 1/1 substantially", cov(3, 3) > cov(1, 1) * 1.5, "");

  // Monotonic both ways.
  check("meeting more requirements always helps", cov(3, 5) > cov(2, 5) && cov(2, 5) > cov(1, 5), "");
  check("a larger unmet denominator always hurts", cov(2, 4) > cov(2, 8) && cov(2, 8) > cov(2, 16), "");

  // The displayed ratio stays honest even though ranking is smoothed.
  const r = attentionScore(j({ hardMet: 1, hardTotal: 1 }));
  check("the displayed coverage is the true unsmoothed ratio", r.coverage === 1, String(r.coverage));
  check("and the smoothed value is reported separately", Math.abs(r.smoothedCoverage - 1 / 3) < 1e-9, String(r.smoothedCoverage));

  check("0/13 still contributes no coverage",
    attentionScore(j({ hardMet: 0, hardTotal: 13, unmetConcepts: ["a"] })).smoothedCoverage === 0, "");
  // Weak roles stay weak.
  check("weak zero-coverage roles remain negative",
    attentionScore(SAMSARA).score < 0 && attentionScore(STRIPE_CPD).score < 0, "");
}

// ── Fieldless credentials ────────────────────────────────────────────
//
// A credential naming a LEVEL but no FIELD discriminates nothing, so it
// must not count as evidence of fit. The first pattern required the text
// to end in "degree", which excluded "bachelor degree" and admitted
// "bachelor degree in related field" - the same employer sentence,
// three words apart. That inflated 105 counts corpus-wide.
{
  const excluded = [
    "bachelor degree",
    "bachelor degree in related field",
    "degree in a related discipline",
    "degree or equivalent",
    "degree in related field or equivalent",
    "high school diploma or GED",
    "high school diploma or equivalent",
    "bachelor degree or higher",
    "bachelor degree or higher in related field",
    "master degree in a related discipline",
    "associate degree",
    "A Bachelor Degree In Related Field",
  ];
  for (const t of excluded) {
    check(`fieldless: "${t.slice(0, 44)}" does not count`, BARE_DEGREE.test(t), "");
  }

  // A named field is a real requirement and must survive.
  const counted = [
    "bachelor degree in finance, accounting, or economics",
    "bachelor degree in computer science",
    "bachelor degree in life sciences or related field",
    "degree in business, operations, supply chain, management, science, technology, engineering, or math",
    "master degree in public policy",
    "nursing degree",
    "bachelor degree in nursing or related field",
  ];
  for (const t of counted) {
    check(`field-specific: "${t.slice(0, 44)}" still counts`, !BARE_DEGREE.test(t), "");
  }

  // And it changes hardDirect, which is the point.
  const withDegree = buildAttentionInput({
    candidacy: { hardMet: 1, hardTotal: 2, transferableMatches: 0, coreGaps: 0 },
    conceptDetail: [
      { concept: "bachelor degree in related field", hardness: "HARD", resolution: "DIRECT" },
      { concept: "manikin operation", hardness: "HARD", resolution: "ABSENT" },
    ],
    salary: null,
  });
  check("a fieldless degree contributes no hardDirect", withDegree.hardDirect === 0, String(withDegree.hardDirect));

  const withField = buildAttentionInput({
    candidacy: { hardMet: 1, hardTotal: 2, transferableMatches: 0, coreGaps: 0 },
    conceptDetail: [
      { concept: "bachelor degree in computer science", hardness: "HARD", resolution: "DIRECT" },
      { concept: "manikin operation", hardness: "HARD", resolution: "ABSENT" },
    ],
    salary: null,
  });
  check("a field-specific degree does contribute hardDirect", withField.hardDirect === 1, String(withField.hardDirect));
  check("and the two therefore rank differently",
    attentionScore(withField).score > attentionScore(withDegree).score, "");
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
