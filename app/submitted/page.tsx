import { redirect } from "next/navigation";
import { currentSession } from "../../lib/portal/session.ts";
import { loadMatchScores } from "../../lib/portal/db.ts";
import { matchLabel } from "../../lib/portal/matchScore.ts";
import { PrimaryNav } from "../PrimaryNav.tsx";

export const dynamic = "force-dynamic";

/**
 * Applications that were actually sent.
 *
 * Deliberately minimal for now: the permanent archive, with the frozen
 * listing, the exact resume, the answers as given and the confirmation
 * screenshots, is its own slice. This exists so the navigation is real
 * and so a submitted application is not invisible in the meantime.
 */
export default async function SubmittedPage() {
  const session = await currentSession();
  if (!session) redirect("/login");

  const { data: apps } = await session.client
    .from("applications")
    .select("id,job_id,submitted_at,confirmation_reference,confirmation_email_received")
    .not("submitted_at", "is", null)
    .order("submitted_at", { ascending: false });

  const rows = apps ?? [];
  const { data: jobs } = rows.length
    ? await session.client.from("jobs").select("id,title,company_id,source").in("id", rows.map((a) => a.job_id))
    : { data: [] as any[] };
  const { data: companies } = (jobs ?? []).length
    ? await session.client.from("companies").select("id,name").in("id", (jobs ?? []).map((j: any) => j.company_id))
    : { data: [] as any[] };

  const jobById = new Map((jobs ?? []).map((j: any) => [j.id, j]));
  const nameById = new Map((companies ?? []).map((c: any) => [c.id, c.name]));
  const confirmedCount = rows.filter((a) => a.confirmation_email_received || a.confirmation_reference).length;
  // The match score comes from the precomputed card summary. Applications
  // logged from an external posting were never scored and simply carry no
  // badge, which is honest: the score is a fit estimate, not a fact of the
  // submission.
  const matchScores = jobs && (jobs as any[]).length
    ? await loadMatchScores(session.client, (jobs as any[]).map((j: any) => j.id))
    : new Map();

  return (
    <main className="apply">
      <header className="applyhead">
        <h1>Submitted</h1>
        <PrimaryNav current="submitted" />
      </header>

      {rows.length > 0 && (
        <p className="statusline" aria-label="Summary">
          <b>{rows.length}</b> submitted
          <span className="sep" aria-hidden="true"> &middot; </span>
          <b>{confirmedCount}</b> confirmed by the employer
        </p>
      )}

      {rows.length === 0 ? (
        <section className="caughtup">
          <h2>Nothing submitted yet.</h2>
          <p>Applications you send will be kept here permanently.</p>
        </section>
      ) : (
        <ul className="approws">
          {rows.map((a) => {
            const job = jobById.get(a.job_id);
            const confirmed = Boolean(a.confirmation_email_received || a.confirmation_reference);
            const when = new Date(a.submitted_at!).toLocaleString("en-US", {
              month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
            });
            const match = job ? matchScores.get(job.id) : null;
            return (
              <li className="approw" key={a.id}>
                <div className="approw-main">
                  <p className="approw-title">
                    {job?.title ?? "Unknown role"}
                    {match && (
                      <span className={`approw-match${match.provisional ? " provisional" : ""}`}
                        title={`${matchLabel(match.score, match.provisional)}${match.note ? ` — ${match.note}` : ""}`}>
                        {match.provisional ? "~" : ""}{match.score}<span className="of">/100</span>
                      </span>
                    )}
                  </p>
                  <p className="approw-company">{nameById.get(job?.company_id) ?? "Unknown"}</p>
                  <p className="approw-summary">
                    Submitted {when}
                    {confirmed ? " \u00b7 Employer confirmation received" : " \u00b7 Awaiting confirmation"}
                  </p>
                </div>
                <a className="btn-quiet" href={`/applications/${a.id}/review`}>View application</a>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
