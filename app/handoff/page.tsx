import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "../../lib/portal/session.ts";
import { loadHandoffs } from "../../lib/portal/operations.ts";

export const dynamic = "force-dynamic";

/**
 * Everything the machine stopped on, and what each one wants.
 *
 * Source of truth is application_fill_runs, the most recent run per
 * application. An application that has since been submitted is not an
 * open item and is not listed.
 *
 * A stop is not a failure report. Every row here is the system declining
 * to guess, so the useful question is never "what went wrong" but "what
 * does it need from me", which is the column that comes first.
 */
export default async function HandoffInbox() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const rows = await loadHandoffs(session.client);

  const resolvable = rows.filter((r) => r.resolvableInPortal);
  const waiting = rows.filter((r) => !r.resolvableInPortal);

  return (
    <main className="wrap">
      <p className="back"><Link href="/jobs">← all jobs</Link> · <Link href="/applications">applications</Link></p>
      <h1>Handoff inbox</h1>
      <p className="muted">
        {rows.length === 0
          ? "Nothing is waiting on you. Every application either finished or has not been attempted."
          : `${rows.length} application${rows.length === 1 ? "" : "s"} stopped and ${rows.length === 1 ? "is" : "are"} waiting on you. Nothing here was guessed, and nothing was submitted.`}
      </p>

      {resolvable.length > 0 && (
        <section>
          <h2>You can resolve these here</h2>
          <p className="muted small">
            A question could not be answered safely. Answer it, then resume the same
            application; it picks up from where it stopped rather than being rebuilt.
          </p>
          {resolvable.map((r) => <Card key={r.runId} row={r} />)}
        </section>
      )}

      {waiting.length > 0 && (
        <section>
          <h2>These need you at the browser</h2>
          {waiting.map((r) => <Card key={r.runId} row={r} />)}
        </section>
      )}
    </main>
  );
}

function Card({ row }: { row: Awaited<ReturnType<typeof loadHandoffs>>[number] }) {
  const when = row.startedAt.slice(0, 16).replace("T", " ");
  return (
    <section className="queue-item">
      <p className="muted small">
        <Link href={`/applications/${row.applicationId}`}>{row.company} — {row.title}</Link>
        {" · "}<span className="chip">{row.provider}</span>
        {" · "}<span className={`chip ${row.outcome === "HANDOFF" ? "" : "warn"}`}>{row.outcome}</span>
        {" · "}{row.applicationStatus}
        {" · stopped "}{when}
      </p>

      <p className="asked"><strong>{row.action}</strong></p>
      {row.stopDetail && <p className="muted small">What happened: {row.stopDetail}</p>}

      <p className="small">
        <Link href={`/applications/${row.applicationId}`}>Open application</Link>
        {row.resolvableInPortal && <> · <Link href="/applications/queue">Resolve {row.blockedAnswers} question{row.blockedAnswers === 1 ? "" : "s"}</Link></>}
      </p>

      <form method="post" action="/api/applications/resume">
        <input type="hidden" name="applicationId" value={row.applicationId} />
        <input type="hidden" name="returnTo" value="/handoff" />
        <button type="submit" disabled={row.blockedAnswers > 0}>
          {row.blockedAnswers > 0 ? "Resume (answer the questions first)" : "Resume this application"}
        </button>
        <span className="muted small">
          {" "}Re-queues this application from its current state. It does not resubmit anything.
        </span>
      </form>
    </section>
  );
}
