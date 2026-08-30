/**
 * Properties the scorer must hold, asserted rather than assumed.
 *
 * Uses synthetic features on purpose: these are properties of a pure
 * function, and proving them should not depend on what happens to be in
 * the database today.
 */
import { scoreJob, reconcile, type WeightSet } from "../lib/scoring/score.ts";
import { TermMatcher } from "../lib/matching/match.ts";
import { buildFeatures } from "../lib/scoring/features.ts";
import { SEED_ALIASES } from "../lib/matching/aliases.ts";
import type { JobFeatures, ScoringProfile } from "../lib/scoring/types.ts";

const WEIGHTS: WeightSet = {
  fit: { hard_requirement_met: 12, hard_requirement_missing: -18, hard_requirement_unclear: 0,
         preferred_requirement_met: 4, preferred_requirement_missing: -2, seniority_match: 8 },
  opportunity: { salary_above_target: 14, salary_within_target: 8, salary_below_floor: -40,
                 remote_preferred: 10, chicagoland_onsite_ok: 6, equity_mentioned: 4,
                 quota_carrying: -6, travel_heavy: -8 },
  generalist: { breadth_of_domains: 6, cross_functional_language: 5, ownership_language: 5,
                narrow_single_domain: -6 },
  specialist: { deep_single_domain: 8, years_requirement_high: 6, breadth_of_domains: -4 },
  uncertainty: { per_unknown_field: 4, per_unclear_requirement: 6, eligibility_uncertain: 15,
                 salary_unknown: 10, no_requirements_extracted: 35 },
};

const aliases = SEED_ALIASES.map((a) => ({ alias: a.alias, canonical_term: a.canonical }));
const matcher = new TermMatcher(
  [{ id: "s1", name: "PostgreSQL", relatedTerms: ["relational databases", "SQL"] },
   { id: "s2", name: "TypeScript", relatedTerms: ["node"] }],
  aliases,
);

const profile: ScoringProfile = {
  profileVersion: 1,
  skills: [{ id: "s1", name: "PostgreSQL", relatedTerms: [], level: "EXPERIENCED", interest: "POSITIVE", importance: "CORE" },
           { id: "s2", name: "TypeScript", relatedTerms: [], level: "CAPABLE", interest: "POSITIVE", importance: "CORE" }],
  salaryHardFloor: 100000, salaryTargetMin: 120000, salaryTargetIdeal: 150000,
  targetMetros: ["Chicagoland"], acceptsRemote: true, preferences: [],
};

const emptyProfile: ScoringProfile = { ...profile, skills: [], salaryHardFloor: null,
  salaryTargetMin: null, salaryTargetIdeal: null };

function features(over: Partial<JobFeatures> = {}): JobFeatures {
  return buildFeatures({
    job: { eligibility: "ELIGIBLE", seniority: "SENIOR", manages_people: false,
           salary_min: 140000, salary_max: 170000, remote_policy: "FULLY_REMOTE",
           metro: "Chicagoland", mentions_equity: true, has_quota_or_commission: false,
           travel_requirement_pct: 0 },
    descriptionText: "You will own the roadmap end-to-end and partner with cross-functional teams.",
    requirements: [
      { id: "r1", normalized_term: "postgres", raw_text: "Postgres", is_hard_requirement: "HARD", minimum_years: 3, kind: "TOOL" },
      { id: "r2", normalized_term: "kubernetes", raw_text: "Kubernetes", is_hard_requirement: "HARD", minimum_years: null, kind: "TOOL" },
      { id: "r3", normalized_term: "ts", raw_text: "TypeScript", is_hard_requirement: "PREFERRED", minimum_years: null, kind: "SKILL" },
      { id: "r4", normalized_term: "leadership", raw_text: "Leadership", is_hard_requirement: "UNCLEAR", minimum_years: null, kind: "OTHER" },
    ],
    ...(over as any),
  }) as JobFeatures;
}

const checks: Array<[string, () => boolean, string]> = [];
const check = (name: string, fn: () => boolean, detail = "") => checks.push([name, fn, detail]);

const base = features();
const scored = scoreJob(base, profile, matcher, WEIGHTS, { weightsVersion: 1, extractionVersion: 1 });

check("reasons reconcile to every score", () => reconcile(scored).ok,
  reconcile(scored).problems.join("; "));

check("scoring is deterministic across runs", () => {
  const a = scoreJob(features(), profile, matcher, WEIGHTS, { weightsVersion: 1, extractionVersion: 1 });
  const b = scoreJob(features(), profile, matcher, WEIGHTS, { weightsVersion: 1, extractionVersion: 1 });
  return JSON.stringify(a) === JSON.stringify(b);
});

check("alias match resolves postgres -> PostgreSQL", () => {
  const m = matcher.match(base.requirements[0]!.term);
  return m.method !== "NONE" && m.skillName === "PostgreSQL";
}, `got ${matcher.match(base.requirements[0]!.term).method}`);

check("unmatched hard requirement is a miss, not a guess", () => {
  const m = matcher.match(base.requirements[1]!.term);
  return m.method === "NONE" && m.skillId === null;
});

check("job_features carry no profile-derived data", () =>
  !JSON.stringify(base.requirements).includes("matchMethod") &&
  !JSON.stringify(base.requirements).includes("matchedSkill"));

check("UNCLEAR requirement contributes exactly 0 to fit", () => {
  const unclearPoints = scored.reasons
    .filter((r) => r.dimension === "FIT" && r.kind === "HARD_REQUIREMENT_UNCLEAR")
    .reduce((a, r) => a + r.points, 0);
  return unclearPoints === 0;
});

