/**
 * Workday passwords, in the macOS login keychain and nowhere else.
 *
 * INVARIANT 13: there is no credentials table and there is not meant to
 * be one. This is the other half of that sentence -- the place secrets
 * actually live. Supabase stores a keychain item NAME; the secret is
 * never sent to it, to Vercel, to a log, to a screenshot, to an
 * application artifact or to a model prompt.
 *
 * WHY THE LOGIN KEYCHAIN AND NOT A FILE
 *
 * A file this process can read is a file anything running as this user
 * can read, and it would sit in a repo directory where a stray `git add`
 * or an artifact upload could carry it away. The login keychain is
 * encrypted at rest, survives a repo being deleted, and -- the point the
 * user asked for -- is openable in Keychain Access, so a human can read,
 * change or delete any of these passwords without this code.
 *
 * HOW THE SECRET AVOIDS THE PROCESS TABLE
 *
 * `security add-generic-password -w <secret>` would put the password in
 * argv, where any other process on the machine can read it from ps. So
 * `-w` is passed with no value, which makes security prompt on stdin
 * instead, and the secret is written to the child's stdin and never to
 * argv.
 *
 * That prompt asks TWICE -- "password data for new item:" then "retype
 * password for new item:" -- and a single write leaves the retype at
 * EOF, whereupon security reports "passwords don't match", re-prompts,
 * gets EOF again, and stores an EMPTY password while still exiting 0.
 * A silently empty credential that reports success is the worst
 * available outcome, so the secret is written twice and every store is
 * verified by reading it back.
 *
 * WHAT IS NEVER DONE HERE
 *
 * No password is derived from anything about the user. Deriving one from
 * a name, an email or a date makes every account guessable from public
 * facts. Each is independent random bytes.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

/** One service name for the whole subsystem; the account is the tenant host. */
export const KEYCHAIN_SERVICE = "jobsearch-workday";

/** The service used by tests, so a test can never touch a real credential. */
export const KEYCHAIN_TEST_SERVICE = "jobsearch-workday-selftest";

export interface KeychainRef {
  service: string;
  /** The tenant host. Safe to store and to print. */
  account: string;
}

/** The reference recorded in Supabase. Contains no secret. */
export const keychainRef = (tenantHost: string, service = KEYCHAIN_SERVICE): KeychainRef =>
  ({ service, account: tenantHost });

/** The reference as one storable string. */
export const refToString = (r: KeychainRef): string => `${r.service}:${r.account}`;

/**
 * A password Workday will accept, from cryptographic randomness.
 *
 * Workday tenants commonly require upper, lower, digit and symbol, and
 * commonly cap length around 32. One character of each required class is
 * placed first and the remainder filled from the full alphabet, then the
 * whole thing is shuffled, so the guarantee holds without the shape
 * being predictable.
 */
export function generatePassword(length = 28): string {
  if (length < 12) throw new Error("a Workday password below 12 characters is not worth generating");
  const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const LOWER = "abcdefghijkmnopqrstuvwxyz";
  const DIGIT = "23456789";
  // Symbols Workday accepts broadly. Quotes, backslash and spaces are
  // excluded: they survive a form badly and can break shell round-trips.
  const SYMBOL = "!#$%*+-=?@^_";
  const ALL = UPPER + LOWER + DIGIT + SYMBOL;
  const pick = (set: string) => set[randomBytes(1)[0]! % set.length]!;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < length) chars.push(pick(ALL));
  // Fisher-Yates with rejection-free indices; the bias from modulo over
  // a 4..28 range is irrelevant to a shuffle of an already-random set.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

const run = (args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> =>
  new Promise((resolve) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });

/**
 * Stores a password, replacing any existing one for this tenant.
 *
 * -U updates in place rather than erroring on a duplicate, and -w with
 * no value makes security read the secret from stdin instead of argv.
 */
export async function storePassword(ref: KeychainRef, password: string): Promise<void> {
  // Interactive mode (-i): security reads whole COMMANDS from stdin, so
  // the secret rides inside a command line that never touches argv.
  //
  // The earlier form, "-w" with no value, made security prompt for the
  // secret -- but it prompts on the controlling terminal when there is
  // one, not on stdin. Run from a Terminal window the first unattended
  // Workday preparation sat at "password data for new item:" waiting for
  // a person to type, while the generated password was written to a pipe
  // nobody read. Interactive mode has no such prompt. The password's
  // alphabet excludes quotes, backslashes and spaces (generatePassword),
  // so quoting it is exact.
  const q = (s: string) => `"${s.replace(/["\\]/g, "")}"`;
  const { code, err } = await run(["-i"],
    `add-generic-password -U -s ${q(ref.service)} -a ${q(ref.account)} -D ${q("Workday candidate account")} `
    + `-j ${q("Created by jobsearch. Safe to read, change or delete here.")} -w ${q(password)}\n`);
  // The secret is on stdin, so nothing here can echo it: err is
  // security's own prompt text and never contains the value.
  if (code !== 0) throw new Error(`keychain store failed for ${ref.account}: ${err.trim() || code}`);

  // security exits 0 even when the prompt sequence went wrong and an
  // empty password was written. Proving the round trip is the only way
  // to know a credential exists, and a silent empty one would surface
  // later as an unexplained INVALID_CREDENTIALS against a real employer.
  const stored = await readPassword(ref);
  if (stored !== password) {
    await deletePassword(ref);
    throw new Error(`keychain store for ${ref.account} did not round-trip; the item has been removed`);
  }
}

/** Reads a password back, or null when no item exists. */
export async function readPassword(ref: KeychainRef): Promise<string | null> {
  const { code, out } = await run([
    "find-generic-password", "-s", ref.service, "-a", ref.account, "-w",
  ]);
  if (code !== 0) return null;
  // -w prints the secret and a newline, and nothing else.
  const v = out.replace(/\n$/, "");
  return v.length ? v : null;
}

/** Whether a credential exists, without reading it. */
export async function hasPassword(ref: KeychainRef): Promise<boolean> {
  const { code } = await run(["find-generic-password", "-s", ref.service, "-a", ref.account]);
  return code === 0;
}

/** Removes a credential. Used by tests to clean up after themselves. */
export async function deletePassword(ref: KeychainRef): Promise<boolean> {
  const { code } = await run(["delete-generic-password", "-s", ref.service, "-a", ref.account]);
  return code === 0;
}

/**
 * Redacts a secret from any string about to be written down.
 *
 * The last line of defence, not the first. Nothing should be
 * constructing a string containing a password in the first place; this
 * exists so that a future logging change cannot quietly make one
 * durable.
 */
export function redact(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 8) continue;
    out = out.split(s).join("[redacted]");
  }
  return out;
}
