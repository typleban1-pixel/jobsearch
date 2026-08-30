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
                 salary_unknown: 10, no_requirements_extracted: 35,
                 per_unmatched_trait: 1, per_unevaluated_constraint: 3 },
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
  workAuthorization: "US citizen", requiresSponsorship: false, country: "US",
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
      // Skill-matchable on purpose. An UNCLEAR TRAIT is skipped before
      // hardness is ever examined, so using one here would have made this
      // assertion vacuous.
      { id: "r4", normalized_term: "salesforce", raw_text: "Salesforce", is_hard_requirement: "UNCLEAR", minimum_years: null, kind: "TOOL" },
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
      // Skill-matchable on purpose. An UNCLEAR TRAIT is skipped before
      // hardness is ever examined, so using one here would have made this
      // assertion vacuous.
      { id: "r4", normalized_term: "salesforce", raw_text: "Salesforce", is_hard_requirement: "UNCLEAR", minimum_years: null, kind: "TOOL" },
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

// The pilot's failure mode, asserted so it cannot come back.
const withTrait = buildFeatures({
  job: { eligibility: "ELIGIBLE", seniority: "SENIOR", manages_people: false,
         salary_min: 140000, salary_max: 170000, remote_policy: "FULLY_REMOTE",
         metro: "Chicagoland", mentions_equity: true, has_quota_or_commission: false,
         travel_requirement_pct: 0 },
  descriptionText: "You will own the roadmap end-to-end and partner with cross-functional teams.",
  requirements: [
    { id: "r1", normalized_term: "postgres", raw_text: "Postgres", is_hard_requirement: "HARD", minimum_years: 3, kind: "TOOL" },
    { id: "t1", normalized_term: "growth mindset", raw_text: "A growth mindset", is_hard_requirement: "HARD", minimum_years: null, kind: "TRAIT" },
    { id: "t2", normalized_term: "attention to detail", raw_text: "Attention to detail", is_hard_requirement: "HARD", minimum_years: null, kind: "TRAIT" },
    { id: "c1", normalized_term: "us work authorization", raw_text: "Must be authorized to work in the US", is_hard_requirement: "HARD", minimum_years: null, kind: "LEGAL" },
  ],
});
const traitScored = scoreJob(withTrait, profile, matcher, WEIGHTS, { weightsVersion: 2, extractionVersion: 2 });
const onlySkill = buildFeatures({
  job: { eligibility: "ELIGIBLE", seniority: "SENIOR", manages_people: false,
         salary_min: 140000, salary_max: 170000, remote_policy: "FULLY_REMOTE",
         metro: "Chicagoland", mentions_equity: true, has_quota_or_commission: false,
         travel_requirement_pct: 0 },
  descriptionText: "You will own the roadmap end-to-end and partner with cross-functional teams.",
  requirements: [
    { id: "r1", normalized_term: "postgres", raw_text: "Postgres", is_hard_requirement: "HARD", minimum_years: 3, kind: "TOOL" },
  ],
});
const skillOnlyScored = scoreJob(onlySkill, profile, matcher, WEIGHTS, { weightsVersion: 2, extractionVersion: 2 });

check("unmatched HARD traits cost nothing on fit", () => traitScored.fit === skillOnlyScored.fit,
  `${traitScored.fit} vs ${skillOnlyScored.fit}`);
check("unevaluated HARD constraints cost nothing on fit", () =>
  !traitScored.reasons.some((r) => r.dimension === "FIT" && r.subject === "us work authorization"));
check("traits and constraints raise uncertainty instead", () =>
  traitScored.uncertainty > skillOnlyScored.uncertainty);
check("trait hardness is preserved, not downgraded", () =>
  withTrait.requirements.filter((r) => r.kind === "TRAIT").every((r) => r.hardness === "HARD"));
