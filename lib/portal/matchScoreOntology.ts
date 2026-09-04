/**
 * Match Score ontology layer (model A + B1), applied at read time.
 *
 * The stored candidacy/fit numbers are never rewritten -- this computes a
 * small DELTA to the three role-fit inputs (hardMet, hardTotal, hardDirect)
 * that matchScore() consumes, so any requirement set the ontology does not
 * touch keeps its exact production score. The delta is derived from the
 * SAME modules validated read-only over the whole corpus:
 *
 *   A  relationResolve  -- deterministic, additive concept relations
 *                          (equivalents, broader-entails-narrower, umbrellas
 *                          with a component threshold). Never downgrades an
 *                          existing DIRECT; adjacency is never DIRECT;
 *                          product-management is capped at TRANSFERABLE.
 *   B1 dedupeForVoting   -- interchangeable requirements (Excel + Sheets)
 *                          contribute ONE aggregate vote; every original
 *                          requirement is preserved elsewhere for
 *                          qualification, explanation, gaps and audit.
 *
 * Bumping MATCH_SCORE_MODEL records that the read-time model changed; the
 * prior model is recoverable by reverting the commit that wired this in.
 */
import { relationResolve, norm, type Resolution } from "../scoring/conceptRelations.ts";
import { dedupeForVoting } from "../scoring/conceptFamily.ts";

export const MATCH_SCORE_MODEL = "match-ontology-ab1@2026-09-04";
export const MATCH_SCORE_MODEL_PRIOR = "candidacy-direct@baseline";

/** A concept counts toward role fit only if it is a HARD requirement of a
 *  kind that expresses a capability -- the same filter the regression used. */
function counts(x: any): boolean {
  return !!x && x.hardness === "HARD"
    && ["SKILL", "OCCUPATIONAL", "GATING_CREDENTIAL"].includes(x.requirementClass);
}

export type OntologyDelta = { dMet: number; dTotal: number; dDirect: number };

/** The additive delta to (hardMet, hardTotal, hardDirect) for one job. */
export function ontologyDelta(conceptDetail: any[], profileHas: (n: string) => boolean): OntologyDelta {
  const cd = (conceptDetail ?? []).filter(counts);
  if (!cd.length) return { dMet: 0, dTotal: 0, dDirect: 0 };
  const met = (r: string) => r === "DIRECT" || r === "TRANSFERABLE";
  const bT = cd.length;
  const bD = cd.filter((x) => x.resolution === "DIRECT").length;
  const bM = cd.filter((x) => met(x.resolution)).length;
  const reA = cd.map((x) => ({
    concept: x.concept as string,
    resolution: relationResolve(x.concept, x.resolution as Resolution, profileHas).resolution,
  }));
  const votes = dedupeForVoting(reA);
  const aT = votes.length;
  const aD = votes.filter((v) => v.resolution === "DIRECT").length;
  const aM = votes.filter((v) => met(v.resolution)).length;
  return { dMet: aM - bM, dTotal: aT - bT, dDirect: aD - bD };
}

/** Apply a delta to the three inputs, floored at zero (matchScore clamps the
 *  rest internally, exactly as production already relies on). */
export function withOntology(
  base: { hardMet: number; hardTotal: number; hardDirect: number },
  delta: OntologyDelta,
): { hardMet: number; hardTotal: number; hardDirect: number } {
  return {
    hardMet: Math.max(0, base.hardMet + delta.dMet),
    hardTotal: Math.max(0, base.hardTotal + delta.dTotal),
    hardDirect: Math.max(0, base.hardDirect + delta.dDirect),
  };
}

/** Build the profile predicate from skill names, matching the substring
 *  containment the ontology modules expect. */
export function makeProfileHas(skillNames: string[]): (n: string) => boolean {
  const set = skillNames.map(norm).filter(Boolean);
  return (n: string) => {
    const q = norm(n);
    if (!q) return false;
    return set.some((s) => s === q || s.includes(q) || q.includes(s));
  };
}
