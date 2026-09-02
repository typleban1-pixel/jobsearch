import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "../../lib/portal/session.ts";
import { loadApplications, loadQueue } from "../../lib/portal/applications.ts";

export const dynamic = "force-dynamic";

/**
 * Which pile an application belongs in.
 *
 * One function, decided per application, rather than a list of statuses
 * matched per group. The list version needed a guard to stop two groups
 * claiming the same row, and that guard silently emptied a whole group
 * the moment a status appeared in two lists.
 */
const BUCKETS = [
  "Needs your answers",
  "Ready to review",
  "Approved, ready to submit",
  "Being assembled",
  "Submitted",
  "Closed",
] as const;

function bucketOf(a: { status: string; blocked: number; humanApproved: boolean }): string | null {
  if (["REJECTED", "WITHDRAWN", "ABANDONED"].includes(a.status)) return "Closed";
  if (["SUBMITTED", "ACKNOWLEDGED", "IN_PROCESS", "INTERVIEWING", "OFFER"].includes(a.status)) return "Submitted";
  // Blocked answers outrank everything else that is still in progress:
  // a question you have not answered is the thing to show you.
  if (a.blocked > 0) return "Needs your answers";
  if (a.status === "READY_TO_SUBMIT") return "Approved, ready to submit";
  if (a.status === "DRAFT") return "Being assembled";
  // Nothing blocked and not yet approved: it is waiting on you to read it,
  // whatever the lifecycle column happens to say.
  return "Ready to review";
}
export default async function Applications() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const apps = await loadApplications(session.client);
  const queue = await loadQueue(session.client);

  return (
    <main className="wrap">
      <p className="back"><Link href="/jobs">← all jobs</Link></p>
      <h1>Applications</h1>
      <p className="muted">
        {apps.length} application{apps.length === 1 ? "" : "s"}.{" "}
        {queue.length > 0
          ? <><Link href="/applications/queue"><strong>{queue.length} question{queue.length === 1 ? "" : "s"} waiting for you</strong></Link>.</>
          : "No questions are waiting."}
      </p>

      {BUCKETS.map((label) => {
        const rows = apps.filter((a) => bucketOf(a) === label);
        if (!rows.length) return null;
        return (
          <section key={label}>
            <h2>{label}</h2>
            <table className="apps">
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link href={`/applications/${a.id}`}>{a.company} — {a.title}</Link>
                      {a.postingChanged && <span className="chip warn"> posting changed since freeze</span>}
                    </td>
                    <td className="num">{a.accountedFor}/{a.required} required</td>
                    <td className="num">{a.blocked > 0 ? `${a.blocked} blocked` : "none blocked"}</td>
                    <td>{a.allFieldsConfident ? "all fields accounted for" : "incomplete"}</td>
                    <td>{a.humanApproved ? "approved" : "not approved"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}

      {apps.length === 0 && (
        <p className="muted">
          Nothing yet. Open a job and choose to apply; the application is assembled by the
          local worker, which is where the model key lives.
        </p>
      )}
    </main>
  );
}
