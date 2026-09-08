"use client";

/**
 * Approve, plus the account-setup handoff for account-based ATSes.
 *
 * Still a real form POST to /api/applications/approve, so approval works with
 * JavaScript off exactly as before. When JS is on and the employer needs an
 * account + login (Workday etc. with nothing stored yet), clicking also opens
 * two tabs: the employer's application page (you create the account) and the
 * portal credentials screen pre-filled for that employer (you save the login).
 * The form still submits, so the application is approved and waits in Batched.
 */
export interface AccountSetup { needed: boolean; applyUrl: string | null; companyId: string }

export function ApproveButton({
  applicationId, accountSetup,
}: {
  applicationId: string;
  accountSetup: AccountSetup | null;
}) {
  function onSubmit() {
    if (accountSetup?.needed) {
      if (accountSetup.applyUrl) window.open(accountSetup.applyUrl, "_blank", "noopener");
      window.open(`/credentials?company=${encodeURIComponent(accountSetup.companyId)}`, "_blank", "noopener");
    }
    // No preventDefault: let the native POST proceed so approval still happens.
  }
  return (
    <form method="post" action="/api/applications/approve" onSubmit={onSubmit}>
      <input type="hidden" name="applicationId" value={applicationId} />
      <button className="btn-primary" type="submit">Approve &amp; continue &rarr;</button>
      {accountSetup?.needed && (
        <p className="muted small">
          Opens two tabs: create the account on the employer&rsquo;s site, then save the login. The worker signs in with it at the next run.
        </p>
      )}
    </form>
  );
}
