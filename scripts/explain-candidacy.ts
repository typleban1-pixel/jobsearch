/**
 * Why one job got the verdict it got, before and after the corrections.
 *
 *   node scripts/explain-candidacy.ts <job-id-prefix> [...]
 *
 * Runs the same pipeline twice, once with the OR collapse and the
 * evidence layer and once without, and prints every concept whose
 * resolution differs. A verdict that moves without a concept moving is a
 * defect, and this is how that is seen rather than assumed.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { buildFitBreakdown, FIT_FORMULA_VERSION } from "../lib/scoring/fit.ts";
import type { CapabilityIndex } from "../lib/scoring/capability.ts";
import { TAXONOMY_VERSION } from "../lib/scoring/requirementClass.ts";
import { assessCandidacy, CANDIDACY_MODEL_VERSION, type RequirementRow } from "../lib/scoring/candidacy.ts";
import { TermMatcher } from "../lib/matching/match.ts";
import { toConcept } from "../lib/matching/concepts.ts";
import { buildEvidenceContext } from "../lib/scoring/evidenceResolution.ts";

const prefixes = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!prefixes.length) { console.log("usage: explain-candidacy.ts <job-id-prefix> [...]"); process.exit(1); }
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
const index: CapabilityIndex = { relations, matchTerm: (t: string) => { const m = matcher.match(t); return { status: m.status, skillName: m.skillName, method: m.method, terminal: m.terminal }; } };
const { data: credDecl } = await db.from("credential_declarations").select("family,status");
const cred: Record<string, string> = {}; for (const c of credDecl ?? []) cred[c.family] = c.status;
const { data: eduRows } = await db.from("education").select("credential,field_of_study,status,completed");
const edu = (eduRows ?? []).filter((e: any) => e.status === "VERIFIED" && e.completed).map((e: any) => ({
  level: /master|mba/i.test(e.credential ?? "") ? "MASTER" : /associate/i.test(e.credential ?? "") ? "ASSOCIATE" : "BACHELOR", field: e.field_of_study ?? null }));
const metrics = await page("metrics", "label,unit,numeric_value,approved_for_use");
const ev = buildEvidenceContext({ skills: allSkills as any, metrics: metrics as any, notHeld: [] });

for (const pre of prefixes) {
  // uuid columns do not accept ilike, so the prefix is matched here.
  const jobs = (await page("jobs", "id,title,company_id,normalized_title,status,eligibility"))
    .filter((x: any) => x.id.startsWith(pre));
  const j = jobs[0];
  if (!j) { console.log(`\n${pre}: no such job`); continue; }
  const { data: co } = await db.from("companies").select("name").eq("id", j.company_id).maybeSingle();
  const { data: rs } = await db.from("job_requirements")
    .select("id,job_id,normalized_term,raw_text,is_hard_requirement,minimum_years,kind,alternative_group,conjunct_key")
    .eq("job_id", j.id);

  const before = buildFitBreakdown(rs as any, j.title, index, cred, edu as any, null, 0, null);
  // The OR grouping lives in the rows, so "before" also has to have it removed.
  const ungrouped = (rs ?? []).map((r: any) => ({ ...r, alternative_group: null, conjunct_key: null }));
  const trulyBefore = buildFitBreakdown(ungrouped as any, j.title, index, cred, edu as any, null, 0, null);
  const after = buildFitBreakdown(rs as any, j.title, index, cred, edu as any, null, 0, ev);
  const cBefore = assessCandidacy({ jobTitle: j.title, normalizedTitle: j.normalized_title, fit: trulyBefore, requirements: ungrouped as RequirementRow[], credentialDeclarations: cred });
  const cAfter = assessCandidacy({ jobTitle: j.title, normalizedTitle: j.normalized_title, fit: after, requirements: rs as RequirementRow[], credentialDeclarations: cred });
  void before;

  console.log(`\n${"=".repeat(78)}\n${co?.name ?? "?"} — ${j.title}\n  job ${j.id}  (${j.status}/${j.eligibility})`);
  const groups = new Map<string, any[]>();
  for (const r of rs ?? []) if (r.alternative_group) groups.set(r.alternative_group, [...(groups.get(r.alternative_group) ?? []), r]);
  console.log(`\n  employer-authored alternative groups: ${groups.size}`);
  for (const [g, ms] of groups) {
    console.log(`    group ${g.slice(0, 8)}:`);
    for (const m of ms) console.log(`      [${m.conjunct_key?.slice(0, 6) ?? "-"}] ${JSON.stringify(m.raw_text)}`);
  }

  const key = (c: any) => c.concept;
  const b = new Map((trulyBefore.concepts as any[]).map((c) => [key(c), c]));
  const a = new Map((after.concepts as any[]).map((c) => [key(c), c]));
  console.log(`\n  concepts: ${b.size} before, ${a.size} after`);
  const names = [...new Set([...b.keys(), ...a.keys()])].sort();
  for (const n of names) {
    const x = b.get(n); const y = a.get(n);
    const fmt = (c: any) => c ? `${c.resolution}/${c.credit === null ? "null" : c.credit}${c.hardness === "HARD" ? " HARD" : ""}` : "(gone)";
    if (x && y && fmt(x) === fmt(y)) continue;
    console.log(`    ${n}`);
    console.log(`      before ${fmt(x)}   after ${fmt(y)}`);
    if (y?.rationale && (!x || x.rationale !== y.rationale)) console.log(`      why: ${String(y.rationale).slice(0, 200)}`);
  }
  const line = (label: string, c: any, f: any) =>
    console.log(`  ${label.padEnd(7)} ${c.verdict.padEnd(22)} ${c.reasonCodes.join(",").padEnd(26)} hard ${c.hardMet}/${c.hardTotal}  cov ${f.coverage === null ? "null" : f.coverage.toFixed(3)}  gaps [${c.coreGaps.join(" | ")}]`);
  console.log("");
  line("before", cBefore, trulyBefore);
  line("after", cAfter, after);
  console.log(`  reason: ${cAfter.reason}`);

  const { data: apps } = await db.from("applications").select("id,status,human_approved,submitted_at,is_test").eq("job_id", j.id);
  for (const ap of apps ?? []) console.log(`  application ${ap.id.slice(0, 8)}  ${ap.status}  approved=${ap.human_approved}  submitted=${ap.submitted_at ?? "no"}  test=${ap.is_test ?? false}`);
}
