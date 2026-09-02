-- A sanctioned door for test data, and only for test data.
--
-- verify-applications.ts must create real rows, because the whole point
-- is to test what the DATABASE refuses rather than what a mock does. It
-- then cannot remove them: application_events is append-only and holds an
-- ON DELETE RESTRICT reference, so a test application is as permanent as
-- a real one. That invariant is correct and stays.
--
-- The alternative was to let test rows accumulate as ABANDONED
-- applications, which would put fictional applications in the portal
-- beside real ones. Better to have one narrow, service-role-only function
-- that says exactly what it is than to blur what an application means.
--
-- Not granted to authenticated. The portal cannot reach this.

create or replace function purge_test_application(p_id uuid) returns void as $$
begin
  -- The escape hatch from 0007, used for its stated purpose: deliberate
  -- maintenance, in one transaction, by the worker.
  perform set_config('app.allow_history_mutation', 'on', true);
  delete from application_events where application_id = p_id;
  delete from application_answers where application_id = p_id;
  delete from applications where id = p_id;
  perform set_config('app.allow_history_mutation', 'off', true);
end $$ language plpgsql security definer set search_path = public;

comment on function purge_test_application(uuid) is
  'Removes an application and its history. Exists so the invariant test can clean up after itself; a real application is withdrawn or abandoned, never purged. service_role only.';

revoke all on function purge_test_application(uuid) from public, anon, authenticated;
grant execute on function purge_test_application(uuid) to service_role;
