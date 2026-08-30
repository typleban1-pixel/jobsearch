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
import { reconcile, type WeightSet } from "../lib/scoring/score.ts";
import { scoreJob2 } from "../lib/scoring/score2.ts";
import { toConcept } from "../lib/matching/concepts.ts";
import type { CapabilityIndex } from "../lib/scoring/capability.ts";
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

const relRows = await page("capability_relations", "requirement_concept,satisfied_by_skill,relation,rationale");
const verifiedNames = new Set(verified.map((s: any) => s.name));
const relations = new Map<string, { skill: string; relation: "DIRECT" | "TRANSFERABLE"; rationale: string }>();
for (const r of relRows) {
  // A relation whose target skill is not verified cannot grant credit.
  if (!verifiedNames.has(r.satisfied_by_skill)) continue;
  relations.set(toConcept(r.requirement_concept).concept,
    { skill: r.satisfied_by_skill, relation: r.relation, rationale: r.rationale });
}
const index: CapabilityIndex = {
  relations,
  matchTerm: (t: string) => { const m = matcher.match(t); return { status: m.status, skillName: m.skillName, method: m.method, terminal: m.terminal }; },
};
console.log(`capability relations usable (target skill verified): ${relations.size} of ${relRows.length}`);

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
  const r = scoreJob2(features, profile, index, weights.weights, {
    weightsVersion: weights.version, extractionVersion: 3,
    title: j.title, requirements: reqsByJob.get(j.id) ?? [],
  });
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
  // job_scores is unique on (job_id, profile_version, weights_version,
  // extraction_version), which is exactly right: two different scores
  // must never claim the same inputs. Re-running the same triple is a
  // recompute, not a new score, so the previous rows for that triple are
  // replaced rather than duplicated.
  for (let i = 0; i < results.length; i += 100) {
    const ids = results.slice(i, i + 100).map((r) => r.job.id);
    await db.from("job_scores").delete()
      .in("job_id", ids)
      .eq("profile_version", profile.profileVersion)
      .eq("weights_version", weights.version)
      .eq("extraction_version", 3);
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
      scorable: (result as any).scorable, unscorable_reason: (result as any).unscorableReason,
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
  scorable: (result as any).scorable,
  coverage: (result as any).fitBreakdown.coverage,
  achievable: (result as any).fitBreakdown.achievable,
  conceptCount: (result as any).fitBreakdown.concepts.length,
  direct: (result as any).fitBreakdown.concepts.filter((c: any) => c.resolution === "DIRECT" && c.weight > 0).length,
  transferable: (result as any).fitBreakdown.concepts.filter((c: any) => c.resolution === "TRANSFERABLE" && c.weight > 0).length,
  absent: (result as any).fitBreakdown.concepts.filter((c: any) => c.resolution === "ABSENT" && c.weight > 0).length,
  unknownConcepts: (result as any).fitBreakdown.excludedUnknown,
  credentialGates: (result as any).fitBreakdown.credentialGates,
  credentialGatesUnmet: (result as any).fitBreakdown.credentialGatesUnmet,
  credentialFamiliesUnmet: (result as any).fitBreakdown.credentialFamiliesUnmet,
  educationGatesUnmet: (result as any).fitBreakdown.educationGatesUnmet,
  functions: (result as any).fitBreakdown.functions,
  excludedByClass: (result as any).fitBreakdown.excludedByClass,
  absentConcepts: (result as any).fitBreakdown.concepts.filter((c: any) => c.resolution === "ABSENT" && c.weight > 0).map((c: any) => c.concept),
  transferableConcepts: (result as any).fitBreakdown.concepts.filter((c: any) => c.resolution === "TRANSFERABLE" && c.weight > 0).map((c: any) => ({ c: c.concept, via: c.via })),
  directConcepts: (result as any).fitBreakdown.concepts.filter((c: any) => c.resolution === "DIRECT" && c.weight > 0).map((c: any) => ({ c: c.concept, via: c.via })),
  reasons: result.reasons,
})), null, 0));
console.log("wrote /tmp/score-results.json");
