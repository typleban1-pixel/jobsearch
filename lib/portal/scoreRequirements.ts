/**
 * The 0-100 Match Score for a set of requirements NOT tied to an ingested
 * job -- the pasted posting in the Resume Builder.
 *
 * There is NO second scoring formula. This runs the exact same
 * buildFitBreakdown + assessCandidacy + matchScore() that the ingest
 * pipeline and /jobs use, against the same authoritative profile evidence
 * (verified skills, credential declarations, education). For an
 * assessable posting the score is driven by role-defining coverage
 * (hardMet/hardTotal/hardDirect), which is corpus-independent, so the same
 * requirements score the same here as on /jobs.
 *
 * Runs on the worker (it reads the profile through the service client).
 * Seniority alignment is genuinely unknown for a pasted posting (there is
 * no structured seniority field), so it is left null unless supplied.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { TermMatcher } from "../matching/match.ts";
import { toConcept } from "../matching/concepts.ts";
import { buildFitBreakdown } from "../scoring/fit.ts";
import type { CapabilityIndex } from "../scoring/capability.ts";
import { assessCandidacy } from "../scoring/candidacy.ts";
import { matchScore, type MatchScoreResult } from "./matchScore.ts";
import { buildAttentionInput, attentionScore } from "./attentionRank.ts";

export interface ScoreRequirement {
  raw_text?: string | null; normalized_term?: string | null; is_hard_requirement?: string | null;
  kind?: string | null; minimum_years?: number | null;
}

export interface WhyThisScore {
  hardMet: number; hardTotal: number;
  directMatches: number; transferableMatches: number;
  gaps: string[];
  seniority: "aligned" | "mismatch" | "unknown";
  uncertaintyNote: string | null;
}

export interface ScoredPosting { match: MatchScoreResult; why: WhyThisScore }

async function page(db: SupabaseClient, t: string, c: string): Promise<any[]> {
  const out: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await db.from(t).select(c).range(f, f + 999);
    if (!data?.length) break; out.push(...data); if (data.length < 1000) break;
  }
  return out;
}

async function profileIndex(db: SupabaseClient) {
  const [skills, aliases, relRows, credDecl, eduRows] = await Promise.all([
    page(db, "skills", "id,name,related_terms,status"),
    page(db, "term_aliases", "alias,canonical_term"),
    page(db, "capability_relations", "requirement_concept,satisfied_by_skill,relation,rationale"),
    page(db, "credential_declarations", "family,status"),
    page(db, "education", "credential,field_of_study,status,completed"),
  ]);
  const verifiedNames = new Set(skills.filter((s) => s.status === "VERIFIED").map((s) => s.name));
  const matcher = new TermMatcher(
    skills.map((s) => ({ id: s.id, name: s.name, relatedTerms: s.related_terms ?? [], status: s.status })), aliases as any);
  const relations = new Map<string, { skill: string; relation: "DIRECT" | "TRANSFERABLE"; rationale: string }>();
  for (const r of relRows) {
    if (!verifiedNames.has(r.satisfied_by_skill)) continue;
    relations.set(toConcept(r.requirement_concept).concept, { skill: r.satisfied_by_skill, relation: r.relation, rationale: r.rationale });
  }
  const index: CapabilityIndex = {
    relations,
    matchTerm: (t: string) => { const m = matcher.match(t); return { status: m.status, skillName: m.skillName, method: m.method, terminal: m.terminal }; },
  };
  const credentialDeclarations: Record<string, string> = {};
  for (const c of credDecl) credentialDeclarations[c.family] = c.status;
  const profileEducation = eduRows.filter((e) => e.status === "VERIFIED" && e.completed).map((e) => ({
    level: /master|mba/i.test(e.credential ?? "") ? "MASTER" : /doctor|phd/i.test(e.credential ?? "") ? "DOCTORATE"
      : /associate/i.test(e.credential ?? "") ? "ASSOCIATE" : "BACHELOR",
    field: e.field_of_study ?? null,
  }));
  return { index, credentialDeclarations, profileEducation };
}

export async function scoreRequirements(
  db: SupabaseClient,
  input: { requirements: ScoreRequirement[]; title: string; salary: number | null; eligibility: string; seniorityAligned?: boolean | null },
): Promise<ScoredPosting> {
  const { index, credentialDeclarations, profileEducation } = await profileIndex(db);
  const reqs = input.requirements.map((r, i) => ({
    id: `paste-${i}`, raw_text: String(r.raw_text ?? ""), normalized_term: r.normalized_term ?? null,
    is_hard_requirement: String(r.is_hard_requirement ?? "UNCLEAR"),
    kind: (r.kind ?? undefined) as any, minimum_years: r.minimum_years ?? null,
  }));

  const fit = buildFitBreakdown(reqs, input.title, index, credentialDeclarations, profileEducation);
  const cand = assessCandidacy({ jobTitle: input.title, fit, requirements: reqs as any, credentialDeclarations });

  const ai = buildAttentionInput({
    candidacy: { hardMet: cand.hardMet, hardTotal: cand.hardTotal, transferableMatches: cand.transferableMatches, coreGaps: cand.coreGaps.length },
    conceptDetail: fit.concepts as any, salary: input.salary,
  });

  const match = matchScore({
    hardMet: cand.hardMet, hardTotal: cand.hardTotal, hardDirect: ai.hardDirect,
    coverage: typeof fit.coverage === "number" ? fit.coverage : null,
    coreGaps: cand.coreGaps.length, gatingGaps: cand.gatingGaps.length,
    educationGatesUnmet: fit.educationGatesUnmet, unresolvedCore: cand.unresolvedCore.length,
    excludedUnknown: fit.excludedUnknown,
    seniorityAligned: input.seniorityAligned ?? null,
    salary: input.salary, eligibility: input.eligibility,
    uncertaintyScore: null, scorable: fit.scorable, assessable: attentionScore(ai).band === "ASSESSABLE",
  });

  const why: WhyThisScore = {
    hardMet: cand.hardMet, hardTotal: cand.hardTotal,
    directMatches: cand.directMatches, transferableMatches: cand.transferableMatches,
    gaps: cand.coreGaps.slice(0, 6),
    seniority: input.seniorityAligned === true ? "aligned" : input.seniorityAligned === false ? "mismatch" : "unknown",
    uncertaintyNote: fit.excludedUnknown > 0 ? `${fit.excludedUnknown} requirement${fit.excludedUnknown > 1 ? "s" : ""} couldn't be evaluated`
      : cand.unresolvedCore.length > 0 ? `${cand.unresolvedCore.length} important requirement${cand.unresolvedCore.length > 1 ? "s" : ""} unresolved` : null,
  };
  return { match, why };
}
