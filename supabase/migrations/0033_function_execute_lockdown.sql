-- anon must not be able to call anything.
--
-- verify-security.ts caught this: anon could execute is_app_owner().
-- It returns false for anon, since auth.uid() is null, so nothing leaked
-- through it. But a role with no data access should not be able to invoke
-- the authorization predicate itself, and the reason it could is a class
-- of mistake rather than one oversight.
--
-- PostgreSQL grants EXECUTE on every new function to PUBLIC. 0007 revoked
-- from anon once, over the functions that existed then. Every function
-- created afterwards, including the audit function added this session,
-- arrived callable by everyone again.

-- Everything that exists now.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
  end loop;
end $$;

-- Hand back only what each role actually calls.
grant execute on function is_app_owner() to authenticated, service_role;
grant execute on function security_audit() to authenticated, service_role;
grant execute on function bump_profile_version(text) to authenticated, service_role;
grant execute on function regrant_profile_columns() to service_role;

-- And for everything created from here on.
alter default privileges in schema public revoke all on functions from public;
alter default privileges in schema public revoke all on functions from anon;

do $$
declare r text;
begin
  foreach r in array array['postgres','supabase_admin'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('alter default privileges for role %I in schema public revoke all on functions from public, anon', r);
    end if;
  end loop;
exception when insufficient_privilege then
  raise notice 'default privileges not alterable for every role; the event trigger is the backstop';
end $$;

-- The same backstop as for tables. Default privileges are per creating
-- role and an explicit GRANT can override them; the event trigger fires
-- on the statement itself.
create or replace function protect_new_function() returns event_trigger as $$
declare obj record;
begin
  for obj in select * from pg_event_trigger_ddl_commands() loop
    if obj.command_tag in ('CREATE FUNCTION', 'ALTER FUNCTION') and obj.schema_name = 'public' then
      execute format('revoke all on function %s from public, anon', obj.object_identity);
    end if;
  end loop;
end $$ language plpgsql security definer set search_path = public;

comment on function protect_new_function() is
  'Event trigger. Strips the automatic PUBLIC execute grant from every new public function, so a role with no data access cannot call one.';

drop event trigger if exists protect_new_function_trigger;
create event trigger protect_new_function_trigger
  on ddl_command_end when tag in ('CREATE FUNCTION', 'ALTER FUNCTION')
  execute function protect_new_function();
