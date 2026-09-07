/**
 * Where a job came from, and where the real posting is.
 *
 * "Found via" is the applicant-tracking system the posting was fetched
 * from: this system discovers jobs by reading the employers' own ATS
 * boards, so the discovery source and the canonical posting are the same
 * place today. There is no aggregator ingest (no LinkedIn, no Indeed); if
 * one is ever added, the two will differ and the card copy below already
 * separates them.
 */
import { sourceLabel } from "./presentationState.ts";

export interface PostingLinkInput {
  source: string | null | undefined;
  url: string | null | undefined;
  applyUrl?: string | null | undefined;
  status?: string | null | undefined;
  statusChangedAt?: string | null | undefined;
}

export interface PostingLink {
  /** "Found via Greenhouse" */
  foundVia: string;
  /** The canonical posting, employer/ATS first; null when none is recorded. */
  href: string | null;
  /** "View original" */
  linkLabel: string;
  /** Set when the posting is known to be gone: "Posting removed" or "Posting removed Sep 6". */
  removed: string | null;
}

const GONE = new Set(["CLOSED_OR_REMOVED", "CONFIRMED_CLOSED", "ARCHIVED"]);

export function postingLink(j: PostingLinkInput): PostingLink {
  const gone = GONE.has(String(j.status ?? ""));
  let removed: string | null = null;
  if (gone) {
    // status_changed_at is the moment the closure was recorded; there is no
    // separate removal date, so nothing more precise is claimed.
    const at = j.statusChangedAt ? new Date(j.statusChangedAt) : null;
    removed = at && !Number.isNaN(at.getTime())
      ? `Posting removed ${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
      : "Posting removed";
  }
  return {
    foundVia: `Found via ${sourceLabel(j.source)}`,
    href: j.url ?? j.applyUrl ?? null,
    linkLabel: "View original",
    removed,
  };
}
