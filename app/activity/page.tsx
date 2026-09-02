import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "../../lib/portal/session.ts";
import { loadPipelineRuns } from "../../lib/portal/operations.ts";

export const dynamic = "force-dynamic";

const STEP_NAME: Record<string, string> = {
  discover: "swept discovery sources for new companies",
  "resolve-ats": "checked discovered companies for a board they own",
  "company-geo": "derived Chicagoland and remote-US presence from job locations",
  ingest: "pulled open jobs from every validated board",
  locations: "normalized job locations",
  eligibility: "applied the eligibility rules",
  "eligibility-refresh": "rechecked jobs whose eligibility could have moved",
  score: "scored jobs against the truth profile",
  churn: "closed jobs the boards no longer list",
};

/** What actually happened, in sentences rather than column names. */
export default async function Activity() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const runs = await loadPipelineRuns(session.client);

  return (
    <main className="wrap">
      <p className="back"><Link href="/jobs">← all jobs</Link> · <Link href="/ats">ATS status</Link></p>
      <h1>Automation activity</h1>
      <p className="muted">
        {runs.length === 0
          ? "No scheduled run has been recorded yet."
          : `The last ${runs.length} scheduled run${runs.length === 1 ? "" : "s"}. These run unattended; nothing here needed a session open.`}
      </p>

      {runs.map((r: any) => {
        const steps: Array<{ step: string; ok: boolean; ms: number; tail?: string }> =
          Array.isArray(r.steps) ? r.steps : [];
        const failed = steps.filter((s) => !s.ok);
        const started = String(r.started_at).slice(0, 16).replace("T", " ");
        const mins = r.finished_at
          ? Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 60000)
          : null;
        return (
          <section key={r.id} className="queue-item">
            <p className="muted small">
              <strong>{r.kind}</strong> run · started {started}
              {mins !== null ? ` · took ${mins} minute${mins === 1 ? "" : "s"}` : " · still running"}
              {" · "}
              <span className={`chip ${r.succeeded === false ? "warn" : "direct"}`}>
                {r.succeeded === false ? "some steps failed" : r.succeeded ? "all steps ok" : "in progress"}
              </span>
            </p>

            <ul className="small">
              {r.companies_checked != null && (
                <li>checked {r.companies_checked} discovered {r.companies_checked === 1 ? "company" : "companies"} for a board
                  {r.companies_resolved != null && <>, and validated {r.companies_resolved} new {r.companies_resolved === 1 ? "board" : "boards"}</>}</li>
              )}
              {r.jobs_added != null && <li>ingested {r.jobs_added} new {r.jobs_added === 1 ? "job" : "jobs"}</li>}
              {r.jobs_closed != null && r.jobs_closed > 0 && <li>closed {r.jobs_closed} {r.jobs_closed === 1 ? "job" : "jobs"} the boards stopped listing</li>}
              {r.eligible_before != null && r.eligible_after != null && (
                <li>eligible jobs {r.eligible_before} → {r.eligible_after}</li>
              )}
            </ul>

            {failed.length > 0 && (
              <div>
                <p className="chip warn">{failed.length} step{failed.length === 1 ? "" : "s"} failed</p>
                <ul className="small">
                  {failed.map((s, i) => (
                    <li key={i}><strong>{STEP_NAME[s.step] ?? s.step}</strong>: {s.tail ?? "no detail recorded"}</li>
                  ))}
                </ul>
              </div>
            )}

            {steps.length > 0 && (
              <details>
                <summary className="small">every step ({steps.length})</summary>
                <ul className="small">
                  {steps.map((s, i) => (
                    <li key={i}>
                      {s.ok ? "ok" : "FAILED"} · {STEP_NAME[s.step] ?? s.step} · {(s.ms / 1000).toFixed(1)}s
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        );
      })}
    </main>
  );
}