// The constraint in this fixture is a work-authorization line, which now
// resolves against verified citizenship instead of sitting unevaluated.
check("soft-trait coverage is reported separately", () =>
  traitScored.traitCount === 2
  && traitScored.constraintCount === 0
  && traitScored.satisfiedConstraintCount === 1,
  `traits=${traitScored.traitCount} unevaluated=${traitScored.constraintCount} satisfied=${traitScored.satisfiedConstraintCount}`);
check("trait-aware scoring still reconciles", () => reconcile(traitScored).ok,
  reconcile(traitScored).problems.join("; "));

// Deliberate: hardness is irrelevant for a requirement that cannot affect
// fit either way, so an UNCLEAR trait is not counted as unresolved.
check("an UNCLEAR trait is not counted as an unclear requirement", () => {
  const f = buildFeatures({
    job: { eligibility: "ELIGIBLE", seniority: "SENIOR", manages_people: false,
           salary_min: 140000, salary_max: 170000, remote_policy: "FULLY_REMOTE",
           metro: "Chicagoland", mentions_equity: true, has_quota_or_commission: false,
           travel_requirement_pct: 0 },
    descriptionText: "text",
    requirements: [{ id: "x", normalized_term: "team player", raw_text: "Team player",
                     is_hard_requirement: "UNCLEAR", minimum_years: null, kind: "TRAIT" }],
  });
  const r = scoreJob(f, profile, matcher, WEIGHTS, { weightsVersion: 2, extractionVersion: 2 });
  return r.unclearRequirementCount === 0 && r.traitCount === 1 && r.fit === 0;
});

// Constraints resolve only against a verified attribute, never by guess.
const constraintFeatures = buildFeatures({
  job: { eligibility: "ELIGIBLE", seniority: "SENIOR", manages_people: false,
         salary_min: 140000, salary_max: 170000, remote_policy: "FULLY_REMOTE",
         metro: "Chicagoland", mentions_equity: true, has_quota_or_commission: false,
         travel_requirement_pct: 0 },
  descriptionText: "text",
  requirements: [
    { id: "c1", normalized_term: "no visa sponsorship", raw_text: "Toast will not sponsor applicants for work visas for this role", is_hard_requirement: "HARD", minimum_years: null, kind: "LEGAL" },
    { id: "c2", normalized_term: "us work authorization", raw_text: "Must be located within and authorized to work in the United States", is_hard_requirement: "HARD", minimum_years: null, kind: "LEGAL" },
    { id: "c3", normalized_term: "travel 25%", raw_text: "willingness to travel 25% or more", is_hard_requirement: "HARD", minimum_years: null, kind: "LOGISTICAL" },
    { id: "c4", normalized_term: "california residency", raw_text: "Must reside and be based in California", is_hard_requirement: "HARD", minimum_years: null, kind: "LOGISTICAL" },
  ],
});
const cScored = scoreJob(constraintFeatures, profile, matcher, WEIGHTS, { weightsVersion: 2, extractionVersion: 3 });
check("sponsorship and authorization resolve against verified citizenship", () =>
  cScored.satisfiedConstraintCount === 2, `got ${cScored.satisfiedConstraintCount}`);
check("travel and state residency stay unevaluated", () =>
  cScored.constraintCount === 2, `got ${cScored.constraintCount}`);
check("resolved constraints still cost nothing on fit", () => cScored.fit === 0, `fit=${cScored.fit}`);

const noAuth = { ...profile, workAuthorization: null, requiresSponsorship: null };
const naScored = scoreJob(constraintFeatures, noAuth, matcher, WEIGHTS, { weightsVersion: 2, extractionVersion: 3 });
check("without a verified attribute nothing resolves", () =>
  naScored.satisfiedConstraintCount === 0 && naScored.constraintCount === 4);
check("resolving constraints lowers uncertainty", () => cScored.uncertainty < naScored.uncertainty,
  `${cScored.uncertainty} vs ${naScored.uncertainty}`);

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
