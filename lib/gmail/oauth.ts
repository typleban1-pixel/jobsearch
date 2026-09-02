/**
 * Gmail OAuth for a single local worker.
 *
 * The whole point of this file is that a refresh token for a mailbox is a
 * standing key to read that mailbox, so it is treated like one: written
 * once to a 0600 file under .secrets/, never logged, never echoed, never
 * put in an application table, and never passed on a command line where
 * every process on the machine could read argv.
 *
 * Scope is gmail.readonly and nothing else. There is no code path here
 * that can modify, send, or delete mail, because the token this obtains
 * is not authorized to.
 *
 * Restricted scopes on a consent screen left in Testing get refresh
 * tokens that expire after seven days. That is not a bug to work around;
 * when it happens the worker stops and asks for reauthorization by name.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { required } from "../env.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The only scope this system ever asks for. Read, and not even all of it. */
export const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const SECRETS_DIR = resolve(process.cwd(), ".secrets");
const CREDENTIAL_FILE = resolve(SECRETS_DIR, "gmail-oauth.json");

/** Thrown when the only honest thing left to do is ask for a browser sign-in. */
export class GmailReauthRequired extends Error {
  constructor(why: string) {
    super(`Gmail reauthorization required: ${why}. Run: node scripts/gmail-authorize.ts`);
    this.name = "GmailReauthRequired";
  }
}

/**
 * The minimum that has to survive a restart. No access token (short
 * lived, kept in memory), no client id or secret (those live in
 * .env.local), no id token, no profile data beyond which mailbox was
 * authorized, which exists so a token for the wrong account is caught
 * rather than silently used.
 */
type Credential = {
  version: 1;
  account: string;
  scope: string;
  refresh_token: string;
  obtained_at: string;
};

const base64url = (b: Buffer) => b.toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function readCredential(): Credential | null {
  if (!existsSync(CREDENTIAL_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIAL_FILE, "utf8")) as Credential;
    if (!parsed.refresh_token || parsed.version !== 1) return null;
    return parsed;
  } catch {
    // A corrupt credential file is indistinguishable from no credential,
    // and reporting its contents to explain the parse failure is exactly
    // the thing this module must never do.
    return null;
  }
}

function writeCredential(c: Credential): void {
  if (!existsSync(SECRETS_DIR)) mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  chmodSync(SECRETS_DIR, 0o700);
  // Create it closed rather than creating it open and narrowing after: a
  // world-readable moment is still a disclosure.
  writeFileSync(CREDENTIAL_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(CREDENTIAL_FILE, 0o600);
}

/** Safe to print. Says whether a credential exists, never what it holds. */
export function credentialStatus(): {
  present: boolean; account?: string; scope?: string; obtainedAt?: string; path: string;
} {
  const c = readCredential();
  return c
    ? { present: true, account: c.account, scope: c.scope, obtainedAt: c.obtained_at, path: CREDENTIAL_FILE }
    : { present: false, path: CREDENTIAL_FILE };
}

/**
 * Google's token endpoint. Success bodies carry tokens, so nothing here
 * returns or logs a raw body; failures surface the error code only,
 * which is what actually tells you what went wrong.
 */
async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const code = String(body["error"] ?? `http_${res.status}`);
    if (code === "invalid_grant") {
      throw new GmailReauthRequired("the stored refresh token was rejected (expired or revoked)");
    }
    throw new Error(`Google token endpoint refused the request: ${code}`);
  }
  return body;
}

// Access tokens last about an hour. Holding one in memory for the life of
// a worker run avoids a refresh per API call; it is never written down.
let cached: { token: string; expiresAt: number } | null = null;

export async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const credential = readCredential();
  if (!credential) throw new GmailReauthRequired("no credential file is present");
  if (credential.scope !== SCOPE) {
    throw new GmailReauthRequired(`the stored credential is for a different scope than ${SCOPE}`);
  }

  const body = await tokenRequest({
    client_id: required("GMAIL_OAUTH_CLIENT_ID"),
    client_secret: required("GMAIL_OAUTH_CLIENT_SECRET"),
    refresh_token: credential.refresh_token,
    grant_type: "refresh_token",
  });

  const token = body["access_token"];
  if (typeof token !== "string") throw new GmailReauthRequired("Google returned no access token");
  // Google may narrow a grant. Using a token that no longer carries the
  // scope we asked for would fail later in a much more confusing place.
  const granted = String(body["scope"] ?? SCOPE);
  if (!granted.split(/\s+/).includes(SCOPE)) {
    throw new GmailReauthRequired(`the refreshed token no longer carries ${SCOPE}`);
  }
  const ttl = typeof body["expires_in"] === "number" ? body["expires_in"] : 3600;
  cached = { token, expiresAt: Date.now() + ttl * 1000 };
  return token;
}

