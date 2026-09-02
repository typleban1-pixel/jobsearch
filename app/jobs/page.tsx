import { redirect } from "next/navigation";
import { loadJobCards } from "../../lib/portal/db.ts";
import { currentSession } from "../../lib/portal/session.ts";
import {
  applyFilters, sortCards, SORTS, DEFAULT_FILTERS, type Filters, type SortKey,
} from "../../lib/portal/present.ts";
import { JobCardView } from "../JobCardView.tsx";
import { PrimaryNav } from "../PrimaryNav.tsx";

export const dynamic = "force-dynamic";

function readFilters(sp: Record<string, string | string[] | undefined>): Filters {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
  const num = (k: string) => { const v = one(k); return v === undefined || v === "" ? null : Number(v); };
  return {
    ...DEFAULT_FILTERS,
    q: one("q") ?? "",
    metro: one("metro") ?? "any",
    interest: one("interest") ?? "active",
    minEvidence: num("minEvidence") ?? 0,
    maxUncertainty: num("maxUncertainty"),
    salaryKnown: one("salaryKnown") === "on",
    stretchOnly: one("stretchOnly") === "on",
    candidacy: (["actionable", "skipped", "all"] as const)
      .find((v) => v === one("candidacy")) ?? "actionable",
  };
}

export default async function Page(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const filters = readFilters(sp);
  const sortKey = ((Array.isArray(sp.sort) ? sp.sort[0] : sp.sort) ?? "attention") as SortKey;
  const sortMeta = SORTS.find((s) => s.key === sortKey) ?? SORTS[0]!;

  // proxy.ts already turned away anyone without a session; this is the
  // second check, and the one that runs in the same place as the query.
  const session = await currentSession();
  if (!session) redirect("/login");

  const all = await loadJobCards(session.client);
  const matching = sortCards(applyFilters(all, filters), sortKey);

  // Paginated because rendering 488 cards produced a 3.7MB document and a
  // six-second response. The whole set is still filtered and sorted; only
  // the slice on screen is rendered.
  const PER_PAGE = 50;
  const pageNum = Math.max(1, Number((Array.isArray(sp.p) ? sp.p[0] : sp.p) ?? 1) || 1);
  const pageCount = Math.max(1, Math.ceil(matching.length / PER_PAGE));
  const current = Math.min(pageNum, pageCount);
  const shown = matching.slice((current - 1) * PER_PAGE, current * PER_PAGE);

  const linkTo = (n: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (k === "p" || v === undefined) continue;
      q.set(k, Array.isArray(v) ? v[0]! : v);
    }
    q.set("p", String(n));
    return `/jobs?${q.toString()}`;
  };

  return (
    <main className="jobs">
      <header className="applyhead">
        <h1>Jobs</h1>
        <PrimaryNav current="jobs" />
      </header>

      <form className="controls" method="get">
        <div>
          <label htmlFor="q">Title or company</label>
          <input id="q" name="q" defaultValue={filters.q} placeholder="e.g. operations" />
        </div>
        <div>
          <label htmlFor="sort">Sort</label>
          <select id="sort" name="sort" defaultValue={sortKey}>
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="metro">Location</label>
          <select id="metro" name="metro" defaultValue={filters.metro}>
            <option value="any">Anywhere eligible</option>
            <option value="chicagoland">Names Chicagoland</option>
            <option value="remote">Offers remote</option>
          </select>
        </div>
        <div>
          <label htmlFor="interest">List</label>
          <select id="interest" name="interest" defaultValue={filters.interest}>
            <option value="active">Undecided</option>
            <option value="saved">Saved</option>
            <option value="dismissed">Not interested</option>
            <option value="all">Everything</option>
          </select>
        </div>
        <div>
          {/*
            Separate from "List" above on purpose. That one records what
            Ty decided about a job; this one records what the model
            decided. Folding them together would lose which of the two
            put a job out of sight.
          */}
          <label htmlFor="candidacy">Candidacy</label>
          <select id="candidacy" name="candidacy" defaultValue={filters.candidacy}>
            <option value="actionable">Actionable</option>
            <option value="skipped">Skipped by system</option>
            <option value="all">Everything</option>
          </select>
        </div>
        <div>
          <label htmlFor="minEvidence">Min matched concepts</label>
          <input id="minEvidence" name="minEvidence" type="number" min={0} max={10} defaultValue={filters.minEvidence} />
        </div>
        <div>
          <label htmlFor="maxUncertainty">Max uncertainty</label>
          <input id="maxUncertainty" name="maxUncertainty" type="number" min={0} placeholder="any"
                 defaultValue={filters.maxUncertainty ?? ""} />
        </div>
        <div>
          <label>Only</label>
          <div className="checks">
            <label htmlFor="salaryKnown" style={{ textTransform: "none", letterSpacing: 0 }}>
              <input id="salaryKnown" name="salaryKnown" type="checkbox" defaultChecked={filters.salaryKnown} /> salary stated
            </label>
            <label htmlFor="stretchOnly" style={{ textTransform: "none", letterSpacing: 0 }}>
              <input id="stretchOnly" name="stretchOnly" type="checkbox" defaultChecked={filters.stretchOnly} /> stretch
            </label>
          </div>
        </div>
        <div><button type="submit" className="primary">Apply</button></div>
      </form>
      <p className="sortnote">Sorted by {sortMeta.label.toLowerCase()}.</p>
      <p className="count">
        {matching.length === all.length
          ? `${matching.length} job${matching.length === 1 ? "" : "s"} worth considering`
          : `${matching.length} of ${all.length} jobs match`}
        {matching.length > PER_PAGE
          && ` · showing ${(current - 1) * PER_PAGE + 1}–${(current - 1) * PER_PAGE + shown.length}`}
      </p>

      {shown.length === 0
        ? <div className="empty"><p>No jobs match these filters.</p><p className="muted">Try widening the location or clearing a filter.</p></div>
        : shown.map((c) => <JobCardView key={c.id} card={c} returnTo={linkTo(current)} />)}

      {pageCount > 1 && (
        <nav className="pager">
          {current > 1 && <a href={linkTo(current - 1)}>← previous</a>}
          <span>page {current} of {pageCount}</span>
          {current < pageCount && <a href={linkTo(current + 1)}>next →</a>}
        </nav>
      )}
    </main>
  );
}