check("UNCLEAR requirement does raise uncertainty", () =>
  scored.unclearRequirementCount === 1 &&
  scored.reasons.some((r) => r.dimension === "UNCERTAINTY" && r.kind === "HARD_REQUIREMENT_UNCLEAR"));

// The central invariant: unknown must be neutral, never negative.
const knownSalary = scoreJob(features(), profile, matcher, WEIGHTS, { weightsVersion: 1, extractionVersion: 1 });
const unknownSalary = scoreJob(
  buildFeatures({
    job: { eligibility: "ELIGIBLE", seniority: "SENIOR", manages_people: false,
           salary_min: null, salary_max: null, remote_policy: "FULLY_REMOTE",
           metro: "Chicagoland", mentions_equity: true, has_quota_or_commission: false,
           travel_requirement_pct: 0 },
    descriptionText: "You will own the roadmap end-to-end and partner with cross-functional teams.",
    requirements: [
      { id: "r1", normalized_term: "postgres", raw_text: "Postgres", is_hard_requirement: "HARD", minimum_years: 3, kind: "TOOL" },
      { id: "r2", normalized_term: "kubernetes", raw_text: "Kubernetes", is_hard_requirement: "HARD", minimum_years: null, kind: "TOOL" },
      { id: "r3", normalized_term: "ts", raw_text: "TypeScript", is_hard_requirement: "PREFERRED", minimum_years: null, kind: "SKILL" },
      { id: "r4", normalized_term: "leadership", raw_text: "Leadership", is_hard_requirement: "UNCLEAR", minimum_years: null, kind: "OTHER" },
    ],
  }),
  profile, matcher, WEIGHTS, { weightsVersion: 1, extractionVersion: 1 });

check("unknown salary does not reduce fit", () => unknownSalary.fit === knownSalary.fit,
  `${unknownSalary.fit} vs ${knownSalary.fit}`);
check("unknown salary removes the salary bonus but adds no penalty", () =>
  !unknownSalary.reasons.some((r) => r.kind === "SALARY_BELOW_FLOOR") &&
  unknownSalary.opportunity === knownSalary.opportunity - WEIGHTS["opportunity"]!["salary_above_target"]!,
  `${unknownSalary.opportunity} vs ${knownSalary.opportunity}`);
check("unknown salary raises uncertainty instead", () =>
  unknownSalary.uncertainty > knownSalary.uncertainty);

check("no substantive score has an UNCERTAINTY reason mixed in", () =>
  scored.reasons.filter((r) => r.dimension !== "UNCERTAINTY")
    .every((r) => r.kind !== "UNKNOWN_DATA"));

// An empty profile must produce misses, never invented matches.
// The matcher is built FROM the profile, so an empty profile gets an
// empty matcher. This is the pairing the old design silently broke.
const emptyMatcher = new TermMatcher([], aliases);
const emptyScored = scoreJob(base, emptyProfile, emptyMatcher, WEIGHTS, { weightsVersion: 1, extractionVersion: 1 });
check("empty profile fabricates no skill match", () =>
  !emptyScored.reasons.some((r) => r.kind === "HARD_REQUIREMENT_MET"));
check("empty profile scores lower on fit than a populated one", () =>
  emptyScored.fit <= scored.fit);
check("empty profile with no salary targets adds no salary points", () =>
  !emptyScored.reasons.some((r) => r.kind === "SALARY_MATCH"));

// Rescore path: new weights, same cached features, no refetch and no model.
const heavier: WeightSet = { ...WEIGHTS, fit: { ...WEIGHTS["fit"], hard_requirement_met: 24 } };
const rescored = scoreJob(base, profile, matcher, heavier, { weightsVersion: 2, extractionVersion: 1 });
check("rescoring under new weights changes the score", () => rescored.fit !== scored.fit);
check("rescoring reconciles too", () => reconcile(rescored).ok);
check("rescoring reuses the identical feature object", () => {
  const before = JSON.stringify(base);
  scoreJob(base, profile, matcher, heavier, { weightsVersion: 2, extractionVersion: 1 });
  return JSON.stringify(base) === before;
});

check("generalist and specialist are independent, not opposite", () => {
  const bothish = scoreJob(
    { ...base, deepDomainLanguage: true, crossFunctionalLanguage: true, distinctDomains: 3 },
    profile, matcher, WEIGHTS, { weightsVersion: 1, extractionVersion: 1 });
  return bothish.generalist > 0 && bothish.specialist !== 0;
});

check("specialist score is descriptive, never a fit penalty", () => {
  const deep = scoreJob({ ...base, deepDomainLanguage: true }, profile, matcher, WEIGHTS,
    { weightsVersion: 1, extractionVersion: 1 });
  return deep.fit === scored.fit;
});

let failed = 0;
console.log("scoring self-test\n");
for (const [name, fn, detail] of checks) {
  let ok = false; let err = "";
  try { ok = fn(); } catch (e) { err = String(e); }
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && (detail || err) ? `  (${detail || err})` : ""}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
console.log(`\nsample scores  fit=${scored.fit} opportunity=${scored.opportunity} ` +
  `generalist=${scored.generalist} specialist=${scored.specialist} uncertainty=${scored.uncertainty}`);
console.log(`reasons emitted: ${scored.reasons.length}`);
for (const r of scored.reasons) {
  console.log(`  ${r.dimension.padEnd(12)} ${String(r.points).padStart(5)}  ${r.kind.padEnd(26)} ${r.subject ?? ""}`);
}
process.exit(failed ? 1 : 0);
