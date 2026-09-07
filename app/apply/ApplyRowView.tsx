import Link from "next/link";
import type { ApplyRow } from "../../lib/portal/applyBoard.ts";
import type { ReviewData } from "../../lib/portal/reviewData.ts";
import { matchLabel } from "../../lib/portal/matchScore.ts";
import { StateBadge } from "../StateBadge.tsx";
import { InlineReview } from "./InlineReview.tsx";
import { ReprepareButton } from "./ReprepareButton.tsx";

/** One application row, drawn the same way on Applications and Batched. */
export function Progress({ row }: { row: ApplyRow }) {
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

export function Row({ row, review }: { row: ApplyRow; review?: ReviewData | null }) {
  const p = row.presentation;
  const inline = p.inlineReview && review;
  // The question link lands on this application's own block.
  const href = p.action?.href === "/apply/questions" ? `/apply/questions#app-${row.applicationId}` : p.action?.href;
  return (
    <li className={`approw state-${p.state.toLowerCase()}`} id={`application-${row.applicationId}`}>
      <div className="approw-main">
        <p className="approw-company">{row.company}</p>
        <p className="approw-title">
          {row.title}
          {row.match && (
            <span className={`approw-match${row.match.provisional ? " provisional" : ""}`}
              title={`${matchLabel(row.match.score, row.match.provisional)}${row.match.note ? ` — ${row.match.note}` : ""}`}>
              {row.match.provisional ? "~" : ""}{row.match.score}<span className="of">/100</span>
            </span>
          )}
        </p>
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

