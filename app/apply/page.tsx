import { redirect } from "next/navigation";
import { withSession } from "../../lib/portal/session.ts";
import { loadApplyBoard, type ApplyRow } from "../../lib/portal/applyBoard.ts";
import { loadReview, type ReviewData } from "../../lib/portal/reviewData.ts";
import { STATE_LABEL } from "../../lib/portal/presentationState.ts";
import { PrimaryNav } from "../PrimaryNav.tsx";
import { StateBadge } from "../StateBadge.tsx";
import { InlineReview } from "./InlineReview.tsx";
import { AutoRefreshApply } from "./AutoRefreshApply.tsx";
import { ReprepareButton } from "./ReprepareButton.tsx";
import { ReprepareBanner } from "./ReprepareBanner.tsx";

import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * What is happening with the jobs you chose, and what, if anything, needs
 * you.
 *
 * An inbox, not a second jobs list. The order of the page is the order of
 * the work: what is waiting on a person first and loudest, then what is
 * being prepared, then what is approved and running without them, and
 * finally, quietly, what has been sent. Success is summarised; the one
 * thing that needs a hand is the thing that stands out.
 */
function Progress({ row }: { row: ApplyRow }) {
  const p = row.progress;
  if (row.presentation.state === "PREPARING" && p.total === 0) return null;
  return (
    <ul className="approw-progress" aria-label="Preparation progress">
      <li className={p.resumeReady ? "ok" : "pending"}>
        <span className="mark" aria-hidden="true">{p.resumeReady ? "✓" : "○"}</span>
        {p.resumeReady ? "Resume ready" : "Resume not yet prepared"}
      </li>
      {p.total > 0 && (
        <li className="ok">
          <span className="mark" aria-hidden="true">✓</span>
          {p.answered}/{p.total} question{p.total === 1 ? "" : "s"} answered
        </li>
      )}
      {p.blocked > 0 && (
        <li className="warn">
          <span className="mark" aria-hidden="true">⚠</span>
          {p.blocked} answer{p.blocked === 1 ? "" : "s"} need{p.blocked === 1 ? "s" : ""} your input
        </li>
      )}
    </ul>
  );
}

