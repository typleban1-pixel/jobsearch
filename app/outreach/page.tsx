import { redirect } from "next/navigation";
import Link from "next/link";
import { withSession } from "../../lib/portal/session.ts";
import { loadOutreach } from "../../lib/outreach/draft.ts";
import { PrimaryNav } from "../PrimaryNav.tsx";
import { OutreachCard } from "./OutreachCard.tsx";

export const dynamic = "force-dynamic";

/**
 * Follow-up notes to recruiters, one per application you chose to write to.
 *
 * Each note is the person's own email as the pattern (compose.ts), with the
 * role, company, what the posting emphasises and the employer's field
 * filled from the posting as recorded. Copy it, attach the résumé, tweak a
 * line if you like, mark it sent.
 */
export default async function OutreachPage() {
  const loaded = await withSession((db) => loadOutreach(db));
  if (!loaded) redirect("/login");
  const notes = loaded.result;
  const open = notes.filter((n) => !n.sentAt), sent = notes.filter((n) => n.sentAt);
  return (
    <main className="apply outreach">
      <header className="applyhead">
        <h1>Outreach</h1>
        <PrimaryNav current="outreach" />
      </header>
      <p className="statusline"><b>{open.length}</b> to send <span className="sep" aria-hidden="true"> · </span><b>{sent.length}</b> sent</p>
      {notes.length === 0 && (
        <section className="caughtup">
          <h2>No notes yet.</h2>
          <p>Open an application you like on <Link href="/apply">Applications</Link> and press <b>Send a note</b>. The note follows your own email word for word, with the role, company and what the posting emphasises filled in, and lands here for you to copy.</p>
        </section>
      )}
      {open.map((n) => <OutreachCard key={n.applicationId} r={n} />)}
      {sent.length > 0 && (
        <details className="closed">
          <summary>Sent ({sent.length})</summary>
          {sent.map((n) => <OutreachCard key={n.applicationId} r={n} />)}
        </details>
      )}
    </main>
  );
}
