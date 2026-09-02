/**
 * Discovery: finding companies that might be hiring.
 *
 * Kept separate from resolution on purpose. Getting a company's NAME and
 * working out which board it publishes to are different problems with
 * different failure modes, and conflating them is what produced a 35%
 * hit rate on the hand-written candidate list: those entries paired a
 * real company with a guessed token, so a wrong guess looked identical
 * to a company that does not exist.
 *
 * A source produces names and domains. Nothing here guesses a token.
 */

export type DiscoveryMethod =
  | "MANUAL" | "ATS_DIRECTORY" | "JOB_SOURCE" | "RELATED_COMPANY"
  | "SEED_LIST" | "VC_PORTFOLIO" | "PUBLIC_DIRECTORY" | "SEARCH" | "OTHER";

export interface DiscoveredCompany {
  name: string;
  domain: string | null;
  /** Where this came from, kept per company rather than per run. */
  sourceLabel: string;
  sourceUrl: string | null;
  method: DiscoveryMethod;
  industries: string[];
  /** Ordering only. A low score delays a company; it never removes one. */
  priorityScore: number;
  priorityReason: string | null;
  sizeMin: number | null;
  sizeMax: number | null;
  notes: string | null;
}

export interface DiscoverySource {
  readonly label: string;
  readonly method: DiscoveryMethod;
  /** Human-readable description of what this covers and what it misses. */
  readonly coverage: string;
  fetch(opts: { maxPages?: number; startPage?: number; signal?: AbortSignal }): Promise<{
    companies: DiscoveredCompany[];
    pagesFetched: number;
    warnings: string[];
  }>;
}

/** Bare host, lowercased, no protocol, no www, no path. Null when unusable. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split("/")[0]!.split("?")[0]!.split("#")[0]!;
  if (!s.includes(".") || s.length < 4) return null;
  // Hosts that are somebody else's platform, not the company's own site.
  if (/(^|\.)(google|facebook|linkedin|twitter|x|github|notion|medium|substack)\.com$/.test(s)) return null;
  return s;
}
