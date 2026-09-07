import type { ReviewData, ReviewCheck } from "../../lib/portal/reviewData.ts";

/**
 * The review, expanded inline on the Apply board.
 *
 * This is the SAME review the /applications/[id]/review permalink shows,
 * rendered beside the card so an application can be read and approved
 * without a page change. It reuses loadReview() and posts to the exact
 * same approve/submit endpoints, so every submission gate is unchanged --
 * nothing here can approve or send what the full review could not.
 */
function Check({ c }: { c: ReviewCheck }) {
  const mark = c.state === "PASS" ? "✓" : c.state === "PENDING" ? "○" : "✕";
  return (
    <li className={`check ${c.state.toLowerCase()}`}>
      <span className="mark" aria-hidden="true">{mark}</span>
      <span>{c.label}</span>
    </li>
  );
}

export function InlineReview({ r }: { r: ReviewData }) {
  const permalink = `/applications/${r.applicationId}/review`;
  return (
    <details className="approw-review">
      <summary className="btn-primary">Review &amp; approve &rarr;</summary>
      <div className="approw-review-body">
        {r.warnings.length > 0 ? (
          <div className="banner warn">
            <strong>Needs another look before it can be approved</strong>
            <ul>{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        ) : (
          <div className="banner plain">
            <strong>Prepared and checked</strong>
            <span>Read the answers below, then approve. Nothing has been submitted.</span>
          </div>
        )}

        <div className="checklists compact">
          <div><h4>Resume</h4><ul className="checks">{r.resumeChecks.map((c) => <Check key={c.label} c={c} />)}</ul></div>
          <div><h4>Application</h4><ul className="checks">{r.applicationChecks.map((c) => <Check key={c.label} c={c} />)}</ul></div>
          <div><h4>Final submission</h4><ul className="checks">{r.finalChecks.map((c) => <Check key={c.label} c={c} />)}</ul></div>
        </div>

        <div className="pane">
          <h4>Application answers <span className="muted">— what the employer receives</span></h4>
          {r.answers.some((a) => a.state === "BLOCKED") && (
            <p className="needsinput-lead">
              <b>{r.answers.filter((a) => a.state === "BLOCKED").length} need your input.</b>{" "}
              <a href={`/apply/questions#app-${r.applicationId}`}>Answer them</a>
            </p>
          )}
          <ul className="answers">
            {r.answers.map((a) => (
              <li key={a.fieldKey} className={a.state === "BLOCKED" ? "blocked" : undefined}>
                <p className="q">{a.question}</p>
                <p className="a">{a.state === "BLOCKED" ? <em>needs your answer</em> : a.answer ?? <em>left blank</em>}</p>
                {a.source && a.state !== "BLOCKED" && <p className="src">{a.source}</p>}
              </li>
            ))}
          </ul>
        </div>

        <div className="pane">
          <h4>Tailored resume</h4>
          {r.resume.hasArtifact
            ? <a className="btn-quiet" href={`/applications/${r.applicationId}/resume.pdf`} target="_blank" rel="noreferrer">Open the prepared PDF ({r.resume.linesAccepted} lines)</a>
            : <p className="bad">No saved PDF is bound to this application.</p>}
        </div>

        <div className="approw-review-actions">
          {r.canApprove ? (
            <form method="post" action="/api/applications/approve">
              <input type="hidden" name="applicationId" value={r.applicationId} />
              <button className="btn-primary" type="submit">Approve &amp; continue &rarr;</button>
            </form>
          ) : (
            <p className="muted">This cannot be approved until the points above are resolved.</p>
          )}
          <a className="btn-quiet" href={permalink}>Open full review</a>
        </div>
        <p className="muted small">Approval means this resume and these answers may proceed to submission. It does not submit anything.</p>
      </div>
    </details>
  );
}
