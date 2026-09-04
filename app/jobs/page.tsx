import { redirect } from "next/navigation";
import { loadJobCards, loadUniverseCounts } from "../../lib/portal/db.ts";
import { currentSession } from "../../lib/portal/session.ts";
import { applyFilters, sortCards, DEFAULT_FILTERS, type Filters } from "../../lib/portal/present.ts";
import { JobCardView } from "../JobCardView.tsx";
import { JobsQueue } from "./JobsQueue.tsx";
import { PrimaryNav } from "../PrimaryNav.tsx";

export const dynamic = "force-dynamic";

// The only two things a person operates here. Everything else -- the
// ranking, the hard gates, hiding what the model rejected -- is automatic
// and lives in the ordering, not in a control the reader has to set.
const TABS = [
  { key: "active", label: "Undecided" },
  { key: "saved", label: "Saved" },
  { key: "dismissed", label: "Not interested" },
  { key: "all", label: "All" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const nf = new Intl.NumberFormat("en-US");

export default async function Page(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;

  const q = (one("q") ?? "").trim();
  const interest = (TABS.find((t) => t.key === one("interest"))?.key ?? "active") as TabKey;

  // The authoritative view: every currently viable job, best opportunity
  // first, with the model's rejects and Ty's decided rows gated out. The
  // ranking dimensions (candidacy, fit, opportunity, salary, uncertainty,
  // gaps) still exist and still drive the order -- they are just not knobs
  // the reader turns. candidacy stays "actionable" so hard-gate rejects
  // never surface; interest is the one selector, shown as tabs.
  const filters: Filters = {
    ...DEFAULT_FILTERS, q, interest, candidacy: "actionable",
  };

  const session = await currentSession();
  if (!session) redirect("/login");

  const all = await loadJobCards(session.client);
  const universe = await loadUniverseCounts(session.client, all.length);
  // One authoritative ordering: the calibrated 0-100 Match Score, highest
  // first, so #1 is the best viable match currently evaluated. Eligibility
  // gating still happens upstream (an ineligible job is not made viable by
  // a high score); the evidence-first Formula 3 ranking now only breaks
  // ties beneath Match Score and remains available as a diagnostic sort.
  const matching = sortCards(applyFilters(all, filters), "match");

  // Paginated because rendering hundreds of cards produced a multi-megabyte
  // document. The whole set is still ranked; only the slice on screen is
  // rendered, and the rank number is the position in the full ranking so
  // #1 means the single best job, whatever page it lands on.
  const PER_PAGE = 50;
  const pageNum = Math.max(1, Number(one("p") ?? 1) || 1);
  const pageCount = Math.max(1, Math.ceil(matching.length / PER_PAGE));
  const current = Math.min(pageNum, pageCount);
  const startIndex = (current - 1) * PER_PAGE;
  const shown = matching.slice(startIndex, startIndex + PER_PAGE);

  const withParams = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (interest !== "active") p.set("interest", interest);
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined || v === "" || (k === "interest" && v === "active")) p.delete(k);
      else p.set(k, String(v));
    }
    const s = p.toString();
    return s ? `/jobs?${s}` : "/jobs";
  };

  return (
    <main className="jobs">
      <header className="applyhead">
        <h1>Jobs</h1>
        <PrimaryNav current="jobs" />
      </header>

      {/* What the page is showing, and what it is not. Grows toward
          "ranked" as extraction (#269) clears the "being evaluated" backlog. */}
      <p className="universe">
        <b>{nf.format(universe.ranked)}</b> ranked for you
        {universe.awaiting > 0 && (
          <> <span className="sep">·</span> <b>{nf.format(universe.awaiting)}</b> still being evaluated</>
        )}
        {universe.excludedByGates > 0 && (
          <> <span className="sep">·</span> <span className="muted">{nf.format(universe.excludedByGates)} ruled out by your location/eligibility</span></>
        )}
      </p>

      <div className="jobsbar">
        <nav className="tabs" aria-label="List">
          {TABS.map((t) => (
            <a key={t.key} href={withParams({ interest: t.key, p: undefined })}
               className={t.key === interest ? "tab active" : "tab"}>
              {t.label}
            </a>
          ))}
        </nav>
        <form className="search" method="get">
          {interest !== "active" && <input type="hidden" name="interest" value={interest} />}
          <input name="q" defaultValue={q} placeholder="Search title or company" aria-label="Search title or company" />
          {q && <a className="clear" href={withParams({ q: undefined, p: undefined })}>clear</a>}
        </form>
      </div>

      <p className="count">
        {matching.length === 0
          ? "Nothing here yet"
          : `${nf.format(matching.length)} ${interest === "active" ? "in your queue" : "job" + (matching.length === 1 ? "" : "s")}`}
        {matching.length > PER_PAGE
          && ` · showing ${nf.format(startIndex + 1)}–${nf.format(startIndex + shown.length)}`}
      </p>

      {shown.length === 0
        ? (
          <div className="empty">
            <p>{q ? "No jobs match that search." : interest === "saved" ? "You haven't saved any jobs yet."
              : interest === "dismissed" ? "You haven't set any jobs aside." : "No ranked jobs yet."}</p>
            {universe.awaiting > 0 && interest === "active" && !q && (
              <p className="muted">{nf.format(universe.awaiting)} more jobs are still being evaluated and will appear here as they're scored.</p>
            )}
          </div>
        )
        : (
          <JobsQueue>
            {shown.map((c, i) => (
              <JobCardView key={c.id} card={c}
                rank={interest === "active" ? startIndex + i + 1 : null}
                returnTo={withParams({ p: current })} />
            ))}
          </JobsQueue>
        )}

      {pageCount > 1 && (
        <nav className="pager">
          {current > 1 && <a href={withParams({ p: current - 1 })}>← previous</a>}
          <span>page {current} of {pageCount}</span>
          {current < pageCount && <a href={withParams({ p: current + 1 })}>next →</a>}
        </nav>
      )}
    </main>
  );
}
