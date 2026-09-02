-- Closing an exposure, and making the class of bug impossible to repeat.
--
-- What was wrong
-- --------------
-- 0007 enabled RLS and created policies by looping over pg_tables AT THE
-- TIME IT RAN. Nine tables added afterwards fell outside that loop and
-- inherited Supabase's default grants instead:
--
--   capability_relations, corpus_statistics, credential_declarations,
--   job_interest, job_locations, opening_duplicate_reviews, openings,
--   operating_policy, term_aliases
--
-- Each had RLS disabled, zero policies, and SELECT, INSERT, UPDATE,
-- DELETE and TRUNCATE granted to BOTH anon and authenticated.
-- credential_declarations holds declared credential status;
-- operating_policy holds application policy and salary posture. Both were
-- readable and writable by anyone holding the project's publishable key,
-- which is public by definition.
--
-- The loop was the defect. A migration-time loop protects the past and
-- says nothing about the future, so the fix below is in three parts: the
-- nine tables now, the default privileges that produced them, and an
-- event trigger so the next table cannot arrive unprotected.

-- ============================================================
-- 1. The nine tables
-- ============================================================

do $$
declare t text;
begin
  foreach t in array array[
    'capability_relations','corpus_statistics','credential_declarations',
    'job_interest','job_locations','opening_duplicate_reviews','openings',
    'operating_policy','term_aliases'
  ] loop
    execute format('alter table public.%I enable row level security', t);

    -- anon is not a user of this system. It is the key a browser holds
    -- before anyone signs in.
    execute format('revoke all on public.%I from anon', t);

    -- authenticated reads through a policy and writes nothing. The one
    -- exception is granted separately below.
    execute format('revoke all on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);

    execute format(
      'create policy owner_read on public.%I for select to authenticated using (is_app_owner())', t);
  end loop;
end $$;

-- job_interest is the only table the portal writes. Saving, dismissing
-- and clearing are all INSERT or UPDATE; there is no DELETE grant here
-- or anywhere else.
grant insert, update on public.job_interest to authenticated;
create policy owner_write on public.job_interest
  for insert to authenticated with check (is_app_owner());
create policy owner_update on public.job_interest
  for update to authenticated using (is_app_owner()) with check (is_app_owner());

-- ============================================================
-- 2. The default privileges that caused it
-- ============================================================
--
-- Supabase grants new tables to anon and authenticated through default
-- privileges attached to the creating role. Revoking them is what stops
-- the next migration from reopening this by doing nothing at all.

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;

do $$
declare r text;
begin
  foreach r in array array['postgres','supabase_admin','supabase_auth_admin'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('alter default privileges for role %I in schema public revoke all on tables from anon', r);
      execute format('alter default privileges for role %I in schema public revoke all on sequences from anon', r);
      -- authenticated keeps SELECT by default, which is harmless while
      -- RLS is on and there is no policy: RLS with no policy denies.
      execute format('alter default privileges for role %I in schema public revoke insert, update, delete, truncate on tables from authenticated', r);
    end if;
  end loop;
exception when insufficient_privilege then
  raise notice 'could not alter default privileges for every role; the event trigger below is the backstop';
end $$;

-- ============================================================
-- 3. The backstop: new tables protect themselves
-- ============================================================
--
-- Default privileges are per creating role and can be bypassed by an
-- explicit GRANT. An event trigger fires on the CREATE TABLE itself, so
-- it holds whatever the migration author wrote or forgot.
--
-- It only ever REMOVES access. A table that genuinely needs a policy
-- still needs one written; the trigger guarantees that until then the
-- table denies rather than exposes.

create or replace function protect_new_table() returns event_trigger as $$
declare
  obj record;
begin
  for obj in select * from pg_event_trigger_ddl_commands() loop
    if obj.command_tag = 'CREATE TABLE' and obj.schema_name = 'public' then
      execute format('alter table %s enable row level security', obj.object_identity);
      execute format('revoke all on %s from anon', obj.object_identity);
      execute format('revoke insert, update, delete, truncate on %s from authenticated', obj.object_identity);
      raise notice 'protect_new_table: RLS enabled and anon revoked on %', obj.object_identity;
    end if;
  end loop;
end $$ language plpgsql security definer set search_path = public;

comment on function protect_new_table() is
  'Event trigger. Enables RLS and strips anon and authenticated write access from every new public table. Only ever removes access, so it cannot make a table more permissive than its author intended, and a table with no policy denies rather than exposes.';

drop event trigger if exists protect_new_table_trigger;
create event trigger protect_new_table_trigger
  on ddl_command_end when tag in ('CREATE TABLE')
  execute function protect_new_table();
