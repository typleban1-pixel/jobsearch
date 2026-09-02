import Link from "next/link";
import { PrimaryNav } from "../PrimaryNav.tsx";
import { redirect } from "next/navigation";
import { currentSession } from "../../lib/portal/session.ts";
import { loadAtsStatus } from "../../lib/portal/operations.ts";

export const dynamic = "force-dynamic";

/**
 * Automation controls.
 *
 * Everything here is a switch that already exists in the database. The
 * global auto-submit flag has been in operating_policy since the
 * beginning, defaulting to false, and turning it on currently authorizes
 * nothing at all because no worker reads it. That is stated on screen
 * rather than implied, because a switch that looks like it does
 * something and does not is worse than no switch.
 */
export default async function Settings() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const providers = await loadAtsStatus(session.client);
  const { data: policy } = await session.client
    .from("operating_policy").select("auto_submit_enabled,auto_submit_note").limit(1).single();
  const autoSubmit = Boolean(policy?.auto_submit_enabled);

  return (
    <main className="apply">
      <header className="applyhead">
        <h1>Settings</h1>
        <PrimaryNav current="settings" />
      </header>

      {/* The operational views that used to sit in the primary nav.
          None of them is a step in applying for a job, so none of them
          belongs beside Apply and Jobs; they are all still here. */}
      <section className="adminlinks">
        <h2>System</h2>
        <ul>
          <li><Link href="/handoff">Handoff inbox</Link></li>
          <li><Link href="/activity">Activity and pipeline history</Link></li>
          <li><Link href="/ats">ATS status</Link></li>
          <li><Link href="/companies">Companies</Link></li>
          <li><Link href="/applications">All applications</Link></li>
        </ul>
      </section>

      <h2>Automation controls</h2>

      <h2>Unattended submission</h2>
      <div className="banner">
        <strong>Off, and it authorizes nothing yet.</strong> No worker reads this flag. Before it
        can mean anything, there has to be a policy that says which applications qualify, and a
        second authorization mode in the database so that &ldquo;a policy allowed this&rdquo; is never
        recorded as &ldquo;you reviewed this&rdquo;. Neither exists yet.
      </div>
      <p className="muted small">
        Currently: <strong>{autoSubmit ? "enabled" : "disabled"}</strong>
        {policy?.auto_submit_note ? ` — ${policy.auto_submit_note}` : ""}
      </p>
      <form method="post" action="/api/settings/toggle">
        <input type="hidden" name="what" value="global-auto-submit" />
        <input type="hidden" name="value" value={autoSubmit ? "0" : "1"} />
        <button type="submit">{autoSubmit ? "Disable unattended submission" : "Enable unattended submission"}</button>
      </form>

      <h2>Per-ATS pause</h2>
      <p className="muted small">
        Pausing stops unattended application processing for one provider. It never affects
        ingestion, scoring or anything you do by hand.
      </p>
      <table className="apps">
        <tbody>
          {providers.map((p) => (
            <tr key={p.provider}>
              <td><strong>{p.provider}</strong></td>
              <td><span className={`chip ${p.capability === "PRODUCTION" ? "direct" : "warn"}`}>{p.capability}</span></td>
              <td><span className={`chip ${p.paused ? "warn" : "direct"}`}>{p.paused ? "paused" : "running"}</span></td>
              <td>
                <form method="post" action="/api/settings/toggle">
                  <input type="hidden" name="what" value={`pause:${p.provider}`} />
                  <input type="hidden" name="value" value={p.paused ? "0" : "1"} />
                  <button type="submit">{p.paused ? "Unpause" : "Pause"}</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Policy, once it exists</h2>
      <p className="muted small">
        These are the controls an automation policy would need. None are configurable yet, and
        listing them here is a statement of what is missing rather than a preview of something
        already built: candidacy classes allowed, minimum Fit, whether an unknown salary
        qualifies, which ATS may run unattended, whether each tailored resume needs individual
        review, a daily cap if you want one, and company or job exclusions.
      </p>
    </main>
  );
}
