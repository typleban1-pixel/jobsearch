import { redirect } from "next/navigation";
import { currentSession } from "../../lib/portal/session.ts";
import { loadApplyBoard, type ApplyRow } from "../../lib/portal/applyBoard.ts";
import { PrimaryNav } from "../PrimaryNav.tsx";

export const dynamic = "force-dynamic";

/**
 * What needs you right now.
 *
 * The order of this page is the order of the work: what is blocked on a
 * person, then what is ready for them, then what is running without
 * them. Counts that describe the corpus rather than the work (open
 * jobs, eligible jobs, validated boards) moved to Settings; they are
 * true and occasionally interesting and they are not what this page is
 * for.
 */
function Row({ row }: { row: ApplyRow }) {
  const p = row.presentation;
  return (
    <li className="approw">
      <div className="approw-main">
        <p className="approw-title">
          {row.title}
          {row.match && (
            <span className={`matchbadge${row.match.provisional ? " provisional" : ""}`}
              title={row.match.note ? `Match estimate — ${row.match.note}` : "How good this opportunity is for your verified background"}>
              <b>{row.match.provisional ? "~" : ""}{row.match.score}</b> Match
            </span>
          )}
        </p>
        <p className="approw-company">{row.company}</p>
        <p className="approw-summary">{p.summary}</p>
      </div>
      {p.action && (
        <a className="btn-primary" href={p.action.href}>{p.action.label}</a>
      )}
    </li>
  );
}

function Section({ title, rows, tone }: { title: string; rows: ApplyRow[]; tone?: "urgent" }) {
  if (rows.length === 0) return null;
  return (
    <section className={`applysection${tone === "urgent" ? " urgent" : ""}`}>
      <h2>{title}<span className="count">{rows.length}</span></h2>
      <ul className="approws">{rows.map((r) => <Row key={r.applicationId} row={r} />)}</ul>
    </section>
  );
}

export default async function ApplyPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const board = await loadApplyBoard(session.client);

  const needCount = board.needsYou.length;
  const readyCount = board.ready.length;
  const today = new Date().toISOString().slice(0, 10);
  const submittedToday = board.recentlySubmitted.filter((r) => (r.submittedAt ?? "").slice(0, 10) === today).length;

  return (
    <main className="apply">
      <header className="applyhead">
        <h1>Apply</h1>
        <PrimaryNav current="apply" />
      </header>

      <div className="summarybar">
        <a className="summary needs" href="#needsyou">
          <strong>{needCount}</strong><span>need you</span>
        </a>
        <a className="summary" href="#ready">
          <strong>{readyCount}</strong><span>ready</span>
        </a>
        <a className="summary" href="/submitted">
          <strong>{submittedToday}</strong><span>submitted today</span>
        </a>
      </div>

      {board.blocked.answersNeeded > 0 && (
        <a className="answerscallout" href="/apply/questions">
          <strong>{board.blocked.answersNeeded} answer{board.blocked.answersNeeded === 1 ? "" : "s"} needed</strong>
          <span>
            {/* The distinction that matters: the work is the questions,
                not the fields they resolve. */}
            {board.blocked.answersNeeded === board.blocked.blockedFields
              ? `${board.blocked.blockedFields} field${board.blocked.blockedFields === 1 ? "" : "s"} across ${board.blocked.applications} application${board.blocked.applications === 1 ? "" : "s"}`
              : `These answers apply to ${board.blocked.blockedFields} fields across ${board.blocked.applications} applications.`}
          </span>
        </a>
      )}

      {needCount === 0 && readyCount === 0 ? (
        <section className="caughtup">
          <h2>You&rsquo;re caught up.</h2>
          <p>No applications need your attention right now.</p>
          <p className="muted">The system is continuing to search and prepare opportunities.</p>
        </section>
      ) : null}

      <div id="needsyou" />
      <Section title="Needs you" rows={board.needsYou} tone="urgent" />
      <div id="ready" />
      <Section title="Ready" rows={board.ready} />
      <Section title="Preparing" rows={board.preparing} />
      <Section title="Recently submitted" rows={board.recentlySubmitted} />

      {board.closed.length > 0 && (
        <details className="closed">
          <summary>Closed ({board.closed.length})</summary>
          <ul className="approws">{board.closed.map((r) => <Row key={r.applicationId} row={r} />)}</ul>
        </details>
      )}
    </main>
  );
}
