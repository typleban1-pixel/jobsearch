#!/usr/bin/env -S node --env-file=.env.local
/**
 * GATED shadow sample: run the REAL extraction + fit + candidacy + Match Score
 * on a small stratified sample of the CLEAN shadow-discovery cohort, entirely
 * in-memory. Creates no jobs, no applications, no authorizations; writes nothing
 * to the DB; alters no discovery membership. The only paid step is one small
 * "fast"-tier extraction call per sampled posting.
 *
 * Reads the sample pool ($CLAUDE_JOB_DIR/tmp/shadow_pool_uniq.json) and the
 * stratified spec (sample_spec.json), resolves each to a real live posting, and
 * runs the exact production path from score-candidacy.ts (buildFitBreakdown WITH
 * evidenceContext -> assessCandidacy) plus the /jobs Match Score assembly and
 * the same decide()/material-gap the autonomous policy uses.
 *
 *   node --env-file=.env.local scripts/shadow-sample-candidacy.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { AnthropicProvider } from "../lib/llm/anthropic.ts";
import { extractRequirements, sanitizeRequirement, reconcileHardness, dedupeRequirements } from "../lib/llm/extractRequirements.ts";
import { buildFitBreakdown, FIT_FORMULA_VERSION } from "../lib/scoring/fit.ts";
import { assessCandidacy, CANDIDACY_MODEL_VERSION, type RequirementRow } from "../lib/scoring/candidacy.ts";
import { TAXONOMY_VERSION } from "../lib/scoring/requirementClass.ts";
import { TermMatcher } from "../lib/matching/match.ts";
import { toConcept } from "../lib/matching/concepts.ts";
import { buildEvidenceContext } from "../lib/scoring/evidenceResolution.ts";
import type { CapabilityIndex } from "../lib/scoring/capability.ts";
import { matchScore, matchLabel } from "../lib/portal/matchScore.ts";
import { buildAttentionInput, attentionScore } from "../lib/portal/attentionRank.ts";
import { hasMaterialQualificationGap } from "../lib/applications/revalidate.ts";
import { decide, readPolicy, readSwitches, type Candidate } from "../lib/automation/policy.ts";

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const page = async <T,>(t: string, c: string): Promise<T[]> => { const o: T[] = []; for (let x = 0; ; x += 1000) { const { data, error } = await db.from(t).select(c).range(x, x + 999); if (error) throw new Error(`${t}: ${error.message}`); o.push(...(data as T[])); if (!data || data.length < 1000) break; } return o; };

// ---- profile index + evidence (mirrors score-candidacy.ts:28-56) -------
const { data: prof } = await db.from("profile").select("profile_version").single();
const allSkills = await page<any>("skills", "id,name,related_terms,status,level,category");
const aliases = await page<any>("term_aliases", "alias,canonical_term");
const matcher = new TermMatcher(allSkills.map((s) => ({ id: s.id, name: s.name, relatedTerms: s.related_terms ?? [], status: s.status })), aliases as any);
const verified = new Set(allSkills.filter((s) => s.status === "VERIFIED").map((s) => s.name));
const relations = new Map<string, any>();
for (const r of await page<any>("capability_relations", "requirement_concept,satisfied_by_skill,relation,rationale")) {
  if (!verified.has(r.satisfied_by_skill)) continue;
  relations.set(toConcept(r.requirement_concept).concept, { skill: r.satisfied_by_skill, relation: r.relation, rationale: r.rationale });
}
const index: CapabilityIndex = { relations, matchTerm: (t: string) => { const m = matcher.match(t); return { status: m.status, skillName: m.skillName, method: m.method, terminal: m.terminal }; } };
const { data: credDecl } = await db.from("credential_declarations").select("family,status");
const cred: Record<string, string> = {}; for (const c of credDecl ?? []) cred[c.family] = c.status;
const { data: eduRows } = await db.from("education").select("credential,field_of_study,status,completed");
const edu = (eduRows ?? []).filter((e: any) => e.status === "VERIFIED" && e.completed).map((e: any) => ({ level: /master|mba/i.test(e.credential ?? "") ? "MASTER" : /associate/i.test(e.credential ?? "") ? "ASSOCIATE" : "BACHELOR", field: e.field_of_study ?? null }));
const metrics = await page<any>("metrics", "label,unit,numeric_value,approved_for_use");
const evidenceContext = buildEvidenceContext({ skills: allSkills as any, metrics: metrics as any, notHeld: [] });
const policy = await readPolicy(db); const switches = await readSwitches(db);
console.error(`profile v${prof!.profile_version}, formula ${FIT_FORMULA_VERSION}, taxonomy ${TAXONOMY_VERSION}, model ${CANDIDACY_MODEL_VERSION}; ${relations.size} relations, ${evidenceContext.verifiedCategories.size} verified categories`);

// ---- resolve the sample ------------------------------------------------
const pool: any[] = JSON.parse(readFileSync(process.env.CLAUDE_JOB_DIR + "/tmp/shadow_pool_uniq.json", "utf8"));
const spec: any[] = JSON.parse(readFileSync(process.env.CLAUDE_JOB_DIR + "/tmp/sample_spec.json", "utf8"));
const n = (s: string) => (s ?? "").toLowerCase();
const sample = spec.map((s) => { const job = pool.find((p) => n(p.employer).includes(n(s.employer)) && n(p.title).includes(n(s.match))); return job ? { ...job, why: s.why, plannedSubstance: s.substance } : null; }).filter(Boolean) as any[];
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT) : sample.length;
console.error(`resolved ${sample.length}/${spec.length} sample jobs; running ${LIMIT}\n`);

const llm = new AnthropicProvider();
let inTok = 0, outTok = 0;
const rows: any[] = [];
for (const j of sample.slice(0, LIMIT)) {
 try {
  let extracted: any;
  try { const r = await extractRequirements(llm, { title: j.title, company: j.employer, descriptionText: j.descriptionText }); extracted = r.content; if (r.usage) { inTok += r.usage.inputTokens ?? 0; outTok += r.usage.outputTokens ?? 0; } }
  catch (e) { rows.push({ ...j, error: `extraction failed: ${(e as Error).message}` }); continue; }
  let reqs: any[] = [];
  for (const raw of extracted.requirements ?? []) { const clean = sanitizeRequirement(raw); if (!clean) continue; const rec = reconcileHardness(clean.requirement); if (rec.corrected) clean.requirement.is_hard_requirement = rec.hardness; reqs.push(clean.requirement); }
  reqs = dedupeRequirements(reqs).kept;
  const rr = reqs.map((r, i) => ({ id: `adhoc-${i}`, raw_text: r.raw_text, normalized_term: r.normalized_term, is_hard_requirement: r.is_hard_requirement, kind: r.kind, minimum_years: r.minimum_years, alternative_group: null, conjunct_key: null }));
  const fit = buildFitBreakdown(rr as any, j.title, index, cred, edu as any, null, 0, evidenceContext);
  const c = assessCandidacy({ jobTitle: j.title, normalizedTitle: null, fit, requirements: rr as RequirementRow[], credentialDeclarations: cred });
  const ai = buildAttentionInput({ candidacy: { hardMet: c.hardMet, hardTotal: c.hardTotal, transferableMatches: c.transferableMatches, coreGaps: c.coreGaps.length }, conceptDetail: fit.concepts as any, salary: null });
  const ms = matchScore({ hardMet: c.hardMet, hardTotal: c.hardTotal, hardDirect: ai.hardDirect, coverage: typeof fit.coverage === "number" ? fit.coverage : null, coreGaps: c.coreGaps.length, gatingGaps: c.gatingGaps.length, educationGatesUnmet: fit.educationGatesUnmet, unresolvedCore: c.unresolvedCore.length, excludedUnknown: fit.excludedUnknown, seniorityAligned: null, salary: null, eligibility: "ELIGIBLE", uncertaintyScore: null, scorable: fit.scorable, assessable: attentionScore(ai).band === "ASSESSABLE" });
  const matGap = hasMaterialQualificationGap({ candidacyVerdict: c.verdict, candidacyReasonCode: c.reasonCodes[0] ?? null, hardMet: c.hardMet, hardTotal: c.hardTotal });
  const disp = decide({ jobId: "shadow", companyId: "shadow", provider: j.provider, candidacy: c.verdict, candidacyReasonCode: c.reasonCodes[0] ?? null, hardMet: c.hardMet, hardTotal: c.hardTotal, eligibility: "ELIGIBLE", matchScore: null, baseSalaryMin: j.salaryMin ?? null, allFieldsConfident: true, blockedAnswers: 0, resumeClaimsAllGrounded: true, artifactValid: true, submittedToday: 0 } as Candidate, policy, switches);
  const directConcepts = (fit.concepts as any[]).filter((x) => x.resolution === "DIRECT" && (x.credit ?? 0) > 0).map((x) => x.concept);
  const rec = { employer: j.employer, title: j.title, provider: j.provider, geo: j.geo, metro: j.metro, state: j.state, url: j.url, why: j.why, plannedSubstance: j.plannedSubstance, verdict: c.verdict, reasonCode: c.reasonCodes[0] ?? null, reasonCodes: c.reasonCodes, hardMet: c.hardMet, hardTotal: c.hardTotal, directMatches: c.directMatches, transferableMatches: c.transferableMatches, coreGaps: c.coreGaps, matGap, matchScore: ms.score, matchLabel: matchLabel(ms.score, ms.provisional), matchNote: ms.note ?? null, autonomous: disp.action === "SUBMIT", dispAction: disp.action, dispWhy: disp.why, strongestEvidence: directConcepts.slice(0, 4), reqCount: rr.length };
  rows.push(rec);
  process.stderr.write(`  ${(rec.verdict ?? "ERR").padEnd(20)} ${String(rec.hardMet)+"/"+String(rec.hardTotal)} MS=${rec.matchScore ?? "-"} ${rec.autonomous ? "AUTO" : rec.dispAction} ${j.provider[0]}/${j.geo[0]} ${j.employer.slice(0,14).padEnd(15)} ${j.title.slice(0,40)}\n`);
 } catch (e) { rows.push({ employer: j.employer, title: j.title, provider: j.provider, error: (e as Error).message }); process.stderr.write(`  ERROR ${j.employer} ${j.title.slice(0,30)}: ${(e as Error).message}\n`); }
}
const usd = +((inTok / 1e6) * 0.80 + (outTok / 1e6) * 4.0).toFixed(4); // haiku-class fast tier approx
writeFileSync(process.env.CLAUDE_JOB_DIR + "/tmp/shadow_sample_results.json", JSON.stringify({ rows, cost: { inTok, outTok, usd } }, null, 2));
console.error(`\ntokens in=${inTok} out=${outTok}  approx cost $${usd}`);
console.log("WROTE " + process.env.CLAUDE_JOB_DIR + "/tmp/shadow_sample_results.json");
