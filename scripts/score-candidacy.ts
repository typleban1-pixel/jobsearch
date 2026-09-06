/**
 * Assesses candidacy for every eligible job and persists the verdicts.
 *
 *   node scripts/score-candidacy.ts [--write]
 *
 * Without --write it reports the distribution and stores nothing, which
 * is how the result is compared against the accepted simulation before
 * anything is committed.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { buildFitBreakdown, FIT_FORMULA_VERSION } from "../lib/scoring/fit.ts";
import type { CapabilityIndex } from "../lib/scoring/capability.ts";
import { TAXONOMY_VERSION } from "../lib/scoring/requirementClass.ts";
import { assessCandidacy, CANDIDACY_MODEL_VERSION, type RequirementRow } from "../lib/scoring/candidacy.ts";
import { TermMatcher } from "../lib/matching/match.ts";
import { toConcept } from "../lib/matching/concepts.ts";
import { reconcileAll, type ApplicationState } from "../lib/applications/reconcileCandidacy.ts";
import { buildEvidenceContext } from "../lib/scoring/evidenceResolution.ts";

const WRITE = process.argv.includes("--write");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const page = async (t: string, c: string) => { const o: any[] = [];
  for (let f = 0; ; f += 1000) { const { data, error } = await db.from(t).select(c).order("id", { ascending: true }).range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break; } return o; };

const { data: prof } = await db.from("profile").select("profile_version").single();
const allSkills = await page("skills", "id,name,related_terms,status,level,category");
const aliases = await page("term_aliases", "alias,canonical_term");
const matcher = new TermMatcher(allSkills.map((s: any) => ({ id: s.id, name: s.name, relatedTerms: s.related_terms ?? [], status: s.status })), aliases as any);
const verified = new Set(allSkills.filter((s: any) => s.status === "VERIFIED").map((s: any) => s.name));
const relations = new Map<string, any>();
for (const r of await page("capability_relations", "requirement_concept,satisfied_by_skill,relation,rationale")) {
  if (!verified.has(r.satisfied_by_skill)) continue;
  relations.set(toConcept(r.requirement_concept).concept, { skill: r.satisfied_by_skill, relation: r.relation, rationale: r.rationale }); }
if (process.argv.includes("--overlay")) {
  const ov = JSON.parse(readFileSync("data/candidacy-relations.json", "utf8")).relations as any[];
  let n = 0;
  for (const r of ov) { if (!verified.has(r.satisfied_by_skill)) continue;
    relations.set(toConcept(r.requirement_concept).concept, { skill: r.satisfied_by_skill, relation: r.relation, rationale: r.rationale }); n++; }
  console.error(`overlay: merged ${n}/${ov.length} proposed relations`);
}
const index: CapabilityIndex = { relations, matchTerm: (t: string) => { const m = matcher.match(t); return { status: m.status, skillName: m.skillName, method: m.method, terminal: m.terminal }; } };
const { data: credDecl } = await db.from("credential_declarations").select("family,status");
const cred: Record<string, string> = {}; for (const c of credDecl ?? []) cred[c.family] = c.status;
const { data: eduRows } = await db.from("education").select("credential,field_of_study,status,completed");
const edu = (eduRows ?? []).filter((e: any) => e.status === "VERIFIED" && e.completed).map((e: any) => ({
  level: /master|mba/i.test(e.credential ?? "") ? "MASTER" : /associate/i.test(e.credential ?? "") ? "ASSOCIATE" : "BACHELOR", field: e.field_of_study ?? null }));
// The evidence layer sees what the term matcher cannot: that a concept
// no skill is NAMED after is nonetheless the CATEGORY of verified skills,
// which makes it unestablished rather than absent. notHeld is empty here
// on purpose: the only negatives this profile records are credential
// declarations, and buildFitBreakdown already applies those by family.
const metrics = await page("metrics", "label,unit,numeric_value,approved_for_use");
const evidenceContext = buildEvidenceContext({ skills: allSkills as any, metrics: metrics as any, notHeld: [] });
console.log(`evidence: ${evidenceContext.verifiedCategories.size} verified skill categories, `
  + `${evidenceContext.capabilityYears.size} recorded capability durations`);

const jobs = (await page("jobs", "id,title,normalized_title,status,eligibility")).filter((j: any) => j.status === "OPEN" && j.eligibility === "ELIGIBLE");
const allReqs = await page("job_requirements", "id,job_id,normalized_term,raw_text,is_hard_requirement,minimum_years,kind,alternative_group,conjunct_key");
const byJob = new Map<string, any[]>();
for (const r of allReqs) byJob.set(r.job_id, [...(byJob.get(r.job_id) ?? []), r]);

console.log(`profile v${prof!.profile_version}, formula ${FIT_FORMULA_VERSION}, taxonomy ${TAXONOMY_VERSION}, model ${CANDIDACY_MODEL_VERSION}`);
const results = jobs.map((j: any) => {
  const rs = byJob.get(j.id) ?? [];
  const fit = buildFitBreakdown(rs, j.title, index, cred, edu as any, null, 0, evidenceContext);
  const c = assessCandidacy({ jobTitle: j.title, normalizedTitle: j.normalized_title, fit,
    requirements: rs as RequirementRow[], credentialDeclarations: cred });
  return { job: j, coverage: fit.coverage ?? 0, c };
});
const counts: Record<string, number> = {};
for (const r of results) counts[r.c.verdict] = (counts[r.c.verdict] ?? 0) + 1;
console.log(`\n${results.length} eligible jobs`);
for (const k of ["APPLICATION_CANDIDATE", "STRETCH", "REJECT", "MANUAL_REVIEW"]) console.log(`  ${k.padEnd(22)} ${counts[k] ?? 0}`);
const byCode: Record<string, number> = {};
for (const r of results) byCode[r.c.reasonCodes[0]!] = (byCode[r.c.reasonCodes[0]!] ?? 0) + 1;
console.log(`\nreason codes: ${JSON.stringify(byCode)}`);

// What this run would change, against the verdicts currently stored
// under the same version key. Printed before anything is written so a
// scoring change can be inspected as a set of transitions rather than as
// a distribution that happens to look different.
//
// The baseline is the newest stored model at or below the current one.
// On an ordinary re-run that is the current model and the matrix shows
// what this pass changes; on the first run of a NEW model there are no
// rows at that version yet, so it falls back to the model being
// replaced and the matrix shows what the model change does. Comparing a
// new model against its own empty row set would report every job as a
// change and say nothing.
const candRows = (await page("job_candidacy", "id,job_id,verdict,profile_version,formula_version,taxonomy_version,model_version"))
  .filter((r: any) => r.profile_version === prof!.profile_version && r.formula_version === FIT_FORMULA_VERSION
    && r.taxonomy_version === TAXONOMY_VERSION && r.model_version <= CANDIDACY_MODEL_VERSION);
const baselineModel = candRows.length ? Math.max(...candRows.map((r: any) => r.model_version)) : null;
const stored = new Map<string, string>();
for (const r of candRows) if (r.model_version === baselineModel) stored.set(r.job_id, r.verdict);
console.log(`\nbaseline: model ${baselineModel ?? "(none)"} at profile v${prof!.profile_version}`);
const transitions = new Map<string, number>();
for (const r of results) {
  const was = stored.get(r.job.id) ?? "(none)";
  if (was === r.c.verdict) continue;
  const k = `${was} -> ${r.c.verdict}`;
  transitions.set(k, (transitions.get(k) ?? 0) + 1);
}
// Direction, stated separately from the matrix. A model change that is
// meant to be conservative has to be checked for loosening rather than
// assumed conservative, and a truth change legitimately loosens, so this
// reports rather than refuses.
const RANK: Record<string, number> = { REJECT: 0, MANUAL_REVIEW: 1, STRETCH: 2, APPLICATION_CANDIDATE: 3 };
const loosened = results.filter((r) => {
  const was = stored.get(r.job.id); if (!was) return false;
  return (RANK[r.c.verdict] ?? 0) > (RANK[was] ?? 0);
});
const tightened = results.filter((r) => {
  const was = stored.get(r.job.id); if (!was) return false;
  return (RANK[r.c.verdict] ?? 0) < (RANK[was] ?? 0);
});
console.log(`\ndirection: ${tightened.length} tightened, ${loosened.length} loosened`);
for (const r of loosened.slice(0, 20)) console.log(`  LOOSENED  ${r.job.id.slice(0, 8)}  ${stored.get(r.job.id)} -> ${r.c.verdict}  ${r.job.title}`);

console.log(`\ntransitions against ${stored.size} stored verdicts:`);
if (!transitions.size) console.log("  none");
for (const [k, n] of [...transitions].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

if (!WRITE) {
  const changed = results.filter((r) => (stored.get(r.job.id) ?? "(none)") !== r.c.verdict);
  for (const r of changed.slice(0, 40)) {
    console.log(`  ${r.job.id.slice(0, 8)}  ${(stored.get(r.job.id) ?? "(none)").padEnd(22)} -> ${r.c.verdict.padEnd(22)} ${r.job.title}`);
  }
  if (changed.length > 40) console.log(`  ... and ${changed.length - 40} more`);
  console.log(`\nnothing written; pass --write to persist`);
  process.exit(0);
}
const rows = results.map((r) => ({
  job_id: r.job.id, verdict: r.c.verdict, reason_codes: r.c.reasonCodes, reason: r.c.reason,
  profile_version: prof!.profile_version, formula_version: FIT_FORMULA_VERSION,
  taxonomy_version: TAXONOMY_VERSION, model_version: CANDIDACY_MODEL_VERSION,
  hard_met: r.c.hardMet, hard_total: r.c.hardTotal, direct_matches: r.c.directMatches,
  transferable_matches: r.c.transferableMatches, baseline_met: r.c.baselineMet,
  occupational: r.c.occupational, core_gaps: r.c.coreGaps, gating_gaps: r.c.gatingGaps,
  unknown_gates: r.c.unknownGates, unresolved_core: r.c.unresolvedCore,
}));
for (let i = 0; i < rows.length; i += 200) {
  const { error } = await db.from("job_candidacy").upsert(rows.slice(i, i + 200),
    { onConflict: "job_id,profile_version,formula_version,taxonomy_version,model_version" });
  if (error) throw new Error(error.message);
}
console.log(`\npersisted ${rows.length} verdicts`);

// ---------------------------------------------------------------
// Application state cannot outlive the verdict that justified it.
// ---------------------------------------------------------------
//
// This upsert replaces verdicts in place. SpotHero was prepared and
// approved under one verdict, a later run wrote REJECT over it, and
// nothing looked at the application: it advertised itself as ready to
// send for two days while the authoritative verdict refused it.
//
// revalidateBeforeSubmit would have caught it at the moment of sending,
// but a queue that describes an application as ready when it is not is
// wrong in the meantime, and a person reads that queue.
//
// Nothing is deleted here and no submitted application is touched. The
// prepared document, its answers and its history stay where they are;
// only the claim the status makes about what may happen next changes.
{
  const verdictByJob = new Map(rows.map((r) => [r.job_id, r.verdict as string]));
  // Test applications are not reconciled. Thirteen of them sit approved
  // in AWAITING_REVIEW as fixtures, and a production scoring pass that
  // cleared their approvals would be rewriting the fixtures rather than
  // correcting anything real.
  const { data: apps } = await db.from("applications")
    .select("id,job_id,status,submitted_at,human_approved")
    .is("submitted_at", null)
    .or("is_test.is.null,is_test.eq.false");

  const states: ApplicationState[] = (apps ?? []).map((a: any) => ({
    id: a.id, status: a.status, submittedAt: a.submitted_at, humanApproved: Boolean(a.human_approved),
  }));
  const verdictByApplication = new Map<string, string | null>(
    (apps ?? []).map((a: any) => [a.id, verdictByJob.get(a.job_id) ?? null]));

  const changes = reconcileAll(states, verdictByApplication);
  if (!changes.length) {
    console.log("application state reconciliation: nothing to change");
  } else {
    console.log(`\napplication state reconciliation: ${changes.length} application(s)`);
    for (const c of changes) {
      const patch: Record<string, unknown> = {};
      if (c.from !== c.to) patch["status"] = c.to;
      if (c.clearApproval) {
        patch["human_approved"] = false;
        patch["human_approved_at"] = null;
        patch["approved_artifact_sha256"] = null;
        patch["approved_content_sha256"] = null;
        patch["approved_answers_sha256"] = null;
      }
      const { error } = await db.from("applications").update(patch).eq("id", c.applicationId);
      if (error) { console.log(`  ${c.applicationId.slice(0, 8)}: ${error.message}`); continue; }
      await db.from("application_events").insert({
        application_id: c.applicationId,
        event: "CANDIDACY_RECONCILED",
        detail: c.reason,
        actor: "system",
      });
      console.log(`  ${c.applicationId.slice(0, 8)}  ${c.from} -> ${c.to}${c.clearApproval ? ", approval cleared" : ""}`);
    }
  }
}
