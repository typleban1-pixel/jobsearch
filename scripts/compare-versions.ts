/**
 * Scores the same corpus against two frozen profile versions.
 *
 * The point is to isolate ONE variable. Comparing the scores already
 * stored for version 3 would not do that: they were computed before the
 * education matching, credential families and classifier fixes landed, so
 * the difference would be evidence change plus code change tangled
 * together.
 *
 * So both versions are reconstructed from profile_version_rows and scored
 * with the CURRENT code and the SAME weights. This is exactly what the
 * frozen snapshots exist for, and the first real use of them.
 *
 *   node scripts/compare-versions.ts 3 4
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { required } from "../lib/env.ts";
import { TermMatcher } from "../lib/matching/match.ts";
import { buildFeatures } from "../lib/scoring/features.ts";
import { scoreJob2 } from "../lib/scoring/score2.ts";
import { toConcept } from "../lib/matching/concepts.ts";
import type { CapabilityIndex } from "../lib/scoring/capability.ts";
import type { ScoringProfile } from "../lib/scoring/types.ts";

const [vA, vB] = [Number(process.argv[2] ?? 3), Number(process.argv[3] ?? 4)];
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
// profile_version_rows has a composite key and no id column, so the
// order column is a parameter rather than a hardcoded "id".
const page = async (t: string, c: string, x: (q: any) => any = (q) => q, orderBy = "id") => {
  const o: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await x(db.from(t).select(c)).order(orderBy, { ascending: true }).range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break;
  }
  return o;
};

const weightsRow = (await db.from("scoring_weights").select("version,weights").eq("is_active", true).single()).data!;
const aliases = await page("term_aliases", "alias,canonical_term");
const relRows = await page("capability_relations", "requirement_concept,satisfied_by_skill,relation,rationale");
const { data: credNow } = await db.from("credential_declarations").select("family,status,created_at");
const { data: cuts } = await db.from("profile_versions").select("version,created_at");
const cutAt = new Map<number, string>((cuts ?? []).map((c: any) => [c.version, c.created_at]));

const jobs = (await page("jobs",
  "id,title,company_id,eligibility,seniority,manages_people,salary_min,salary_max,salary_period," +
  "salary_is_estimated,remote_policy,metro,mentions_equity,has_quota_or_commission,travel_requirement_pct,status"))
  .filter((j: any) => j.status === "OPEN" && j.eligibility === "ELIGIBLE");
const allReqs = await page("job_requirements", "id,job_id,normalized_term,raw_text,is_hard_requirement,minimum_years,kind");
const reqsByJob = new Map<string, any[]>();
for (const r of allReqs) { const a = reqsByJob.get(r.job_id) ?? []; a.push(r); reqsByJob.set(r.job_id, a); }
const descById = new Map<string, string>();
for (let i = 0; i < jobs.length; i += 100) {
  const { data } = await db.from("job_descriptions").select("job_id,description_text")
    .in("job_id", jobs.slice(i, i + 100).map((j: any) => j.id));
  for (const d of data ?? []) descById.set(d.job_id, d.description_text ?? "");
}

async function scoreVersion(version: number) {
  const rows = await page("profile_version_rows", "source_table,row_id,row_data",
    (q: any) => q.eq("profile_version", version), "row_id");
  const of = (t: string) => rows.filter((r: any) => r.source_table === t).map((r: any) => r.row_data);

  // Only VERIFIED rows were ever frozen, so everything here is verified
  // by construction rather than by filtering after the fact.
  const skills = of("skills");
  const education = of("education").filter((e: any) => e.completed).map((e: any) => ({
    level: /master|mba/i.test(e.credential ?? "") ? "MASTER"
         : /doctor|phd/i.test(e.credential ?? "") ? "DOCTORATE"
         : /associate/i.test(e.credential ?? "") ? "ASSOCIATE" : "BACHELOR",
    field: e.field_of_study ?? null,
  }));
  const prof = of("profile")[0] ?? {};
  const prefs = of("work_preferences");
  const locs = of("location_preferences");

  const matcher = new TermMatcher(
    skills.map((s: any) => ({ id: s.id, name: s.name, relatedTerms: s.related_terms ?? [], status: "VERIFIED" })),
    aliases as any);
  const verifiedNames = new Set(skills.map((s: any) => s.name));
  const relations = new Map<string, any>();
  for (const r of relRows) {
    if (!verifiedNames.has(r.satisfied_by_skill)) continue;
    relations.set(toConcept(r.requirement_concept).concept,
      { skill: r.satisfied_by_skill, relation: r.relation, rationale: r.rationale });
  }
  const index: CapabilityIndex = { relations,
    matchTerm: (t: string) => { const m = matcher.match(t); return { status: m.status, skillName: m.skillName, method: m.method, terminal: m.terminal }; } };

  // Credential declarations live outside profile_version_rows, so which
  // ones a version "had" is decided by when each was declared relative to
  // when the version was cut. Hardcoding this to the later version was
  // right for 3 vs 4, where declarations genuinely did not exist yet, and
  // wrong for 4 vs 5, where they existed for both and pinning them to one
  // side would have smuggled a second variable into an experiment whose
  // whole purpose is to isolate one.
  const declarations: Record<string, string> = {};
  for (const c of credNow ?? []) {
    if (cutAt.get(version) && c.created_at && c.created_at <= cutAt.get(version)!) declarations[c.family] = c.status;
  }

  const profile: ScoringProfile = {
    profileVersion: version,
    skills: skills.map((s: any) => ({ id: s.id, name: s.name, relatedTerms: s.related_terms ?? [],
      level: s.level, interest: s.interest, importance: s.importance })),
    salaryHardFloor: prof.salary_hard_floor ?? null,
    salaryTargetMin: prof.salary_target_min ?? null,
    salaryTargetIdeal: prof.salary_target_ideal ?? null,
    targetMetros: locs.filter((l: any) => l.stance === "PREFERRED" && l.metro).map((l: any) => l.metro),
    acceptsRemote: true,
    preferences: prefs.map((p: any) => ({ kind: p.kind, statement: p.statement, weight: p.weight })),
    workAuthorization: prof.work_authorization ?? null,
    requiresSponsorship: prof.requires_sponsorship ?? null,
    country: prof.country ?? null,
  };

  const out = jobs.map((j: any) => {
    const features = buildFeatures({ job: j, descriptionText: descById.get(j.id) ?? "", requirements: reqsByJob.get(j.id) ?? [] });
    const r: any = scoreJob2(features, profile, index, weightsRow.weights, {
      weightsVersion: weightsRow.version, extractionVersion: 3, title: j.title,
      requirements: reqsByJob.get(j.id) ?? [], credentialDeclarations: declarations, profileEducation: education });
    const fb = r.fitBreakdown;
    return { id: j.id, title: j.title, company_id: j.company_id,
      fit: r.fit, opportunity: r.opportunity, generalist: r.generalist, specialist: r.specialist,
      uncertainty: r.uncertainty, scorable: r.scorable, coverage: fb.coverage, reqCount: (reqsByJob.get(j.id) ?? []).length,
      direct: fb.concepts.filter((c: any) => c.resolution === "DIRECT" && c.weight > 0).length,
      transferable: fb.concepts.filter((c: any) => c.resolution === "TRANSFERABLE" && c.weight > 0).length,
      unknown: fb.excludedUnknown,
      absent: fb.concepts.filter((c: any) => c.resolution === "ABSENT" && c.weight > 0).length,
      credentialFamilies: fb.credentialFamiliesUnmet, credentialUndeclared: fb.credentialFamiliesUndeclared,
      educationUnmet: fb.educationGatesUnmet,
      directConcepts: fb.concepts.filter((c: any) => c.resolution === "DIRECT" && c.weight > 0).map((c: any) => c.concept),
      transferableConcepts: fb.concepts.filter((c: any) => c.resolution === "TRANSFERABLE" && c.weight > 0).map((c: any) => c.concept),
      reasons: r.reasons };
  });
  console.log(`  v${version}: ${skills.length} skills, ${education.length} education, ${Object.keys(declarations).length} credential families, ${relations.size} usable relations`);
  return out;
}

console.log(`scoring ${jobs.length} jobs against two frozen profiles, weights v${weightsRow.version}, current code\n`);
const A = await scoreVersion(vA);
const B = await scoreVersion(vB);
writeFileSync("/tmp/compare.json", JSON.stringify({ vA, vB, A, B }));
console.log(`\nwrote /tmp/compare.json`);
