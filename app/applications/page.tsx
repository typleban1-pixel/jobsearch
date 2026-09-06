import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "../../lib/portal/session.ts";
import { loadBlockerBoard, type BoardRow } from "../../lib/portal/blockerBoard.ts";

export const dynamic = "force-dynamic";

/**
 * The applications page answers one question at a glance: what, if
 * anything, does the pipeline need from you? Every application shows its
 * one real blocker -- derived from actual gate state, never guessed at
 * this layer -- and the page leads with the compact counts, actionable
 * piles first.
 */
const CLOSED = new Set(["REJECTED", "WITHDRAWN", "ABANDONED"]);

const PILES: Array<{ label: string; match: (r: BoardRow) => boolean }> = [
  { label: "Needs your answer", match: (r) => r.blocker.code === "WAITING_FOR_MY_ANSWER" },
  { label: "Needs your review", match: (r) => r.blocker.code === "WAITING_FOR_MY_REVIEW" },
  { label: "Stretch — apply manually if you want", match: (r) => ["MANUAL_OPTIONAL_QUALIFICATION_GAP", "NOT_A_MATCH"].includes(r.blocker.code) },
  { label: "Needs your eyes", match: (r) => ["AMBIGUOUS_SUBMIT_STATE", "SUBMISSION_FAILED", "REVALIDATION_FAILED"].includes(r.blocker.code) },
  { label: "Finish on the employer's site", match: (r) => ["ATS_NOT_AUTOMATED", "AUTHENTICATION_REQUIRED"].includes(r.blocker.code) },
  { label: "Ready — the listener owns these", match: (r) => ["READY_TO_SUBMIT", "ENQUEUED", "SUBMISSION_IN_PROGRESS", "DAILY_CAP_REACHED"].includes(r.blocker.code) },
  { label: "Processing", match: (r) => ["PROCESSING", "FORM_NOT_READ", "JOB_CLOSED_OR_CHANGED"].includes(r.blocker.code) },
  { label: "Submitted", match: (r) => r.blocker.code === "SUBMITTED" },
];

export default async function Applications() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { rows, summary } = await loadBlockerBoard(session.client);
  const open = rows.filter((r) => !CLOSED.has(r.app.status));
  const closed = rows.filter((r) => CLOSED.has(r.app.status));
  const seen = new Set<string>();

  return (
    <main className="wrap">
      <p className="back"><Link href="/jobs">← all jobs</Link></p>
      <h1>Applications</h1>

      <p className="muted">
        {summary.needAnswer > 0 && <><strong>{summary.needAnswer} need your answer</strong> · </>}
        {summary.needReview > 0 && <><strong>{summary.needReview} need your review</strong> · </>}
        {summary.stretchManual > 0 && <><strong>{summary.stretchManual} stretch (manual only)</strong> · </>}
        {summary.issue > 0 && <><strong>{summary.issue} with a submission issue</strong> · </>}
        {summary.ready} ready · {summary.processing} processing · {summary.submittedToday} submitted today ·{" "}
        {summary.submittedTotal} submitted all-time
      </p>

      {PILES.map(({ label, match }) => {
        const pile = open
          .filter((r) => !seen.has(r.app.id) && match(r));
        for (const r of pile) seen.add(r.app.id);
        if (!pile.length) return null;
        return (
          <section key={label}>
            <h2>{label}</h2>
            <table className="apps">
              <tbody>
                {pile.map(({ app, blocker }) => (
                  <tr key={app.id}>
                    <td>
                      <Link href={`/applications/${app.id}`}>{app.company} — {app.title}</Link>
                      {app.postingChanged && <span className="chip warn"> posting changed since freeze</span>}
                    </td>
                    <td>
                      <strong>{blocker.status}.</strong>{" "}
                      <span className="muted">{blocker.reason}</span>
                    </td>
                    <td>
                      {blocker.action
                        ? <a className="btn-primary" href={blocker.action.href}>{blocker.action.label}</a>
                        : <span className="muted">no action needed</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}

      {closed.length > 0 && (
        <section>
          <h2>Closed</h2>
          <table className="apps"><tbody>
            {closed.map(({ app }) => (
              <tr key={app.id}>
                <td><Link href={`/applications/${app.id}`}>{app.company} — {app.title}</Link></td>
                <td className="muted">{app.status.toLowerCase()}</td>
                <td />
              </tr>
            ))}
          </tbody></table>
        </section>
      )}

      {rows.length === 0 && (
        <p className="muted">Nothing yet. Open a job and choose to apply.</p>
      )}
    </main>
  );
}
