import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadJobCardPage, loadUniverseCounts, type InterestTab } from "../../lib/portal/db.ts";
import { currentSession } from "../../lib/portal/session.ts";
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

const nf = new Intl.NumberFormat("en-US");
const PER_PAGE = 50;

/**
 * What the page is showing, and what it is not. Three head-only counts,
 * streamed in after the list: the cards are the page, and they must never
 * wait on a statistic. Grows toward "ranked" as extraction (#269) clears the
 * "being evaluated" backlog.
 */
async function UniverseLine({ db }: { db: SupabaseClient }) {
  const { count } = await db.from("job_card_summary").select("job_id", { count: "exact", head: true });
  const universe = await loadUniverseCounts(db, count ?? 0);
  return (
    <p className="universe">
      <b>{nf.format(universe.ranked)}</b> ranked for you
      {universe.awaiting > 0 && (
        <> <span className="sep">·</span> <b>{nf.format(universe.awaiting)}</b> still being evaluated</>
      )}
      {universe.excludedByGates > 0 && (
        <> <span className="sep">·</span> <span className="muted">{nf.format(universe.excludedByGates)} ruled out by your location/eligibility</span></>
      )}
    </p>
  );
}

export default async function Page(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;

  const q = (one("q") ?? "").trim();
  const interest = (TABS.find((t) => t.key === one("interest"))?.key ?? "active") as InterestTab;
  const requestedPage = Math.max(1, Number(one("p") ?? 1) || 1);

  const session = await currentSession();
  if (!session) redirect("/login");
  const db = session.client;

  // The list is one bounded query against the precomputed job_card_summary
  // (see lib/portal/db.ts): the actionable gate, the tab, the search and the
  // Match Score ordering are applied in the database, and only this page's
  // 50 cards come back. This replaced rebuilding every ranked card from ~53k
  // rows on each request. If the summary has not been built yet, say so
  // rather than fail.
  let result: Awaited<ReturnType<typeof loadJobCardPage>> | null = null;
  let notReady: string | null = null;
  try {
    result = await loadJobCardPage(db, { interest, q, page: requestedPage, perPage: PER_PAGE });
  } catch (e) {
    notReady = e instanceof Error ? e.message : String(e);
  }

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

  const total = result?.total ?? 0;
  const shown = result?.cards ?? [];
  const current = result?.page ?? 1;
  const pageCount = result?.pageCount ?? 1;
  const startIndex = result?.startIndex ?? 0;

  return (
    <main className="jobs">
      <header className="applyhead">
        <h1>Jobs</h1>
        <PrimaryNav current="jobs" />
      </header>

      <Suspense fallback={<p className="universe muted">counting the universe…</p>}>
        <UniverseLine db={db} />
      </Suspense>

      <div className="jobsbar">
        {/* Links, not anchors: a tab or page change is a soft navigation that
            keeps the shell and the current list on screen until the next
            one arrives, and prefetches on hover. */}
        <nav className="tabs" aria-label="List">
          {TABS.map((t) => (
            <Link key={t.key} href={withParams({ interest: t.key, p: undefined })}
               className={t.key === interest ? "tab active" : "tab"}>
              {t.label}
            </Link>
          ))}
        </nav>
        <form className="search" method="get">
          {interest !== "active" && <input type="hidden" name="interest" value={interest} />}
          <input name="q" defaultValue={q} placeholder="Search title or company" aria-label="Search title or company" />
          {q && <Link className="clear" href={withParams({ q: undefined, p: undefined })}>clear</Link>}
        </form>
      </div>

      {notReady ? (
        <div className="empty">
          <p>The ranked list is being prepared.</p>
          <p className="muted small">
            The card summary has not been built yet (run the pipeline&apos;s card-summaries step, or
            <code> scripts/materialize-job-cards.ts --commit</code>). {notReady}
          </p>
        </div>
      ) : (
        <>
          <p className="count">
            {total === 0
              ? "Nothing here yet"
              : `${nf.format(total)} ${interest === "active" ? "in your queue" : "job" + (total === 1 ? "" : "s")}`}
            {total > PER_PAGE
              && ` · showing ${nf.format(startIndex + 1)}–${nf.format(startIndex + shown.length)}`}
          </p>

          {shown.length === 0
            ? (
              <div className="empty">
                <p>{q ? "No jobs match that search." : interest === "saved" ? "You haven't saved any jobs yet."
                  : interest === "dismissed" ? "You haven't set any jobs aside." : "No ranked jobs yet."}</p>
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
              {current > 1 && <Link href={withParams({ p: current - 1 })}>← previous</Link>}
              <span>page {current} of {pageCount}</span>
              {current < pageCount && <Link href={withParams({ p: current + 1 })}>next →</Link>}
            </nav>
          )}
        </>
      )}
    </main>
  );
}
