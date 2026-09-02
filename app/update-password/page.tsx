import { redirect } from "next/navigation";
import { currentSession } from "../../lib/portal/session.ts";

export const dynamic = "force-dynamic";

/**
 * Set a new password.
 *
 * Reachable only with a valid session, which for a reset means the
 * recovery session established by the link. Anyone arriving without one
 * is sent to /login rather than shown a form that cannot work.
 */
export default async function UpdatePassword(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (!session) redirect("/login?error=" + encodeURIComponent("That recovery link is no longer valid. Request a new one."));

  const sp = await props.searchParams;
  const err = (Array.isArray(sp.error) ? sp.error[0] : sp.error) ?? null;

  return (
    <main className="wrap" style={{ maxWidth: 380, paddingTop: 80 }}>
      <h1 style={{ fontSize: 19, marginBottom: 4 }}>Set a new password</h1>
      <p className="provenance" style={{ marginBottom: 18 }}>
        Signed in as {session.email ?? "your account"}.
      </p>

      {err && <div className="banner" style={{ borderLeftColor: "var(--bad)", background: "var(--bad-soft)" }}>{err}</div>}

      <form method="post" action="/auth/update-password" className="controls" style={{ gridTemplateColumns: "1fr" }}>
        <div>
          <label htmlFor="password">New password</label>
          <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
        </div>
        <div>
          <label htmlFor="confirm">Confirm new password</label>
          <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} required />
        </div>
        <div><button type="submit" className="primary" style={{ width: "100%" }}>Set password</button></div>
      </form>
      <p className="provenance" style={{ marginTop: 12 }}>At least 12 characters.</p>
    </main>
  );
}
