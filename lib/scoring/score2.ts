import type { JobFeatures, ScoreReason, ScoreResult, ScoringProfile, ScoreDimension } from "./types.ts";
import type { CapabilityIndex } from "./capability.ts";
import { buildFitBreakdown, FIT_VERSION, type FitBreakdown } from "./fit.ts";
import { assessSeniority, assessTitleFamily } from "./seniority.ts";
import { annualize, compareToFloor } from "./salary.ts";
import { evaluateConstraint } from "./constraints.ts";
import { schedulePreferenceAdjustment } from "./roleShape.ts";

/**
 * Scoring, version 2.
 *
 * Still a pure function of (features, profile, capability index, weights).
 * No I/O, no clock, no model. The architecture boundary is unchanged: an
 * LLM produced the requirement text, and nothing but arithmetic produces
 * the number.
 */

export type WeightSet = Record<string, Record<string, number>>;

export interface ScoreResult2 extends ScoreResult {
  fitBreakdown: FitBreakdown;
  scorable: boolean;
  unscorableReason: string | null;
}

export function scoreJob2(
  features: JobFeatures,
  profile: ScoringProfile,
  index: CapabilityIndex,
  weights: WeightSet,
  meta: {
    weightsVersion: number; extractionVersion: number; title: string; requirements: any[];
    credentialDeclarations?: Record<string, string>;
    profileEducation?: Array<{ level: string; field: string | null }>;
  },
): ScoreResult2 {
  const reasons: ScoreReason[] = [];
  const w = (g: string, k: string) => weights[g]?.[k] ?? 0;
  const add = (
    dimension: ScoreDimension, kind: ScoreReason["kind"], points: number,
    subject: string | null, detail: string | null,
  ) => { if (points !== 0) reasons.push({ dimension, kind, points, subject, detail }); };

  const fb = buildFitBreakdown(meta.requirements, meta.title, index, meta.credentialDeclarations ?? {}, meta.profileEducation ?? []);

  // ---------------- FIT ----------------
  // Coverage first, as a proportion of what the posting actually demands
  // and we can actually judge.
  if (fb.coverage !== null) {
    const points = Math.round(fb.coverage * w("fit", "coverage_scale"));
    add("FIT", "SKILL_MATCH", points, `${(fb.coverage * 100).toFixed(0)}% coverage`,
        `${fb.achieved.toFixed(1)} of ${fb.achievable} weighted concept demand met`);
  }

  const direct = fb.concepts.filter((c) => c.resolution === "DIRECT" && c.weight > 0);
  const transferable = fb.concepts.filter((c) => c.resolution === "TRANSFERABLE" && c.weight > 0);
  for (const c of transferable.slice(0, 12)) {
    add("FIT", "TRANSFERABLE_SKILL", w("fit", "transferable_skill"), c.concept,
        `${c.via}: ${c.rationale}`);
  }

  // Credentials are not skills. Adjacent experience cannot substitute for
  // a licence, so a gating credential with no supporting evidence is a
  // qualification failure rather than a low score.
  // Per FAMILY, not per mention. A posting listing RN licence, NP licence,
  // board certification and USMLE is stating one fact four times.
  if (fb.credentialFamiliesUnmet.length > 0) {
    add("FIT", "HARD_REQUIREMENT_MISSING",
        w("fit", "gating_credential_unmet") * fb.credentialFamiliesUnmet.length,
        fb.credentialFamiliesUnmet.join(", "),
        "regulated credential family the profile has not established");
  }
  // Once per job. A posting either requires a degree or it does not.
  if (fb.educationGatesUnmet > 0) {
    add("FIT", "HARD_REQUIREMENT_MISSING", w("fit", "education_gate_unmet"),
        "education", "degree requirement with no verified education on the profile");
  }

  const sen = assessSeniority(features.seniority, profile);
  if (sen.verdict === "MATCH") add("FIT", "SENIORITY_MATCH", w("fit", "seniority_match"), features.seniority, sen.detail);
  else if (sen.verdict === "MISMATCH") add("FIT", "SENIORITY_MISMATCH", w("fit", "seniority_mismatch"), features.seniority, sen.detail);

  const fam = assessTitleFamily(meta.title, profile);
  if (fam.matched) add("FIT", "TITLE_MATCH", w("fit", "title_family_match"), fam.matched, fam.detail);

  // ---------------- OPPORTUNITY ----------------
  if (features.salaryKnown) {
    const top = annualize(features.salaryMax ?? features.salaryMin, features.salaryPeriod ?? "YEAR")
      ?? (features.salaryMax ?? features.salaryMin!);
    const floor = compareToFloor({
      salaryMin: features.salaryMin, salaryMax: features.salaryMax,
      period: features.salaryPeriod ?? null, isEstimated: features.salaryIsEstimated ?? false,
      floor: profile.salaryHardFloor,
    });
    if (floor.verdict === "BELOW_FLOOR") add("OPPORTUNITY", "SALARY_BELOW_FLOOR", w("opportunity", "salary_below_floor"), `${top}`, floor.detail);
    else if (profile.salaryTargetIdeal !== null && top >= profile.salaryTargetIdeal) add("OPPORTUNITY", "SALARY_MATCH", w("opportunity", "salary_above_target"), `${top}`, "at or above ideal");
    else if (profile.salaryTargetMin !== null && top >= profile.salaryTargetMin) add("OPPORTUNITY", "SALARY_MATCH", w("opportunity", "salary_within_target"), `${top}`, "within target band");
  }
  const remote = features.remotePolicy === "FULLY_REMOTE" || features.remotePolicy === "REMOTE_WITH_TRAVEL";
  if (remote && profile.acceptsRemote) add("OPPORTUNITY", "REMOTE_ELIGIBLE", w("opportunity", "remote_preferred"), features.remotePolicy, "remote matches stated preference");
  if (features.metro && profile.targetMetros.includes(features.metro)) add("OPPORTUNITY", "LOCATION_MATCH", w("opportunity", "chicagoland_onsite_ok"), features.metro, "in a target metro");
  if (features.mentionsEquity === true) add("OPPORTUNITY", "COMPANY_SIGNAL", w("opportunity", "equity_mentioned"), "equity", "posting mentions equity");
  if (features.hasQuotaOrCommission === true) add("OPPORTUNITY", "COMPANY_SIGNAL", w("opportunity", "quota_carrying"), "quota", "quota or commission carrying");

  const sched = schedulePreferenceAdjustment({ travelPct: features.travelRequirementPct, descriptionText: "" });
  if (sched.points !== 0) add("OPPORTUNITY", "COMPANY_SIGNAL", sched.points, sched.reasons.join(", "), "schedule and travel preference, never an exclusion");

  // ---------------- GENERALIST / SPECIALIST ----------------
  // Breadth is how many business functions the role reaches across, not
  // how many kinds of requirement it lists. The old measure gave nearly
  // every job 16 because every posting has three requirement kinds.
  const span = fb.functions.length;
  if (span >= 4) add("GENERALIST", "GENERALIST_SIGNAL", w("generalist", "spans_four_plus_functions"), `${span} functions`, fb.functions.join(", "));
  else if (span === 3) add("GENERALIST", "GENERALIST_SIGNAL", w("generalist", "spans_three_functions"), `${span} functions`, fb.functions.join(", "));
  else if (span === 2) add("GENERALIST", "GENERALIST_SIGNAL", w("generalist", "spans_two_functions"), `${span} functions`, fb.functions.join(", "));
  else if (span <= 1) add("GENERALIST", "GENERALIST_SIGNAL", w("generalist", "single_function"), `${span} function`, fb.primaryFunction ?? "none identified");
  if (features.ownershipLanguage) add("GENERALIST", "GENERALIST_SIGNAL", w("generalist", "ownership_language"), "ownership", "posting emphasises end-to-end ownership");

  // Depth is independent, and it describes the JOB rather than the fit.
  //
  // Every input below reads job features only: functional span, count of
  // hard concepts, whether a regulated credential is required at all
  // (not whether it is met), and depth language in the posting. A
  // physician role is correctly very high Specialist and very low Fit,
  // because the two answer different questions. Nothing here consults
  // the profile, and nothing here should.
  const deepConcepts = fb.concepts.filter((c) => c.weight === 3).length;
  if (span <= 1 && deepConcepts >= 6) add("SPECIALIST", "SPECIALIST_SIGNAL", w("specialist", "deep_single_domain"), `${deepConcepts} hard concepts in one function`, "narrow and demanding");
  if (fb.credentialGates > 0) add("SPECIALIST", "SPECIALIST_SIGNAL", w("specialist", "advanced_credential_required") * Math.min(fb.credentialGates, 3), `${fb.credentialGates} gating credentials`, "regulated credential required");
  if (features.deepDomainLanguage) add("SPECIALIST", "SPECIALIST_SIGNAL", w("specialist", "depth_language"), "depth language", "posting asks for deep or specialist expertise");

  // ---------------- UNCERTAINTY ----------------
  for (const f of features.unknownFields) {
    const key = f === "salary" ? "salary_unknown" : f === "requirements" ? "no_requirements_extracted" : "per_unknown_field";
    add("UNCERTAINTY", "UNKNOWN_DATA", w("uncertainty", key), f, `${f} unknown`);
  }
  if (fb.excludedUnknown > 0) {
    add("UNCERTAINTY", "UNKNOWN_DATA", w("uncertainty", "per_unverified_skill_match") * fb.excludedUnknown,
        `${fb.excludedUnknown} concepts`, "matched a proposed but unverified skill, or an unasked credential");
  }
  const unclear = fb.concepts.filter((c) => c.hardness === "UNCLEAR").length;
  if (unclear > 0) add("UNCERTAINTY", "HARD_REQUIREMENT_UNCLEAR", w("uncertainty", "per_unclear_requirement") * unclear, `${unclear} concepts`, "hardness undetermined");
  if (!fb.scorable) add("UNCERTAINTY", "UNKNOWN_DATA", w("uncertainty", "unscorable_posting"), "posting", fb.unscorableReason ?? "insufficient information");

  let constraintsUnevaluated = 0, constraintsSatisfied = 0;
  for (const r of meta.requirements) {
    const c = evaluateConstraint(r.raw_text ?? "", {
      workAuthorization: profile.workAuthorization, requiresSponsorship: profile.requiresSponsorship, country: profile.country,
    });
    if (c.category === "OTHER") continue;
    if (c.verdict === "SATISFIED") constraintsSatisfied++;
    else if (c.verdict === "UNEVALUATED") constraintsUnevaluated++;
  }
  if (constraintsUnevaluated > 0) {
    add("UNCERTAINTY", "UNKNOWN_DATA", w("uncertainty", "per_unevaluated_constraint") * Math.min(constraintsUnevaluated, 6),
        `${constraintsUnevaluated} constraints`, "legal or logistical conditions not yet evaluated");
  }

  const sum = (d: ScoreDimension) => reasons.filter((r) => r.dimension === d).reduce((a, r) => a + r.points, 0);

  return {
    fit: sum("FIT"), opportunity: sum("OPPORTUNITY"),
    generalist: sum("GENERALIST"), specialist: sum("SPECIALIST"),
    uncertainty: sum("UNCERTAINTY"),
    unknownFieldCount: features.unknownFields.length,
    unclearRequirementCount: unclear,
    traitCount: fb.excludedByClass["TRAIT"] ?? 0,
    constraintCount: constraintsUnevaluated,
    satisfiedConstraintCount: constraintsSatisfied,
    unverifiedSkillMatchCount: fb.excludedUnknown,
    reasons,
    profileVersion: profile.profileVersion,
    weightsVersion: meta.weightsVersion,
    extractionVersion: meta.extractionVersion,
    fitBreakdown: fb,
    scorable: fb.scorable,
    unscorableReason: fb.unscorableReason,
  };
}

export { FIT_VERSION };
