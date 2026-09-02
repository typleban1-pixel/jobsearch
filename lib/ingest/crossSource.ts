/**
 * The same job, posted in two places.
 *
 * `openings` groups postings within one board: Greenhouse publishes one
 * requisition as several posts, one per location, and that is already
 * handled. What it cannot see is the same role appearing on an
 * employer's Workday site AND their Greenhouse board, because an opening
 * is keyed by (company, source) and the source differs.
 *
 * Once several ATSs feed the corpus that stops being hypothetical, and a
 * duplicate is worse than a miss: it inflates the counts, and it invites
 * applying to one employer twice for one job.
 *
 * The matching here is deliberately strict. Titles must be equal after
 * normalization, never merely similar: "Marketing Manager" and "Senior
 * Marketing Manager" are different jobs, and a fuzzy matcher that scores
 * them close is a matcher that eventually merges them. Everything that
 * cannot be established is a reason NOT to merge.
 */
import { analyzeTitle } from "./normalize/title.ts";

export const CROSS_SOURCE_VERSION = 1;

export interface Candidate {
  jobId: string;
  companyId: string;
  source: string;
  title: string;
  /** Cities, lowercased. Empty means the posting states no location. */
  cities: string[];
  remote: boolean;
  postedAt: string | null;
  /** Hash of the description, when one was captured. */
  contentHash: string | null;
}

export type Verdict =
  | { same: true; because: string }
  | { same: false; because: string };

/** How far apart two postings of one role may be dated. */
const WINDOW_DAYS = 60;

const norm = (t: string) => analyzeTitle(t).normalizedTitle.toLowerCase().trim();

/**
 * Ranked by what we can DO with a posting, not by preference for a
 * vendor. A Greenhouse posting can be submitted end to end today; a
 * Workday posting is currently read-only. When the same job exists in
 * both, the one that can be applied to is the one worth keeping.
 */
const APPLICABILITY: Record<string, number> = {
  GREENHOUSE: 4, LEVER: 3, ASHBY: 2, WORKDAY: 1,
};

export function sameOpening(a: Candidate, b: Candidate): Verdict {
  if (a.jobId === b.jobId) return { same: false, because: "the same posting" };
  if (a.companyId !== b.companyId) return { same: false, because: "different employers" };
  if (a.source === b.source) {
    return { same: false, because: "same board; within-board grouping already handles this" };
  }

  const ta = norm(a.title), tb = norm(b.title);
  if (!ta || !tb) return { same: false, because: "a title normalized to nothing" };
  if (ta !== tb) return { same: false, because: `different roles: "${ta}" and "${tb}"` };

  // An identical description settles it regardless of geography: the
  // same words about the same role at the same employer is the same job.
  if (a.contentHash && b.contentHash && a.contentHash === b.contentHash) {
    return { same: true, because: "identical title and identical description text" };
  }

  const overlap = a.cities.filter((c) => b.cities.includes(c));
  const bothRemote = a.remote && b.remote;
  const bothPlaceless = a.cities.length === 0 && b.cities.length === 0;
  if (!overlap.length && !bothRemote) {
    if (bothPlaceless) {
      // Same employer, same role, neither states a place. Probably one
      // job, but "probably" is not the standard, and the cost of being
      // wrong is applying to one employer twice.
      return { same: false, because: "neither posting states a location, so sameness cannot be established" };
    }
    return { same: false, because: "no shared location and not both remote" };
  }

  if (a.postedAt && b.postedAt) {
    const gap = Math.abs(new Date(a.postedAt).getTime() - new Date(b.postedAt).getTime()) / 86_400_000;
    if (gap > WINDOW_DAYS) {
      return { same: false, because: `posted ${Math.round(gap)} days apart, beyond the ${WINDOW_DAYS}-day window` };
    }
  }

  return {
    same: true,
    because: overlap.length
      ? `same employer and role, sharing ${overlap[0]}`
      : "same employer and role, both remote",
  };
}

/**
 * Which of a duplicate set is the one to keep.
 *
 * The survivor is the posting that can actually be applied to, and ties
 * break toward the older record so an established job id does not churn.
 */
export function preferred(candidates: Candidate[]): Candidate {
  return [...candidates].sort((x, y) => {
    const rank = (APPLICABILITY[y.source] ?? 0) - (APPLICABILITY[x.source] ?? 0);
    if (rank !== 0) return rank;
    return String(x.postedAt ?? "").localeCompare(String(y.postedAt ?? ""));
  })[0]!;
}

/** Groups a company's postings into sets that are the same opening. */
export function groupDuplicates(candidates: Candidate[]): Array<{
  keep: Candidate; duplicates: Candidate[]; because: string;
}> {
  const claimed = new Set<string>();
  const groups: Array<{ keep: Candidate; duplicates: Candidate[]; because: string }> = [];

  for (const a of candidates) {
    if (claimed.has(a.jobId)) continue;
    const set = [a];
    let because = "";
    for (const b of candidates) {
      if (b.jobId === a.jobId || claimed.has(b.jobId)) continue;
      const v = sameOpening(a, b);
      if (v.same) { set.push(b); because = v.because; }
    }
    if (set.length === 1) continue;
    for (const c of set) claimed.add(c.jobId);
    const keep = preferred(set);
    groups.push({ keep, duplicates: set.filter((c) => c.jobId !== keep.jobId), because });
  }
  return groups;
}