/**
 * The browser half of the flow, on a loopback listener.
 *
 * PKCE is used even though a desktop client has a secret, because the
 * authorization code travels back through a local HTTP request and a
 * code alone must not be enough to redeem anything.
 */
export async function authorize(expectAccount?: string): Promise<{ account: string; scope: string }> {
  const clientId = required("GMAIL_OAUTH_CLIENT_ID");
  const clientSecret = required("GMAIL_OAUTH_CLIENT_SECRET");

  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(24));

  const { port, waitForCode, close } = await loopback(state);
  const redirectUri = `http://127.0.0.1:${port}`;

  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  // Offline is what produces a refresh token at all; consent forces one
  // to be reissued even if this account has approved the app before.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (expectAccount) url.searchParams.set("login_hint", expectAccount);

  const opened = openInBrowser(url.toString());
  if (!opened) {
    console.log("\ncould not open a browser. Visit this URL to authorize.");
    console.log("It carries no secret: a client id, a scope, and a one-time challenge.\n");
    console.log(url.toString() + "\n");
  }

  try {
    const code = await waitForCode();
    const body = await tokenRequest({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });

    const refresh = body["refresh_token"];
    if (typeof refresh !== "string") {
      throw new Error(
        "Google returned no refresh token. This usually means the account has an existing "
        + "grant for this client; revoke it at myaccount.google.com/permissions and retry.",
      );
    }
    const granted = String(body["scope"] ?? "");
    if (!granted.split(/\s+/).includes(SCOPE)) {
      throw new Error(`the granted scope does not include ${SCOPE}. Nothing was stored.`);
    }

    const token = String(body["access_token"]);
    cached = { token, expiresAt: Date.now() + 3_000_000 };
    const account = await whoami(token);
    if (expectAccount && account.toLowerCase() !== expectAccount.toLowerCase()) {
      cached = null;
      throw new Error(
        `authorized ${account}, but this system reads ${expectAccount}. Nothing was stored. `
        + "Sign in with the job-search account and retry.",
      );
    }

    writeCredential({
      version: 1, account, scope: SCOPE,
      refresh_token: refresh, obtained_at: new Date().toISOString(),
    });
    return { account, scope: SCOPE };
  } finally {
    close();
  }
}

/** Which mailbox a token actually belongs to. Costs one metadata call. */
async function whoami(token: string): Promise<string> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`could not read the account profile: http ${res.status}`);
  const body = await res.json() as { emailAddress?: string };
  if (!body.emailAddress) throw new Error("the account profile carried no address");
  return body.emailAddress;
}

function openInBrowser(url: string): boolean {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * A listener that accepts exactly one redirect, on the loopback
 * interface only. The state parameter is compared in constant time; a
 * mismatch is not a redirect we started.
 */
async function loopback(state: string): Promise<{
  port: number; waitForCode: () => Promise<string>; close: () => void;
}> {
  let resolveCode: (c: string) => void;
  let rejectCode: (e: Error) => void;
  const pending = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const reply = (status: number, message: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><title>Gmail authorization</title>`
        + `<body style="font:16px/1.5 system-ui;margin:4rem auto;max-width:32rem;color:#1f2933">`
        + `<p>${message}</p></body>`);
    };

    const got = url.searchParams.get("state") ?? "";
    const a = Buffer.from(got), b = Buffer.from(state);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      reply(400, "This request did not come from the authorization that was started here.");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      reply(200, "Authorization was declined. You can close this tab.");
      rejectCode(new Error(`authorization was declined: ${error}`));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) { reply(400, "No authorization code was returned."); return; }
    reply(200, "Authorized. You can close this tab and return to the terminal.");
    resolveCode(code);
  });

  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not bind a loopback port");

  const timer = setTimeout(
    () => rejectCode(new Error("timed out waiting for authorization (5 minutes)")),
    5 * 60_000,
  );
  return {
    port: address.port,
    waitForCode: () => pending,
    close: () => { clearTimeout(timer); server.close(); },
  };
}
