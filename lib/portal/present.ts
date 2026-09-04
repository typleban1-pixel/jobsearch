/**
 * Turning stored rows into what a person reads.
 *
 * Presentation only. Nothing here computes a score, ranks anything by a
 * formula of its own, or invents a number the database does not hold.
 * Sorting is by stored columns, so any order on screen can be checked
 * against the row.
 */
import type { JobCard, JobLocationRow } from "./db.ts";
import { compareAttention } from "./attentionRank.ts";

/** How a multi-location posting reads. Never collapses the set to one place. */
export function describeLocations(locations: JobLocationRow[], raw: string | null): string {
  if (locations.length === 0) return raw ?? "location not stated";
  const parts = locations.map((l) => {
    if (l.is_remote) return l.remote_scope ? `Remote (${l.remote_scope})` : "Remote (scope unstated)";
    return [l.city, l.state ?? l.region, l.country && l.country !== "US" ? l.country : null]
      .filter(Boolean).join(", ") || (l.raw_segment || "unresolved");
  });
  const unique = [...new Set(parts)];
  return unique.length <= 3 ? unique.join(" · ") : `${unique.slice(0, 3).join(" · ")} +${unique.length - 3} more`;
}

export function describeArrangement(policy: string | null): string {
  switch (policy) {
    case "FULLY_REMOTE": return "Remote";
    case "REMOTE_WITH_TRAVEL": return "Remote + travel";
    case "HYBRID": return "Hybrid";
    case "ONSITE": return "Onsite";
    default: return "Arrangement unstated";
  }
}

export function describeSalary(c: JobCard): string | null {
  if (c.salaryMin === null && c.salaryMax === null) return null;
  const unit = c.salaryPeriod === "HOURLY" ? "/hr" : "";
  const money = (n: number) => (c.salaryPeriod === "HOURLY" ? `$${n}` : `$${Math.round(n / 1000)}k`);
  const range = c.salaryMin !== null && c.salaryMax !== null && c.salaryMin !== c.salaryMax
    ? `${money(c.salaryMin)}–${money(c.salaryMax)}${unit}`
    : `${money((c.salaryMin ?? c.salaryMax)!)}${unit}`;
  return c.salaryIsEstimated ? `${range} (estimated)` : range;
}

