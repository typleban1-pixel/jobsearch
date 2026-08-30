/**
 * The first real scoring pass.
 *
 * Deterministic end to end. No model is called, nothing is fetched, and
 * the same inputs produce the same output every time. Features are cached
 * so a later weight change rescores from this table alone.
 *
 *   node scripts/score.ts            dry run, reports only
 *   node scripts/score.ts --commit   persist features, scores, reasons, snapshots
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { TermMatcher } from "../lib/matching/match.ts";
import { buildFeatures } from "../lib/scoring/features.ts";
import { scoreJob, reconcile, type WeightSet } from "../lib/scoring/score.ts";
import { FEATURE_VERSION, type ScoringProfile } from "../lib/scoring/types.ts";

const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const page = async (t: string, c: string, x: (q: any) => any = (q) => q) => {
  const o: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await x(db.from(t).select(c)).order("id", { ascending: true }).range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    o.push(...data); if (data.length < 1000) break;
  }
  return o;
};

const { data: prof } = await db.from("profile").select("*").single();
const { data: weightsRow } = await db.from("scoring_weights").select("version,weights").eq("is_active", true).single();
if (!weightsRow) throw new Error("no active scoring_weights row");
const weights = weightsRow as { version: number; weights: WeightSet };
const allSkills = await page("skills", "id,name,related_terms,status,level,interest,importance");
const aliases = await page("term_aliases", "alias,canonical_term");

const verified = allSkills.filter((s: any) => s.status === "VERIFIED");
const matcher = new TermMatcher(
  allSkills.map((s: any) => ({ id: s.id, name: s.name, relatedTerms: s.related_terms ?? [], status: s.status })),
  aliases as any,
);

const { data: prefs } = await db.from("work_preferences").select("kind,statement,weight");
const { data: locs } = await db.from("location_preferences").select("metro,stance");

const profile: ScoringProfile = {
  profileVersion: prof.profile_version,
  skills: verified.map((s: any) => ({
    id: s.id, name: s.name, relatedTerms: s.related_terms ?? [],
    level: s.level, interest: s.interest, importance: s.importance,
  })),
  salaryHardFloor: prof.salary_hard_floor,
  salaryTargetMin: prof.salary_target_min,
  salaryTargetIdeal: prof.salary_target_ideal,
  targetMetros: (locs ?? []).filter((l: any) => l.stance === "PREFERRED" && l.metro).map((l: any) => l.metro),
  acceptsRemote: true,
  preferences: (prefs ?? []).map((p: any) => ({ kind: p.kind, statement: p.statement, weight: p.weight })),
  workAuthorization: prof.work_authorization,
  requiresSponsorship: prof.requires_sponsorship,
  country: prof.country,
};

const jobs = (await page("jobs",
  "id,title,company_id,eligibility,seniority,manages_people,salary_min,salary_max,salary_period," +
  "salary_is_estimated,remote_policy,metro,mentions_equity,has_quota_or_commission,travel_requirement_pct,status"))
  .filter((j: any) => j.status === "OPEN" && j.eligibility === "ELIGIBLE");

const allReqs = await page("job_requirements", "id,job_id,normalized_term,raw_text,is_hard_requirement,minimum_years,kind");
const reqsByJob = new Map<string, any[]>();
for (const r of allReqs) {
  const a = reqsByJob.get(r.job_id) ?? []; a.push(r); reqsByJob.set(r.job_id, a);
}
const descById = new Map<string, string>();
for (let i = 0; i < jobs.length; i += 100) {
  const { data } = await db.from("job_descriptions").select("job_id,description_text").in("job_id", jobs.slice(i, i + 100).map((j: any) => j.id));
  for (const d of data ?? []) descById.set(d.job_id, d.description_text ?? "");
}

console.log(`profile version ${profile.profileVersion}, weights version ${weights.version}`);
console.log(`verified skills ${verified.length}, suggested ${allSkills.length - verified.length}`);
console.log(`scoring ${jobs.length} ELIGIBLE open jobs\n`);

const results: any[] = [];
let reconcileFailures = 0;
for (const j of jobs) {
  const features = buildFeatures({
    job: j, descriptionText: descById.get(j.id) ?? "", requirements: reqsByJob.get(j.id) ?? [],
  });
  const r = scoreJob(features, profile, matcher, weights.weights,
    { weightsVersion: weights.version, extractionVersion: 3 });
  if (!reconcile(r).ok) reconcileFailures++;
  results.push({ job: j, features, result: r });
}

console.log(`scored ${results.length}, reconciliation failures ${reconcileFailures}`);

if (commit) {
  const now = new Date().toISOString();
  for (let i = 0; i < results.length; i += 200) {
    const slice = results.slice(i, i + 200);
    await db.from("job_features").upsert(slice.map(({ job, features }) => ({
      job_id: job.id, extraction_version: 3, feature_version: FEATURE_VERSION,
      eligibility: job.eligibility, features: features as any, computed_at: now,
    })), { onConflict: "job_id" });
  }
  // One current score per job: clear the flag before inserting.
  for (let i = 0; i < results.length; i += 200) {
    const ids = results.slice(i, i + 200).map((r) => r.job.id);
    await db.from("job_scores").update({ is_current: false }).in("job_id", ids).eq("is_current", true);
  }
  for (const { job, result } of results) {
    const { data: sc, error } = await db.from("job_scores").insert({
      job_id: job.id, fit_score: result.fit, opportunity_score: result.opportunity,
      generalist_score: result.generalist, specialist_score: result.specialist,
      profile_version: result.profileVersion, weights_version: result.weightsVersion,
      extraction_version: result.extractionVersion, uncertainty_score: result.uncertainty,
      unknown_field_count: result.unknownFieldCount,
      unclear_requirement_count: result.unclearRequirementCount,
      is_current: true, computed_at: now,
    }).select("id").single();
    if (error) throw new Error(`job_scores: ${error.message}`);
    if (result.reasons.length) {
      const { error: re } = await db.from("score_reasons").insert(result.reasons.map((x: any) => ({
        score_id: sc.id, dimension: x.dimension, kind: x.kind, subject: x.subject,
        detail: x.detail, points: x.points, requirement_id: x.requirementId ?? null,
        skill_id: x.skillId ?? null,
      })));
      if (re) throw new Error(`score_reasons: ${re.message}`);
    }
  }
  console.log("persisted features, scores and reasons");
}

// Report goes to a file so the diagnostic script can read the same objects.
const { writeFileSync } = await import("node:fs");
writeFileSync("/tmp/score-results.json", JSON.stringify(results.map(({ job, features, result }) => ({
  id: job.id, title: job.title, company_id: job.company_id,
  fit: result.fit, opportunity: result.opportunity, generalist: result.generalist,
  specialist: result.specialist, uncertainty: result.uncertainty,
  unknownFields: features.unknownFields, traitCount: result.traitCount,
  constraintCount: result.constraintCount, satisfied: result.satisfiedConstraintCount,
  unverified: result.unverifiedSkillMatchCount, unclear: result.unclearRequirementCount,
  reqCount: features.requirements.length,
  reasons: result.reasons,
})), null, 0));
console.log("wrote /tmp/score-results.json");
