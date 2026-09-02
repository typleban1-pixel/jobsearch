-- Workday accounts and sessions, per tenant.
--
-- Workday is the largest source in the corpus -- 3,825 open jobs, 471 of
-- them eligible, 35% of everything eligible -- and none of it could be
-- applied to, because every tenant puts its form behind an account and
-- nothing recorded which tenants we already had one for. The session
-- itself has always persisted: the browser profile is a real Chrome
-- profile and its cookies survive. What was missing was the MEMORY, so
-- every run rediscovered its own ignorance and stopped.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- Passwords. Invariant 13 says there is no credentials table and there
-- is not meant to be one. credential_ref names an item in the macOS
-- login keychain -- "jobsearch-workday:ntrs.wd1.myworkdayjobs.com" --
-- and the secret never leaves that keychain. Nothing in this table is
-- unsafe to read, log, or show on screen.
--
-- Verification codes are likewise absent, and email verification is a
-- handoff for now.
--
-- WHY THE HOST IS THE KEY
--
-- Workday cookies are scoped to {tenant}.wdN.myworkdayjobs.com, so the
-- host is the isolation boundary the browser itself enforces. Keying on
-- anything coarser would claim an isolation we do not have. One tenant
-- may run several career sites; they share one account, which is why the
-- site is recorded but is not part of the key.

create table if not exists workday_tenants (
  id uuid primary key default uuid_generate_v4(),

  -- ntrs.wd1.myworkdayjobs.com. The cookie origin, and the identity.
  host text not null unique,
  -- ntrs. Display only.
  tenant text not null,
  -- The site last seen for this tenant. Informational.
  site text,
  company_id uuid references companies(id) on delete set null,

  account_state text not null default 'UNKNOWN'
    check (account_state in ('UNKNOWN', 'NONE', 'CREATING', 'EXISTS', 'LOCKED')),
  session_state text not null default 'UNKNOWN'
    check (session_state in ('VALID', 'EXPIRED', 'UNKNOWN')),

  -- The keychain item name. Never a secret.
  credential_ref text,

  account_creation_attempted_at timestamptz,
  account_created_at timestamptz,
  last_authenticated_at timestamptz,
  last_checked_at timestamptz,

  -- Why the last attempt stopped, in words a person can act on.
  handoff_reason text,
  -- The classified page state the last check ended on.
  last_page_state text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A credential reference must name this tenant and no other. Without
-- this, a bad write could file tenant A's host under tenant B's row and
-- the isolation would be lost at the storage layer rather than in code.
alter table workday_tenants drop constraint if exists workday_credential_ref_matches_host;
alter table workday_tenants add constraint workday_credential_ref_matches_host
  check (credential_ref is null or credential_ref like '%:' || host);

-- A secret must never be written here. This cannot detect every possible
-- mistake, but it refuses the obvious shapes outright.
alter table workday_tenants drop constraint if exists workday_credential_ref_is_a_reference;
alter table workday_tenants add constraint workday_credential_ref_is_a_reference
  check (credential_ref is null or credential_ref ~ '^[a-z0-9-]+:[a-z0-9.-]+$');

create index if not exists workday_tenants_by_state
  on workday_tenants (session_state, account_state);

comment on table workday_tenants is
  'Per-tenant Workday account and session state. Contains no secrets: credential_ref names an item in the macOS login keychain and the password never reaches this database. Authentication state says nothing about whether an application may be submitted.';
comment on column workday_tenants.host is
  'The cookie origin, and the isolation boundary. A session or credential for one host is never valid for another.';
comment on column workday_tenants.credential_ref is
  'macOS keychain item name, "service:account". Never a password.';
comment on column workday_tenants.session_state is
  'VALID only when a signed-in page was actually observed. UNKNOWN when the last check proved nothing either way, which is not the same as EXPIRED.';

alter table workday_tenants enable row level security;
drop policy if exists workday_tenants_owner_read on workday_tenants;
create policy workday_tenants_owner_read on workday_tenants
  for select to authenticated using (is_app_owner());
grant select on workday_tenants to authenticated;
