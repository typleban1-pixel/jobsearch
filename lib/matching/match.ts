import { normalizeTerm, termVariants } from "./normalize.ts";

/**
 * Deterministic term matching.
 *
 * Four outcomes, and NONE is the one that matters: the share of
 * requirement terms landing there is the miss rate, and that measured
 * number is what decides whether pgvector earns its place. Adding
 * embeddings before measuring would be buying a solution to an unmeasured
 * problem.
 *
 * Precedence is strict, cheapest and most certain first: exact, then a
 * curated alias, then the profile's own related_terms. A later method
 * never overrides an earlier one.
 */

export type MatchMethod = "EXACT" | "ALIAS" | "RELATED_TERM" | "NONE";

export interface MatchableSkill {
  id: string;
  name: string;
  relatedTerms: string[];
}

export interface MatchResult {
  method: MatchMethod;
  skillId: string | null;
  skillName: string | null;
  matchedTerm: string | null;
  queryTerm: string;
}

export class TermMatcher {
  private exact = new Map<string, MatchableSkill>();
  private related = new Map<string, MatchableSkill>();
  private aliases = new Map<string, string>();

  constructor(skills: MatchableSkill[], aliases: Array<{ alias: string; canonical_term: string }>) {
    for (const a of aliases) this.aliases.set(normalizeTerm(a.alias), normalizeTerm(a.canonical_term));
    for (const s of skills) {
      for (const v of termVariants(s.name)) if (!this.exact.has(v)) this.exact.set(v, s);
      for (const rt of s.relatedTerms) {
        for (const v of termVariants(rt)) if (!this.related.has(v)) this.related.set(v, s);
      }
    }
  }

  match(rawTerm: string): MatchResult {
    const query = normalizeTerm(rawTerm);
    const variants = termVariants(rawTerm);

    for (const v of variants) {
      const hit = this.exact.get(v);
      if (hit) return { method: "EXACT", skillId: hit.id, skillName: hit.name, matchedTerm: v, queryTerm: query };
    }

    for (const v of variants) {
      const canonical = this.aliases.get(v);
      if (!canonical) continue;
      for (const cv of termVariants(canonical)) {
        const hit = this.exact.get(cv) ?? this.related.get(cv);
        if (hit) {
          return { method: "ALIAS", skillId: hit.id, skillName: hit.name, matchedTerm: canonical, queryTerm: query };
        }
      }
    }

    for (const v of variants) {
      const hit = this.related.get(v);
      if (hit) return { method: "RELATED_TERM", skillId: hit.id, skillName: hit.name, matchedTerm: v, queryTerm: query };
    }

    return { method: "NONE", skillId: null, skillName: null, matchedTerm: null, queryTerm: query };
  }

  /** Vocabulary size, for reporting how much surface the matcher actually covers. */
  stats(): { exactKeys: number; relatedKeys: number; aliasKeys: number } {
    return { exactKeys: this.exact.size, relatedKeys: this.related.size, aliasKeys: this.aliases.size };
  }
}

export interface MissRateReport {
  total: number;
  byMethod: Record<MatchMethod, number>;
  missRate: number;
  topMisses: Array<{ term: string; count: number }>;
}

/**
 * Aggregates match outcomes. The top misses list is the working queue:
 * a term appearing 40 times and matching nothing is either an alias worth
 * adding or a real skill gap, and those are different conclusions that
 * only a human can tell apart.
 */
export function summarizeMisses(results: MatchResult[]): MissRateReport {
  const byMethod: Record<MatchMethod, number> = { EXACT: 0, ALIAS: 0, RELATED_TERM: 0, NONE: 0 };
  const missCounts = new Map<string, number>();
  for (const r of results) {
    byMethod[r.method]++;
    if (r.method === "NONE") missCounts.set(r.queryTerm, (missCounts.get(r.queryTerm) ?? 0) + 1);
  }
  return {
    total: results.length,
    byMethod,
    missRate: results.length ? byMethod.NONE / results.length : 0,
    topMisses: [...missCounts.entries()]
      .map(([term, count]) => ({ term, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 40),
  };
}
