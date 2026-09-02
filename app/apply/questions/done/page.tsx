import { redirect } from "next/navigation";
import { currentSession } from "../../../../lib/portal/session.ts";
import { loadBlockedGroups } from "../../../../lib/portal/applyBoard.ts";
import { PrimaryNav } from "../../../PrimaryNav.tsx";

export const dynamic = "force-dynamic";

export default async function Done() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const remaining = await loadBlockedGroups(session.client);
  if (remaining.length > 0) redirect("/apply/questions?q=1");
  return (
    <main className="wizard">
      <header className="applyhead"><h1>Questions</h1><PrimaryNav current="apply" /></header>
      <section className="caughtup">
        <h2>That&rsquo;s everything we needed.</h2>
        <p>Your answers were saved to each application separately.</p>
        <a className="btn-primary" href="/apply">Continue</a>
      </section>
    </main>
  );
}
