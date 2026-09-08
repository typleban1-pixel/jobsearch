/**
 * One-time setup for the local worker's encryption key.
 *
 *   node scripts/worker-key-init.ts "Ty's MacBook"
 *
 * Generates an RSA-OAEP keypair. The PRIVATE key is stored in the macOS
 * login keychain and never leaves this machine; the PUBLIC key is uploaded
 * to worker_public_keys, where the portal's credentials screen reads it and
 * encrypts each password to it in the browser. At run time the worker reads
 * the private key back from the keychain to decrypt. This is the mechanism
 * that lets credentials live in the portal without a readable secret ever
 * leaving your Mac (see migration 0099).
 *
 * Idempotent-ish: re-running generates a NEW key and marks it active. Old
 * keys keep working for credentials already encrypted to them (the worker
 * tries each non-revoked private key it holds); rotate by re-running, then
 * re-saving credentials so they seal to the new key.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { storePassword, keychainRef } from "../lib/workday/keychain.ts";

const WORKER_KEY_SERVICE = "jobsearch-worker-key";
const label = process.argv[2] ?? "local worker";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const b64 = (buf: ArrayBuffer) => Buffer.from(new Uint8Array(buf)).toString("base64");

const pair = await crypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["encrypt", "decrypt"],
);
const publicSpki = b64(await crypto.subtle.exportKey("spki", pair.publicKey));
const privatePkcs8 = b64(await crypto.subtle.exportKey("pkcs8", pair.privateKey));

// Record the public key first so we have its id to key the private key on.
const { data: row, error } = await db.from("worker_public_keys")
  .insert({ label, algo: "RSA-OAEP-256", public_key: publicSpki })
  .select("id").single();
if (error) { console.error(`upload public key failed: ${error.message}`); process.exit(1); }

// Private key -> macOS keychain, keyed by the public key's id. Base64 of a
// PKCS8 RSA-4096 key contains only [A-Za-z0-9+/=], so keychain quoting is
// exact and the round-trip verify in storePassword confirms it landed.
await storePassword(keychainRef(row.id, WORKER_KEY_SERVICE), privatePkcs8);

console.log(`worker key created`);
console.log(`  id:     ${row.id}`);
console.log(`  label:  ${label}`);
console.log(`  public: uploaded to worker_public_keys (${publicSpki.length} b64 chars)`);
console.log(`  private: stored in macOS keychain ${WORKER_KEY_SERVICE}:${row.id} (never leaves this Mac)`);
