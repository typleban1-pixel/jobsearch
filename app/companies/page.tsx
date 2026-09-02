import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "../../lib/portal/session.ts";
import { loadDiscovery } from "../../lib/portal/operations.ts";

export const dynamic = "force-dynamic";

/**
 * Where employers came from, and which board matches were refused.
 *
 * The refusals are the part worth reading. A guessed token that finds a
 * real board belonging to somebody else is the single most dangerous
 * outcome in discovery, because it produces a company that looks checked
 * every day and quietly reports another company's jobs.
 */
export default async function Companies() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { sources, companies, rejected } = await loadDiscovery(session.client);

  const active = companies.filter((c: any) => c.lifecycle === "ACTIVE");
  const discovered = companies.filter((c: any) => c.lifecycle === "DISCOVERED");
  const validated = active.filter((c: any) => c.ats_token);
  const recent = [...validated].sort((a: any, b: any) =>
    String(b.last_checked_at ?? "").localeCompare(String(a.last_checked_at ?? ""))).slice(0, 40);

  return (
    <main className="wrap">
      <p className="back"><Link href="/jobs">← all jobs</Link> · <Link href="/ats">ATS status</Link></p>
      <h1>Company discovery</h1>
      <p className="muted">
        {companies.length} companies known · {validated.length} with a validated board ·{" "}
        {discovered.length} discovered and not yet checked
      </p>

      <h2>Where companies come from</h2>
      <table className="apps">
        <tbody>
          {sources.map((s: any) => (
            <tr key={s.id}>
              <td>{s.label}</td>
              <td className="muted small">{s.method}</td>
              <td className="num">{s.companies_found} found</td>
              <td className="muted small">
                last swept {s.last_run_at ? String(s.last_run_at).slice(0, 10) : "never"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sources.length === 1 && (
        <p className="muted small">
          One source. The universe is not limited by this today: {discovered.length} companies are
          already discovered and waiting to be checked for a board.
        </p>
      )}

      <h2>Recently validated boards</h2>
      <p className="muted small">
        A board counts as validated only when the company itself published the link, or a
        guessed token was corroborated against the company&apos;s own site. Geography is derived
        from where the jobs actually are, never from the company&apos;s address.
      </p>
      <table className="apps">
        <tbody>
          {recent.map((c: any) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td className="muted small">{c.ats_provider}:{c.ats_token}</td>
              <td className="muted small">{c.ats_detection_method ?? "—"}</td>
              <td className="small">
                {c.has_chicagoland_presence && <span className="chip direct">Chicagoland</span>}
                {c.hires_remote_us && <span className="chip">remote US</span>}
              </td>
              <td className="muted small">via {c.discovery_source ?? c.discovery_method}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Board matches that were refused</h2>
      <p className="muted small">
        {rejected.length === 0
          ? "None recorded."
          : `${rejected.length} candidate token${rejected.length === 1 ? "" : "s"} found a live board and were still rejected, because nothing on that board linked back to the company. Each of these would have been a company silently reporting another company's jobs.`}
      </p>
      <table className="apps">
        <tbody>
          {rejected.map((r, i) => (
            <tr key={i}>
              <td>{r.company}</td>
              <td className="muted small">{r.provider}:{r.token}</td>
              <td className="muted small">{String(r.testedAt).slice(0, 10)}</td>
              <td className="muted small">{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
