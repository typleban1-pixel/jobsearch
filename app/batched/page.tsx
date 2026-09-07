import { redirect } from "next/navigation";
import Link from "next/link";
import { withSession } from "../../lib/portal/session.ts";
import { loadApplyBoard } from "../../lib/portal/applyBoard.ts";
import { nextSubmitWindow, describeWindow, windowClock, SUBMIT_WINDOW_HOURS, SUBMIT_TZ, isDue } from "../../lib/automation/submitWindows.ts";
import { PrimaryNav } from "../PrimaryNav.tsx";
import { AutoRefreshApply } from "../apply/AutoRefreshApply.tsx";
import { Row } from "../apply/ApplyRowView.tsx";

export const dynamic = "force-dynamic";

/**
 * What you approved, waiting for the next scheduled run.
 *
 * Approving puts an application here. The listener on the Mac sends the
 * batch at midnight, 8:00 AM and 4:00 PM; nothing else has to happen. The
 * small button at the bottom is for when you want them sent now: it
 * clears the hold, the listener notices within seconds, Chrome opens on
 * the Mac and the applications go out one at a time, a few minutes apart.
 * Every submission gate still runs at the moment of sending.
 */
export default async function BatchedPage() {
  const loaded = await withSession((db) => loadApplyBoard(db));
  if (!loaded) redirect("/login");
  const board = loaded.result;
  const now = new Date();
  const rows = [...board.ready].sort((a, b) =>
    Number(b.submitRunning) - Number(a.submitRunning)
    || Number(isDue(b.submitNotBefore, now)) - Number(isDue(a.submitNotBefore, now))
    || String(a.submitNotBefore ?? "").localeCompare(String(b.submitNotBefore ?? "")));
  const held = rows.filter((r) => !r.submitRunning && !isDue(r.submitNotBefore, now));
  const running = rows.filter((r) => r.submitRunning).length;
  const next = nextSubmitWindow(now);
  // The three run times, said as clock words, from any day in the zone.
  const clocks = SUBMIT_WINDOW_HOURS.map((h) => {
    const d = new Date(now); d.setUTCHours(12, 0, 0, 0);
    const local = Number(new Intl.DateTimeFormat("en-US", { timeZone: SUBMIT_TZ, hour: "numeric", hourCycle: "h23" }).format(d));
    return windowClock(new Date(d.getTime() + (h - local) * 3_600_000));
  });
  const runTimes = `${clocks.slice(0, -1).join(", ")} and ${clocks.at(-1)}`;

  return (
    <main className="apply batched">
      <AutoRefreshApply active={rows.length > 0} />
      <header className="applyhead">
        <h1>Batched</h1>
        <PrimaryNav current="batched" attention={board.needsYou.length} batched={rows.length} />
      </header>

      <p className="statusline" aria-label="Summary">
        <b>{rows.length}</b> batched
        <span className="sep" aria-hidden="true"> · </span>
        next run <b>{describeWindow(next, now).replace(/^at /, "")}</b>
        {running > 0 && <><span className="sep" aria-hidden="true"> · </span><b>{running}</b> submitting now</>}
      </p>

      {rows.length === 0 ? (
        <section className="caughtup">
          <h2>Nothing batched.</h2>
          <p>Approve an application on <Link href="/apply">Applications</Link> and it waits here for the next run. Runs happen at {runTimes}.</p>
        </section>
      ) : (
        <>
          <section className="applysection" id="batched" aria-labelledby="batched-h">
            <h2 id="batched-h">Waiting for the next run<span className="count">{rows.length}</span></h2>
            <p className="applysection-lead">Approved and handed to the submitter. Runs happen at {runTimes}; nothing for you to do.</p>
            <ul className="approws">{rows.map((r) => <Row key={r.applicationId} row={r} />)}</ul>
          </section>

          {held.length > 0 && (
            <form method="post" action="/api/applications/apply-now" className="applynow">
              <button type="submit" className="btn-quiet small">Apply to {held.length === 1 ? "this one" : `all ${held.length}`} now</button>
              <p className="muted">Opens Chrome on your Mac and submits {held.length === 1 ? "it" : "them one at a time, a few minutes apart"}. Every check still runs before the click.</p>
            </form>
          )}
        </>
      )}
    </main>
  );
}
