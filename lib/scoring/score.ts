import type {
  JobFeatures, ScoreReason, ScoreResult, ScoringProfile, ScoreDimension,
} from "./types.ts";
import type { TermMatcher } from "../matching/match.ts";
import { classOfKind } from "./kinds.ts";

/**
 * The scorer.
 *
 * A pure function of (features, profile, matcher, weights). No I/O, no clock, no
 * randomness, no model. Same inputs, same output, forever, offline. That
 * is the scoring-purity invariant, and keeping this file free of imports
 * that could reach the network is how it stays true.
 *
 * Two rules run through every branch:
 *
 *   Unknown contributes NOTHING to a substantive score. It raises
 *   uncertainty instead. A job hiding its salary must not rank below one
 *   that publishes a bad number, because that would reward disclosure of
 *   bad terms and punish silence.
 *
 *   Every point emitted is a reason row. The sum of a dimension's reason
 *   points equals that dimension's score, by construction rather than by
 *   convention: the score is literally computed by summing the rows.
 */

export type WeightSet = Record<string, Record<string, number>>;

export function scoreJob(
  features: JobFeatures,
  profile: ScoringProfile,
  /** Built from the profile's verified skills plus the alias table. */
  matcher: TermMatcher,
  weights: WeightSet,
  meta: { weightsVersion: number; extractionVersion: number },
): ScoreResult {
  const reasons: ScoreReason[] = [];
  const w = (group: string, key: string): number => weights[group]?.[key] ?? 0;
  const add = (
    dimension: ScoreDimension, kind: ScoreReason["kind"],
    points: number, subject: string | null, detail: string | null,
    extra: { requirementId?: string | null; skillId?: string | null } = {},
  ) => {
    if (points === 0) return;
    reasons.push({ dimension, kind, points, subject, detail, ...extra });
  };

  // ---------------- FIT ----------------
  let unclearRequirements = 0;
  let unmatchedTraits = 0;
  let unevaluatedConstraints = 0;
  let traitsTotal = 0;

  for (const r of features.requirements) {
    const cls = classOfKind(r.kind);

    // Traits and constraints never touch fit, whatever hardness the
    // posting gave them. A posting can genuinely require a growth
    // mindset; what it cannot do is make that a skill we could evidence.
    // Scoring it as a missing hard requirement would penalise the job for
    // being written expansively, which is noise, not signal.
    if (cls === "TRAIT") {
      traitsTotal++;
      unmatchedTraits++;
      continue;
    }
    if (cls === "CONSTRAINT") {
      // Real and checkable, just not against a skills table. Recorded as
      // uncertainty because it is genuinely unevaluated, not because it
      // is unimportant: "must reside in California" decides the job.
      unevaluatedConstraints++;
      continue;
    }

    const m = matcher.match(r.term);
    const matched = m.method !== "NONE";
    if (r.hardness === "HARD") {
      if (matched) {
        add("FIT", "HARD_REQUIREMENT_MET", w("fit", "hard_requirement_met"),
            r.term, `matched ${m.skillName} via ${m.method}`,
            { requirementId: r.id, skillId: m.skillId });
      } else {
        add("FIT", "HARD_REQUIREMENT_MISSING", w("fit", "hard_requirement_missing"),
            r.term, "no verified skill matches this hard requirement",
            { requirementId: r.id });
      }
    } else if (r.hardness === "PREFERRED") {
      add("FIT", matched ? "SKILL_MATCH" : "SKILL_GAP",
          w("fit", matched ? "preferred_requirement_met" : "preferred_requirement_missing"),
          r.term, matched ? `matched ${m.skillName}` : "preferred, not evidenced",
          { requirementId: r.id, skillId: m.skillId });
    } else {
      // UNCLEAR hardness contributes zero to fit by design. We could not
      // tell whether the posting meant "required" or "nice to have", and
      // guessing either way produces a false rejection or a false match.
      unclearRequirements++;
      add("FIT", "HARD_REQUIREMENT_UNCLEAR", w("fit", "hard_requirement_unclear"),
          r.term, "requirement hardness could not be determined", { requirementId: r.id });
    }
  }

  // ---------------- OPPORTUNITY ----------------
  if (features.salaryKnown) {
    const top = features.salaryMax ?? features.salaryMin!;
    if (profile.salaryHardFloor !== null && top < profile.salaryHardFloor) {
      add("OPPORTUNITY", "SALARY_BELOW_FLOOR", w("opportunity", "salary_below_floor"),
          `${top}`, `below hard floor ${profile.salaryHardFloor}`);
    } else if (profile.salaryTargetIdeal !== null && top >= profile.salaryTargetIdeal) {
      add("OPPORTUNITY", "SALARY_MATCH", w("opportunity", "salary_above_target"),
          `${top}`, `at or above ideal ${profile.salaryTargetIdeal}`);
    } else if (profile.salaryTargetMin !== null && top >= profile.salaryTargetMin) {
      add("OPPORTUNITY", "SALARY_MATCH", w("opportunity", "salary_within_target"),
          `${top}`, `within target band`);
    }
    // Salary known but no targets set: contributes nothing. A target the
    // user has not stated is not a target we may invent.
  }

  const remote = features.remotePolicy === "FULLY_REMOTE" || features.remotePolicy === "REMOTE_WITH_TRAVEL";
  if (remote && profile.acceptsRemote) {
    add("OPPORTUNITY", "REMOTE_ELIGIBLE", w("opportunity", "remote_preferred"),
        features.remotePolicy, "remote matches stated preference");
  }
  if (features.metro && profile.targetMetros.includes(features.metro)) {
    add("OPPORTUNITY", "LOCATION_MATCH", w("opportunity", "chicagoland_onsite_ok"),
        features.metro, "in a target metro");
  }
  if (features.mentionsEquity === true) {
    add("OPPORTUNITY", "COMPANY_SIGNAL", w("opportunity", "equity_mentioned"), "equity", "posting mentions equity");
  }
  if (features.hasQuotaOrCommission === true) {
    add("OPPORTUNITY", "COMPANY_SIGNAL", w("opportunity", "quota_carrying"), "quota", "quota or commission carrying");
  }
  if (features.travelRequirementPct !== null && features.travelRequirementPct >= 25) {
    add("OPPORTUNITY", "COMPANY_SIGNAL", w("opportunity", "travel_heavy"),
        `${features.travelRequirementPct}%`, "heavy travel requirement");
  }

  for (const p of profile.preferences) {
    const hit = new RegExp(escapeRegex(p.statement), "i");
    const surface = [features.seniority, features.remotePolicy, features.metro ?? ""].join(" ");
    if (!hit.test(surface)) continue;
    add("OPPORTUNITY", p.kind === "WANT" ? "PREFERENCE_MATCH" : "PREFERENCE_CONFLICT",
        p.kind === "WANT" ? p.weight : -p.weight, p.statement, `stated ${p.kind}`);
  }

  // ---------------- GENERALIST / SPECIALIST ----------------
  // Two independent descriptions of the same role, not opposite ends of
  // one axis. A role can genuinely be both: deep in one domain while
  // demanding broad ownership around it.
  if (features.crossFunctionalLanguage) {
    add("GENERALIST", "GENERALIST_SIGNAL", w("generalist", "cross_functional_language"),
        "cross-functional", "posting uses cross-functional language");
  }
  if (features.ownershipLanguage) {
    add("GENERALIST", "GENERALIST_SIGNAL", w("generalist", "ownership_language"),
        "ownership", "posting emphasises ownership or end-to-end scope");
  }
  if (features.distinctDomains >= 3) {
    add("GENERALIST", "GENERALIST_SIGNAL", w("generalist", "breadth_of_domains"),
        `${features.distinctDomains} domains`, "requirements span several domains");
    add("SPECIALIST", "SPECIALIST_SIGNAL", w("specialist", "breadth_of_domains"),
        `${features.distinctDomains} domains`, "breadth reduces narrow-depth reading");
  } else if (features.distinctDomains === 1 && features.requirementsExtracted) {
    add("GENERALIST", "GENERALIST_SIGNAL", w("generalist", "narrow_single_domain"),
        "single domain", "requirements confined to one domain");
    add("SPECIALIST", "SPECIALIST_SIGNAL", w("specialist", "deep_single_domain"),
        "single domain", "requirements confined to one domain");
  }
  if (features.deepDomainLanguage) {
    add("SPECIALIST", "SPECIALIST_SIGNAL", w("specialist", "deep_single_domain"),
        "depth language", "posting asks for deep or specialist expertise");
  }
  const maxYears = features.requirements.reduce<number>(
    (acc, r) => (r.minimumYears !== null && r.minimumYears > acc ? r.minimumYears : acc), 0);
  if (maxYears >= 7) {
    add("SPECIALIST", "SPECIALIST_SIGNAL", w("specialist", "years_requirement_high"),
        `${maxYears} years`, "high years-of-experience requirement");
  }

  // ---------------- UNCERTAINTY ----------------
  // Never a substantive score. This is the only place unknowns are
  // allowed to register at all.
  for (const f of features.unknownFields) {
    const key = f === "salary" ? "salary_unknown"
              : f === "requirements" ? "no_requirements_extracted"
              : "per_unknown_field";
    add("UNCERTAINTY", "UNKNOWN_DATA", w("uncertainty", key), f, `${f} unknown`);
  }
  if (unmatchedTraits > 0) {
    add("UNCERTAINTY", "UNKNOWN_DATA",
        w("uncertainty", "per_unmatched_trait") * unmatchedTraits,
        `${unmatchedTraits} traits`, "personal qualities with no objective evidence to match against");
  }
  if (unevaluatedConstraints > 0) {
    add("UNCERTAINTY", "UNKNOWN_DATA",
        w("uncertainty", "per_unevaluated_constraint") * unevaluatedConstraints,
        `${unevaluatedConstraints} constraints`, "legal or logistical conditions not yet evaluated against the profile");
  }
  if (unclearRequirements > 0) {
    add("UNCERTAINTY", "HARD_REQUIREMENT_UNCLEAR",
        w("uncertainty", "per_unclear_requirement") * unclearRequirements,
        `${unclearRequirements} requirements`, "hardness undetermined");
  }
  if (features.eligibility === "UNCERTAIN") {
    add("UNCERTAINTY", "UNKNOWN_DATA", w("uncertainty", "eligibility_uncertain"),
        "eligibility", "eligibility could not be determined deterministically");
  }

  const sum = (d: ScoreDimension) =>
    reasons.filter((r) => r.dimension === d).reduce((a, r) => a + r.points, 0);

  return {
    fit: sum("FIT"),
    opportunity: sum("OPPORTUNITY"),
    generalist: sum("GENERALIST"),
    specialist: sum("SPECIALIST"),
    uncertainty: sum("UNCERTAINTY"),
    unknownFieldCount: features.unknownFields.length,
    unclearRequirementCount: unclearRequirements,
    traitCount: traitsTotal,
    constraintCount: unevaluatedConstraints,
    reasons,
    profileVersion: profile.profileVersion,
    weightsVersion: meta.weightsVersion,
    extractionVersion: meta.extractionVersion,
  };
}

/**
 * Reconciliation. Scores must equal the sum of their reasons, exactly.
 *
 * Cheap to run and worth running: a score that cannot be explained by its
 * own reasons is a score that cannot be defended months later, which is
 * the entire purpose of storing reasons at all.
 */
export function reconcile(result: ScoreResult): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const check = (d: ScoreDimension, actual: number) => {
    const expected = result.reasons.filter((r) => r.dimension === d).reduce((a, r) => a + r.points, 0);
    if (Math.abs(expected - actual) > 1e-9) {
      problems.push(`${d}: score ${actual} but reasons sum to ${expected}`);
    }
  };
  check("FIT", result.fit);
  check("OPPORTUNITY", result.opportunity);
  check("GENERALIST", result.generalist);
  check("SPECIALIST", result.specialist);
  check("UNCERTAINTY", result.uncertainty);
  for (const r of result.reasons) {
    if (!Number.isFinite(r.points)) problems.push(`non-finite points on ${r.kind}`);
  }
  return { ok: problems.length === 0, problems };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
