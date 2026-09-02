import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "../../lib/portal/session.ts";
import { loadAtsStatus } from "../../lib/portal/operations.ts";

export const dynamic = "force-dynamic";

const CAPABILITY: Record<string, string> = {
  PRODUCTION: "application automation is production-ready",
  IN_DEVELOPMENT: "adapter is being built; not usable yet",
  NONE: "ingest only; no application adapter exists yet",
};

/**
 * One row per ATS: what it can do, whether it is switched on, and what
 * it has actually produced.
 *
 * Capability and pause are shown as separate facts. An adapter can be
 * finished and paused, or unimplemented and unpaused, and collapsing the
 * two would let "cannot" read as "chose not to".
 */
export default async function AtsStatus() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const rows = await loadAtsStatus(session.client);

  return (
    <main className="wrap">
      <p className="back"><Link href="/jobs">← all jobs</Link> · <Link href="/activity">activity</Link> · <Link href="/settings">automation controls</Link></p>
      <h1>ATS status</h1>

      {rows.map((r) => (
        <section key={r.provider} className="queue-item">
          <p className="muted small">
            <strong style={{ fontSize: "1.05rem" }}>{r.provider}</strong>
            {" · "}<span className={`chip ${r.capability === "PRODUCTION" ? "direct" : "warn"}`}>{r.capability}</span>
            {" · "}<span className={`chip ${r.paused ? "warn" : "direct"}`}>{r.paused ? "paused" : "running"}</span>
          </p>
          <p className="small">{CAPABILITY[r.capability] ?? r.capability}</p>
          {r.capabilityNote && <p className="muted small">{r.capabilityNote}</p>}
          {r.paused && r.pausedReason && <p className="muted small">Paused because: {r.pausedReason}</p>}

          <table className="apps">
            <tbody>
              <tr>
                <td>validated boards</td><td className="num">{r.companies}</td>
                <td>open jobs known</td><td className="num">{r.openJobs}</td>
              </tr>
              <tr>
                <td>applications queued</td><td className="num">{r.applicationsQueued}</td>
                <td>handoffs</td><td className="num">{r.handoffs}</td>
              </tr>
              <tr>
                <td>confirmed submissions</td><td className="num">{r.submitted}</td>
                <td /><td />
              </tr>
            </tbody>
          </table>

          {r.recentFailures.length > 0 && (
            <details>
              <summary className="small">recent stops that were not clean handoffs ({r.recentFailures.length})</summary>
              <ul className="small">{r.recentFailures.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </details>
          )}
        </section>
      ))}

      <p className="muted small">
        Run timings live on <Link href="/activity">the activity feed</Link>, which records the
        scheduled pipeline rather than per-provider clocks.
      </p>
    </main>
  );
}