/** Days since a date, or null when the source gave none. */
export function ageInDays(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

export function describeFreshness(c: JobCard): string {
  const posted = ageInDays(c.postedAt);
  if (posted === null) {
    const seen = ageInDays(c.firstSeenAt);
    return seen === null ? "date unknown" : `first seen ${seen}d ago`;
  }
  if (posted <= 0) return "posted today";
  return `posted ${posted}d ago`;
}

export type UncertaintyBand = "LOW" | "MODERATE" | "HIGH";
export function uncertaintyBand(u: number | null): UncertaintyBand {
  if (u === null) return "HIGH";
  if (u <= 10) return "LOW";
  if (u <= 30) return "MODERATE";
  return "HIGH";
}

/**
 * Evidence quality: how many distinct concepts were credited, out of how
 * many the posting stated and the system could judge.
 *
 * A COUNT, not a score. It exists because the ranking model is under
 * review and a job credited by one concept should be distinguishable from
 * one credited by five without inventing a second hidden formula.
 */
export function evidenceLabel(c: JobCard): string {
  if (c.evaluableCount === 0) return "no judgeable requirements";
  return `${c.creditedCount} of ${c.evaluableCount} matched`;
}

export type SortKey =
  | "match"
  | "attention"
  | "candidacy"
  | "evidence" | "fit" | "opportunity" | "uncertainty" | "freshness" | "salary" | "coverage";

export const SORTS: Array<{ key: SortKey; label: string; note: string }> = [
  { key: "match", label: "Best matches first", note: "the 0-100 Match Score, highest first" },
  { key: "attention", label: "Evidence-first (diagnostic)", note: "requirements met, then the evidence behind them" },
  { key: "candidacy", label: "Candidacy, then evidence", note: "candidates first, then stretches; never hides a stretch" },
  { key: "evidence", label: "Evidence, then Fit", note: "credited concepts first, Fit breaks ties" },
  { key: "fit", label: "Fit", note: "the stored Fit score alone" },
  { key: "opportunity", label: "Opportunity", note: "salary, remote and location signals" },
  { key: "coverage", label: "Coverage points", note: "the evidence-derived part of Fit only" },
  { key: "uncertainty", label: "Least uncertain", note: "lowest uncertainty first" },
  { key: "freshness", label: "Newest", note: "by posted date, then first seen" },
  { key: "salary", label: "Salary", note: "highest stated maximum first; unknown last" },
];

/**
 * The working queue's order, not a filter.
 *
 * APPLICATION_CANDIDATE sorts above STRETCH because it is a stronger
 * statement, and both sort above everything else. Nothing is hidden:
 * a rejected job still appears, below, with its verdict visible.
 */
const CANDIDACY_ORDER: Record<string, number> = {
  APPLICATION_CANDIDATE: 0, STRETCH: 1, MANUAL_REVIEW: 2, REJECT: 3,
};
const candidacyRank = (c: JobCard) =>
  c.candidacy && !c.candidacy.stale ? CANDIDACY_ORDER[c.candidacy.verdict] ?? 4 : 4;

export function sortCards(cards: JobCard[], key: SortKey): JobCard[] {
  const out = [...cards];
  switch (key) {
    // The authoritative user-facing order: the calibrated 0-100 Match
    // Score, highest first, so #1 is the best viable match currently
    // evaluated. A materially higher score always ranks above a lower one
    // -- the evidence-first ranking never puts a 54 above a 71. Confidence
    // is a secondary consideration only among equal scores (a confident
    // score sorts above a provisional one of the same value); the
    // evidence-first Formula 3 ordering (compareAttention) and stored Fit
    // break ties after that; and the opening/job id is a final stable
    // deterministic tie-breaker so the order never jumps between loads.
    // Match Score, candidacy, Formula 3 and eligibility are all unchanged;
    // this only decides which of them the reader-facing order leads with.
    case "match":
      return out.sort((a, b) =>
        b.match.score - a.match.score
        || (a.match.provisional ? 1 : 0) - (b.match.provisional ? 1 : 0)
        || compareAttention(a.attention, b.attention)
        || b.fit - a.fit
        || String(a.id).localeCompare(String(b.id)));
    // The default. Ordered by what the employer asked for and what is
    // actually evidenced, with jobs whose requirements cannot be
    // assessed kept in their own band below rather than buried by a
    // coverage figure that means nothing. Nothing is hidden.
    case "attention":
      return out.sort((a, b) => compareAttention(a.attention, b.attention)
        || b.fit - a.fit);
    case "candidacy":
      return out.sort((a, b) => candidacyRank(a) - candidacyRank(b)
        || b.creditedCount - a.creditedCount || b.fit - a.fit);
    case "evidence":
      // Two stored counts and the stored Fit. No new formula: a job with
      // more independent matched concepts sorts above one with fewer, and
      // Fit only breaks ties inside a tier.
      return out.sort((a, b) => b.creditedCount - a.creditedCount || b.fit - a.fit);
    case "fit": return out.sort((a, b) => b.fit - a.fit);
    case "opportunity": return out.sort((a, b) => (b.opportunity ?? -999) - (a.opportunity ?? -999) || b.fit - a.fit);
    case "coverage": return out.sort((a, b) => b.coveragePoints - a.coveragePoints || b.fit - a.fit);
    case "uncertainty": return out.sort((a, b) => (a.uncertainty ?? 999) - (b.uncertainty ?? 999) || b.fit - a.fit);
    case "freshness":
      return out.sort((a, b) => {
        const av = a.postedAt ?? a.firstSeenAt ?? "", bv = b.postedAt ?? b.firstSeenAt ?? "";
        return bv.localeCompare(av);
      });
    case "salary":
      return out.sort((a, b) => (b.salaryMax ?? b.salaryMin ?? -1) - (a.salaryMax ?? a.salaryMin ?? -1) || b.fit - a.fit);
  }
}

export interface Filters {
  q: string;
  metro: string;      // "any" | "chicagoland" | "remote"
  interest: string;   // "active" | "saved" | "dismissed" | "all"
  minEvidence: number;
  maxUncertainty: number | null;
  salaryKnown: boolean;
  stretchOnly: boolean;
  /**
   * Which candidacy verdicts the feed shows.
   *
   * "actionable" (the default) hides REJECT. Candidacy exists to cut the
   * pile down; showing a job the model already decided against next to
   * ones it did not spends the reader's attention on work already done.
   *
   * "skipped" shows only REJECT, so the model's decisions stay auditable
   * rather than disappearing. It is deliberately separate from the
   * interest filter's "dismissed": that records a decision Ty made, this
   * records one the model made, and collapsing them would lose which.
   */
  candidacy: "actionable" | "skipped" | "all";
}

export const DEFAULT_FILTERS: Filters = {
  q: "", metro: "any", interest: "active", minEvidence: 0,
  maxUncertainty: null, salaryKnown: false, stretchOnly: false,
  candidacy: "actionable",
};

export function applyFilters(cards: JobCard[], f: Filters): JobCard[] {
  const q = f.q.trim().toLowerCase();
  return cards.filter((c) => {
    // activeInterest, not interest: a row cleared back to UNDECIDED is
    // undecided, and belongs in the working list again.
    if (f.interest === "active" && c.activeInterest !== null) return false;
    if (f.interest === "saved" && c.activeInterest !== "SAVED") return false;
    if (f.interest === "dismissed" && c.activeInterest !== "NOT_INTERESTED") return false;
    if (q && !(`${c.title} ${c.company}`.toLowerCase().includes(q))) return false;
    if (f.metro === "chicagoland" && !c.locations.some((l) => l.metro === "Chicagoland")) return false;
    if (f.metro === "remote" && !c.locations.some((l) => l.is_remote)) return false;
    if (c.creditedCount < f.minEvidence) return false;
    if (f.maxUncertainty !== null && (c.uncertainty ?? 999) > f.maxUncertainty) return false;
    if (f.salaryKnown && c.salaryMin === null && c.salaryMax === null) return false;
    if (f.stretchOnly && c.recommendation !== "STRETCH") return false;
    // Presentation only. The verdict is untouched in the database; this
    // decides whether the reader is shown it right now.
    //
    // A job with no candidacy row at all stays visible: unscored is not
    // rejected, and hiding it would bury exactly the jobs still needing
    // a decision.
    const verdict = c.candidacy?.verdict ?? null;
    if (f.candidacy === "actionable" && verdict === "REJECT") return false;
    if (f.candidacy === "skipped" && verdict !== "REJECT") return false;
    return true;
  });
}
