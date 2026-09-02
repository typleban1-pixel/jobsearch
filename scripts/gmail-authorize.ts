/**
 * One-time browser authorization for the job-search mailbox.
 *
 *   node scripts/gmail-authorize.ts
 *
 * Opens Google's consent screen, takes the redirect on a loopback port,
 * and writes a refresh token to .secrets/gmail-oauth.json at mode 0600.
 * Nothing it obtains is printed. What you see is which account was
 * authorized and for which scope, which is what you need to confirm it
 * did the right thing and useless to anyone reading over your shoulder.
 */
import { statSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { optional, required, describeEnv } from "../lib/env.ts";
import { authorize, credentialStatus, SCOPE, GmailReauthRequired } from "../lib/gmail/oauth.ts";

if (!optional("GMAIL_OAUTH_CLIENT_ID") || !optional("GMAIL_OAUTH_CLIENT_SECRET")) {
  console.error("Gmail OAuth client credentials are not configured.\n");
  console.error(describeEnv(["GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET"]));
  console.error(`
Create a Desktop app OAuth client in Google Cloud (Gmail API enabled,
consent screen External/Testing with the job-search address as a test
user, scope ${SCOPE}), then put the two values in .env.local:

  GMAIL_OAUTH_CLIENT_ID=...
  GMAIL_OAUTH_CLIENT_SECRET=...
`);
  process.exit(2);
}

// Authorizing the wrong Google account is an easy mistake to make when a
// browser is already signed in as someone else, and a token for the
// personal mailbox is exactly what this integration must not hold.
let expect: string | undefined;
try {
  const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } });
  const { data } = await db.from("profile").select("email_job_search").single();
  expect = data?.email_job_search ?? undefined;
} catch {
  console.log("could not read the job-search address from the profile; "
    + "whichever account you authorize will be accepted.");
}

const existing = credentialStatus();
if (existing.present) {
  console.log(`replacing the existing credential for ${existing.account} `
    + `(obtained ${existing.obtainedAt})\n`);
}

console.log(`asking for ${SCOPE}`);
console.log(expect ? `sign in as ${expect}\n` : "\n");

try {
  const { account, scope } = await authorize(expect);
  const mode = (statSync(credentialStatus().path).mode & 0o777).toString(8);
  console.log(`\nauthorized ${account}`);
  console.log(`  scope       ${scope}`);
  console.log(`  stored at   ${credentialStatus().path} (mode ${mode})`);
  console.log(`\nNothing was printed that could be replayed. Next: node scripts/gmail-read-test.ts`);
} catch (err) {
  if (err instanceof GmailReauthRequired) console.error(`\n${err.message}`);
  else console.error(`\nauthorization failed: ${(err as Error).message}`);
  process.exit(1);
}
