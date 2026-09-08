-- Portal-managed application credentials, end-to-end encrypted to the worker.
--
-- RECONCILING INVARIANT 13
--
-- 0081 said "there is no credentials table and there is not meant to be
-- one": passwords lived only in the macOS keychain, and Supabase held just
-- a keychain item name. The owner has asked to manage credentials in the
-- portal instead, for findability. This adds a credential-shaped table --
-- but it never holds a usable secret. The password is encrypted IN THE
-- BROWSER to a public key whose PRIVATE half never leaves the owner's Mac
-- (the local worker). Supabase, Vercel, a DB leak, a backup, a log, and
-- this assistant all only ever see ciphertext. So the invariant's intent --
-- no readable secret anywhere but the owner's own machine -- is preserved;
-- what changes is that the ciphertext is now stored and shown as "set"
-- rather than the plaintext sitting in a keychain. The keychain path
-- (workday_tenants.credential_ref) remains valid and untouched.

-- The worker's public key(s). The private key is generated on and never
-- leaves the owner's machine; only this public half is uploaded, and it is
-- what the browser encrypts to. Safe to read.
create table if not exists worker_public_keys (
  id          uuid primary key default uuid_generate_v4(),
  label       text not null,                 -- e.g. "Ty's MacBook"
  algo        text not null,                 -- e.g. "RSA-OAEP-256"
  public_key  text not null,                 -- base64 SPKI
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

alter table worker_public_keys enable row level security;
create policy "owner reads worker keys"  on worker_public_keys for select using (is_app_owner());
create policy "owner writes worker keys" on worker_public_keys for all    using (is_app_owner()) with check (is_app_owner());

-- One credential per employer (companies.id). username is the login (usually
-- an email) and is NOT secret. secret_ciphertext is the password sealed to a
-- worker public key; the plaintext exists only transiently in the browser at
-- entry and on the worker at run time. There is no column that can hold a
-- readable password, by construction.
create table if not exists portal_credentials (
  id                uuid primary key default uuid_generate_v4(),
  company_id        uuid not null unique references companies(id) on delete cascade,
  -- The account-based ATS host this credential logs into (e.g. a Workday
  -- tenant host). Informational + used by the worker to target the login.
  ats              text,
  login_host        text,
  username          text not null,
  secret_ciphertext text not null,           -- base64, sealed to worker_public_keys
  encrypted_to      uuid not null references worker_public_keys(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table portal_credentials enable row level security;
create policy "owner reads credentials"  on portal_credentials for select using (is_app_owner());
create policy "owner writes credentials" on portal_credentials for all    using (is_app_owner()) with check (is_app_owner());

-- A guard mirroring the invariant's intent: the ciphertext must not look
-- like a plaintext password slipped in by mistake. It must be base64 and of
-- a length only encryption produces (RSA-OAEP over a short string yields a
-- block hundreds of bytes long). A human password would fail this.
alter table portal_credentials add constraint secret_is_ciphertext check (
  secret_ciphertext ~ '^[A-Za-z0-9+/=]+$' and length(secret_ciphertext) >= 300
);
