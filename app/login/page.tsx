import { RecoveryHandoff } from "./RecoveryHandoff.tsx";

export const dynamic = "force-dynamic";

/**
 * Sign in. There is no registration path and no way to create an account
 * from here: this system holds one person's employment history and has
 * exactly one account, recorded in app_owner.
 *
 * The email field is empty. Prefilling it would publish the owner's
 * address to anyone who loads the page.
 */
export default async function Login(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const err = (Array.isArray(sp.error) ? sp.error[0] : sp.error) ?? null;
  const next = (Array.isArray(sp.next) ? sp.next[0] : sp.next) ?? "/";

  return (
    <main className="wrap" style={{ maxWidth: 380, paddingTop: 80 }}>
      <h1 style={{ fontSize: 19, marginBottom: 4 }}>Sign in</h1>
      <p className="provenance" style={{ marginBottom: 18 }}>Private job search system. One account.</p>

      <RecoveryHandoff />

      {err && <div className="banner" style={{ borderLeftColor: "var(--bad)", background: "var(--bad-soft)" }}>{err}</div>}

      <form method="post" action="/auth/sign-in" className="controls" style={{ gridTemplateColumns: "1fr" }}>
        <input type="hidden" name="next" value={next} />
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <div><button type="submit" className="primary" style={{ width: "100%" }}>Sign in</button></div>
      </form>
      <p className="provenance" style={{ marginTop: 14 }}><a href="/forgot-password">Forgot your password?</a></p>
    </main>
  );
}
