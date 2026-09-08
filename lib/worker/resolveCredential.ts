/**
 * Turn a portal-stored credential into a usable login, on the worker only.
 *
 * The portal stores username + a password encrypted to a worker public key
 * (migration 0099). This runs on the owner's Mac, reads the matching PRIVATE
 * key from the login keychain, and decrypts. The plaintext exists only here,
 * transiently, at run time -- never in the cloud, a log, or this assistant.
 *
 * Bridge to the existing login: syncToKeychain() writes the decrypted password
 * into the keychain item the mature Workday auth path already reads
 * (keychainRef(host)), so that code needs no change to sign in with a
 * portal-managed credential -- the portal is just the durable, user-facing
 * source, and the keychain a transient local cache populated from it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readPassword, storePassword, keychainRef, KEYCHAIN_SERVICE } from "../workday/keychain.ts";

const WORKER_KEY_SERVICE = "jobsearch-worker-key";

export interface ResolvedCredential {
  username: string;
  password: string;
  companyId: string;
  loginHost: string | null;
}

const b64ToBytes = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));

/** Decrypt the portal credential for an employer, or null if none stored. */
export async function resolveCredential(
  db: SupabaseClient,
  companyId: string,
): Promise<ResolvedCredential | null> {
  const { data: cred, error } = await db.from("portal_credentials")
    .select("username,secret_ciphertext,encrypted_to,login_host")
    .eq("company_id", companyId).maybeSingle();
  if (error) throw new Error(`read credential: ${error.message}`);
  if (!cred) return null;

  const privB64 = await readPassword(keychainRef(cred.encrypted_to, WORKER_KEY_SERVICE));
  if (!privB64) {
    throw new Error(
      `worker private key ${cred.encrypted_to} is not in this machine's keychain. ` +
      `Either this credential was encrypted on another Mac, or run worker-key-init here and re-save it.`,
    );
  }
  const priv = await crypto.subtle.importKey(
    "pkcs8", b64ToBytes(privB64) as unknown as BufferSource, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" }, priv, b64ToBytes(cred.secret_ciphertext) as unknown as BufferSource,
  );
  return {
    username: cred.username as string,
    password: new TextDecoder().decode(pt),
    companyId,
    loginHost: (cred.login_host as string | null) ?? null,
  };
}

/**
 * Populate the keychain item the existing Workday auth path reads for a
 * tenant, from the portal credential. Returns false if nothing is stored.
 * The password never leaves this machine: portal ciphertext -> decrypt here
 * -> keychain, both local.
 */
export async function syncCredentialToKeychain(
  db: SupabaseClient,
  companyId: string,
  tenantHost: string,
): Promise<boolean> {
  const c = await resolveCredential(db, companyId);
  if (!c) return false;
  await storePassword(keychainRef(tenantHost, KEYCHAIN_SERVICE), c.password);
  return true;
}