function Row({ row, review }: { row: ApplyRow; review?: ReviewData | null }) {
  const p = row.presentation;
  const inline = p.inlineReview && review;
  // The question link lands on this application's own block.
  const href = p.action?.href === "/apply/questions" ? `/apply/questions#app-${row.applicationId}` : p.action?.href;
  return (
    <li className={`approw state-${p.state.toLowerCase()}`} id={`application-${row.applicationId}`}>
      <div className="approw-main">
        <p className="approw-company">{row.company}</p>
        <p className="approw-title">{row.title}</p>
        <p className="approw-state">
          <StateBadge state={p.state} />
          <span className="approw-summary">{p.summary}</span>
        </p>
        <Progress row={row} />
      </div>
      <div className="approw-action">
        {inline
          ? <InlineReview r={review!} />
          : p.reprepare
          ? <ReprepareButton applicationId={row.applicationId} title={row.title}
              label={p.action?.label ?? "Continue"} secondary={p.secondaryAction} />
          : p.action && href && (
            <Link className={p.state === "NEEDS_YOU" ? "btn-primary" : "btn-quiet"} href={href}
              {...(href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
              {p.action.label} <span aria-hidden="true">&rarr;</span>
            </Link>
          )}
      </div>
    </li>
  );
}

function Section({ id, title, rows, tone, reviews, lead }: {
  id: string; title: string; rows: ApplyRow[]; tone?: "urgent" | "quiet"; reviews?: Map<string, ReviewData | null>; lead?: string;
}) {
  if (rows.length === 0) return null;
  return (
    <section className={`applysection${tone ? ` ${tone}` : ""}`} id={id} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}<span className="count">{rows.length}</span></h2>
      {lead && <p className="applysection-lead">{lead}</p>}
      <ul className="approws">{rows.map((r) =>
        <Row key={r.applicationId} row={r} review={reviews?.get(r.applicationId)} />)}</ul>
    </section>
  );
}

export default async function ApplyPage() {
  const loaded = await withSession((db) => loadApplyBoard(db));
  if (!loaded) redirect("/login");
  const { session, result: board } = loaded;

  // The review for each row that can be approved inline. The board is
  // exception-driven and short when healthy; a load that fails leaves the
  // row on its permalink rather than breaking the page.
  const reviewable = board.needsYou.filter((r) => r.presentation.inlineReview);
  const reviews = new Map<string, ReviewData | null>(
    await Promise.all(reviewable.map(async (r) =>
      [r.applicationId, await loadReview(session.client, r.applicationId).catch(() => null)] as const)),
  );

  const counts = [
    { n: board.needsYou.length, label: "need you", href: "#needsyou", tone: "needs" },
    { n: board.preparing.length, label: "preparing", href: "#preparing", tone: "" },
    { n: board.ready.length, label: "ready", href: "#ready", tone: "" },
    { n: board.submittedCount, label: "submitted", href: "/submitted", tone: "" },
  ];
  const nothingOpen = board.needsYou.length === 0 && board.preparing.length === 0 && board.ready.length === 0;

  return (
    <main className="apply">
      <AutoRefreshApply active={board.preparing.length > 0 || board.ready.length > 0} />
      <ReprepareBanner />
      <header className="applyhead">
        <h1>Applications</h1>
        <PrimaryNav current="apply" attention={board.needsYou.length} />
      </header>

      <p className="statusline" aria-label="Summary">
        {counts.map((c, i) => (
          <span key={c.label}>
            {i > 0 && <span className="sep" aria-hidden="true"> · </span>}
            <Link href={c.href} className={c.tone}><b>{c.n}</b> {c.label}</Link>
          </span>
        ))}
      </p>

      {nothingOpen && (
        <section className="caughtup">
          <h2>You&rsquo;re caught up.</h2>
          <p>Nothing needs your attention right now.</p>
          <p className="muted">Choose more jobs on <Link href="/jobs">Jobs</Link> and they will show up here as they are prepared.</p>
        </section>
      )}

      <Section id="needsyou" title={STATE_LABEL.NEEDS_YOU} rows={board.needsYou} tone="urgent" reviews={reviews}
        lead={board.blocked.answersNeeded > 0
          ? `${board.blocked.answersNeeded} answer${board.blocked.answersNeeded === 1 ? "" : "s"} across ${board.blocked.applications} application${board.blocked.applications === 1 ? "" : "s"} can be given in one place.`
          : undefined} />
      {board.blocked.answersNeeded > 0 && (
        <p className="applysection-cta"><Link className="btn-primary" href="/apply/questions">Answer all open questions &rarr;</Link></p>
      )}
      <Section id="preparing" title={STATE_LABEL.PREPARING} rows={board.preparing} />
      <Section id="ready" title={STATE_LABEL.READY} rows={board.ready} lead="Approved and handed to the submitter. Nothing for you to do." />
      <Section id="submitted" title={STATE_LABEL.SUBMITTED} rows={board.recentlySubmitted} tone="quiet"
        lead={board.submittedCount > board.recentlySubmitted.length ? `The ${board.recentlySubmitted.length} most recent of ${board.submittedCount}.` : undefined} />
      {board.submittedCount > board.recentlySubmitted.length && (
        <p className="applysection-cta"><Link className="btn-quiet" href="/submitted">All submitted applications</Link></p>
      )}

      {board.closed.length > 0 && (
        <details className="closed">
          <summary>Closed ({board.closed.length})</summary>
          <ul className="approws">{board.closed.map((r) => <Row key={r.applicationId} row={r} />)}</ul>
        </details>
      )}
    </main>
  );
}
