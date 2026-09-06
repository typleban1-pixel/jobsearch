/**
 * Full per-concept candidacy diagnosis for one job: every requirement
 * concept, its hardness (HARD/PREFERRED), its stratum, and how the profile
 * resolves it (DIRECT / TRANSFERABLE / UNKNOWN / ABSENT), plus the verdict.
 *   node scripts/candidacy-diagnose.ts <job-id-prefix>
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { TermMatcher } from "../lib/matching/match.ts";
import { toConcept } from "../lib/matching/concepts.ts";
import { buildFitBreakdown, FIT_FORMULA_VERSION } from "../lib/scoring/fit.ts";
import type { CapabilityIndex } from "../lib/scoring/capability.ts";
import { assessCandidacy, stratumOf, type RequirementRow } from "../lib/scoring/candidacy.ts";
import { buildEvidenceContext } from "../lib/scoring/evidenceResolution.ts";

const prefix = process.argv[2] ?? "";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const page = async (t: string, c: string, f: (q: any) => any = (q) => q) => { const o: any[] = [];
  for (let x = 0; ; x += 1000) { const { data, error } = await f(db.from(t).select(c)).range(x, x + 999);
    if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (!data || data.length < 1000) break; } return o; };

const allSkills = await page("skills", "id,name,related_terms,status");
const aliases = await page("term_aliases", "alias,canonical_term");
const matcher = new TermMatcher(allSkills.map((s: any) => ({ id: s.id, name: s.name, relatedTerms: s.related_terms ?? [], status: s.status })), aliases as any);
const verified = new Set(allSkills.filter((s: any) => s.status === "VERIFIED").map((s: any) => s.name));
const relations = new Map<string, any>();
for (const r of await page("capability_relations", "requirement_concept,satisfied_by_skill,relation,rationale")) {
  if (!verified.has(r.satisfied_by_skill)) continue;
  relations.set(toConcept(r.requirement_concept).concept, { skill: r.satisfied_by_skill, relation: r.relation, rationale: r.rationale }); }
const index: CapabilityIndex = { relations, matchTerm: (t: string) => { const m = matcher.match(t); return { status: m.status, skillName: m.skillName, method: m.method, terminal: m.terminal }; } };
const { data: credDecl } = await db.from("credential_declarations").select("family,status");
const cred: Record<string, string> = {}; for (const c of credDecl ?? []) cred[c.family] = c.status;
const { data: eduRows } = await db.from("education").select("credential,field_of_study,status,completed");
const edu = (eduRows ?? []).filter((e: any) => e.status === "VERIFIED" && e.completed).map((e: any) => ({
  level: /master|mba/i.test(e.credential ?? "") ? "MASTER" : /associate/i.test(e.credential ?? "") ? "ASSOCIATE" : "BACHELOR", field: e.field_of_study ?? null }));
const metrics = await page("metrics", "label,unit,numeric_value,approved_for_use");
const evidenceContext = buildEvidenceContext({ skills: allSkills as any, metrics: metrics as any, notHeld: [] });

const jobs = await page("jobs", "id,title,normalized_title,status,eligibility", (q) => prefix.length >= 36 ? q.eq("id", prefix) : q.eq("status","OPEN"));
const filtered = prefix.length >= 36 ? jobs : jobs.filter((j:any)=>j.id.startsWith(prefix));
for (const j of (prefix.length >= 36 ? jobs : filtered)) {
  const rs = await page("job_requirements", "id,job_id,normalized_term,raw_text,is_hard_requirement,minimum_years,kind,alternative_group,conjunct_key", (q) => q.eq("job_id", j.id));
  const reqById = new Map(rs.map((r: any) => [r.id, r]));
  const fit = buildFitBreakdown(rs, j.title, index, cred, edu as any, null, 0, evidenceContext);
  const c = assessCandidacy({ jobTitle: j.title, normalizedTitle: j.normalized_title, fit, requirements: rs as RequirementRow[], credentialDeclarations: cred });
  console.log(`\n=== ${j.title} (${j.id.slice(0, 8)}) ===`);
  console.log(`VERDICT: ${c.verdict} / ${c.reasonCodes[0]}  |  direct ${c.directMatches}, transferable ${c.transferableMatches}, hard ${c.hardMet}/${c.hardTotal}, baseline-met ${c.baselineMet}`);
  console.log(`reason: ${c.reason}`);
  console.log(`coreGaps: ${JSON.stringify(c.coreGaps)}  |  occupational: ${JSON.stringify(c.occupational.map((o: any) => `${o.concept}:${o.met ? "met" : "ABSENT"}/${o.resolution}`))}`);
  console.log(`\nCONCEPTS (${fit.concepts.length}):`);
  for (const cc of fit.concepts as any[]) {
    const strat = cc.hardness === "HARD" ? stratumOf(cc, reqById as any) : "-";
    console.log(`  [${(cc.hardness || "").padEnd(9)}|${String(strat).padEnd(11)}|${(cc.requirementClass || "").padEnd(16)}] ${(cc.resolution || "").padEnd(11)} credit=${cc.credit}${cc.isBaseline ? " BASELINE" : ""}  ${String(cc.concept).slice(0, 42)}`);
  }
}
process.exit(0);
