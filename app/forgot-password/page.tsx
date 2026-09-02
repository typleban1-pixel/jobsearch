export const dynamic = "force-dynamic";

/**
 * Request a reset link.
 *
 * Exists so the app controls where the link lands. A reset started from
 * the Supabase dashboard uses the project's Site URL and arrives with the
 * session in a URL fragment; one started here names /auth/confirm
 * explicitly, which the server can read directly.
 *
 * This is not registration. It emails a link to an address that already
 * has an account and says nothing about whether the address exists.
 */
export default async function ForgotPassword(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const sent = (Array.isArray(sp.sent) ? sp.sent[0] : sp.sent) === "1";

  return (
    <main className="wrap" style={{ maxWidth: 380, paddingTop: 80 }}>
      <h1 style={{ fontSize: 19, marginBottom: 4 }}>Reset your password</h1>
      <p className="provenance" style={{ marginBottom: 18 }}>A link will be emailed if the address has an account.</p>

      {sent
        ? <div className="banner">If that address has an account, a reset link is on its way. The link expires shortly.</div>
        : (
          <form method="post" action="/auth/forgot-password" className="controls" style={{ gridTemplateColumns: "1fr" }}>
            <div>
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" autoComplete="username" required />
            </div>
            <div><button type="submit" className="primary" style={{ width: "100%" }}>Send reset link</button></div>
          </form>
        )}
      <p className="provenance" style={{ marginTop: 14 }}><a href="/login">Back to sign in</a></p>
    </main>
  );
}
