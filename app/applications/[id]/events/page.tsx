import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentSession } from "../../../../lib/portal/session.ts";
import { loadApplication, loadEvents } from "../../../../lib/portal/applications.ts";

export const dynamic = "force-dynamic";

/**
 * The audit trail.
 *
 * Written by database triggers rather than by callers, so a transition
 * cannot happen unlogged. An application is never deleted, only withdrawn
 * or abandoned, which is what makes this the durable record of what was
 * done on your behalf.
 */
export default async function ApplicationEvents(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await currentSession();
  if (!session) redirect("/login");
  const detail = await loadApplication(session.client, id);
  if (!detail) notFound();
  const events = await loadEvents(session.client, id);

  return (
    <main className="wrap">
      <p className="back"><Link href={`/applications/${id}`}>← review</Link></p>
      <h1>Audit trail</h1>
      <p className="muted">{detail.summary.company} — {detail.summary.title}</p>

      <table className="apps">
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td className="muted small">{e.occurredAt.slice(0, 19).replace("T", " ")}</td>
              <td>{e.event}</td>
              <td>{e.fromStatus && e.toStatus ? `${e.fromStatus} → ${e.toStatus}` : (e.toStatus ?? "")}</td>
              <td className="muted small">{e.actor ?? ""}</td>
              <td className="muted small">{e.detail ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {events.length === 0 && <p className="muted">No events recorded yet.</p>}
    </main>
  );
}
