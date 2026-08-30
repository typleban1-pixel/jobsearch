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

/**
 * Whether the skill behind a match is verified.
 *
 * This distinction is load bearing and the user named it directly: an
 * unverified skill must behave as UNKNOWN, never as a confirmed absence.
 * Without it, a conservative first profile would manufacture thousands of
 * fake skill gaps, and the resulting scores would say more about how much
 * of the profile had been reviewed than about the person.
 */
export type MatchStatus = "VERIFIED" | "SUGGESTED" | "NONE";

export interface MatchableSkill {
  id: string;
  name: string;
  relatedTerms: string[];
  /** SUGGESTED skills match, but their match means "not yet known". */
  status?: "VERIFIED" | "SUGGESTED";
}

export interface MatchResult {
  method: MatchMethod;
  status: MatchStatus;
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
    // Verified first, so a term that matches both a verified and a
    // suggested skill resolves to the verified one.
    const ordered = [...skills].sort((a, b) =>
      (a.status === "VERIFIED" ? 0 : 1) - (b.status === "VERIFIED" ? 0 : 1));
    for (const s of ordered) {
      for (const v of termVariants(s.name)) if (!this.exact.has(v)) this.exact.set(v, s);
      for (const rt of s.relatedTerms) {
        for (const v of termVariants(rt)) if (!this.related.has(v)) this.related.set(v, s);
      }
    }
  }

  private hit(method: MatchMethod, skill: MatchableSkill, matchedTerm: string, query: string): MatchResult {
    return {
      method,
      status: skill.status === "SUGGESTED" ? "SUGGESTED" : "VERIFIED",
      skillId: skill.id, skillName: skill.name, matchedTerm, queryTerm: query,
    };
  }

  match(rawTerm: string): MatchResult {
    const query = normalizeTerm(rawTerm);
    const variants = termVariants(rawTerm);

    for (const v of variants) {
      const found = this.exact.get(v);
      if (found) return this.hit("EXACT", found, v, query);
    }

    for (const v of variants) {
      const canonical = this.aliases.get(v);
      if (!canonical) continue;
      for (const cv of termVariants(canonical)) {
        const found = this.exact.get(cv) ?? this.related.get(cv);
        if (found) return this.hit("ALIAS", found, canonical, query);
      }
    }

    for (const v of variants) {
      const found = this.related.get(v);
      if (found) return this.hit("RELATED_TERM", found, v, query);
    }

    return { method: "NONE", status: "NONE", skillId: null, skillName: null, matchedTerm: null, queryTerm: query };
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
