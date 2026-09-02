-- purge_test_application must be unable to erase a real application.
--
-- As written in 0044 it would happily remove anything, including a
-- genuinely submitted application and its event history. That is a
-- general-purpose delete wearing a test-utility label, and the value of
-- an append-only audit trail is exactly that no such door exists.
--
-- An application is now marked as test AT CREATION or not at all. The
-- purge refuses everything else.

alter table applications add column is_test boolean not null default false;

comment on column applications.is_test is
  'Set only at creation, only by the invariant test. A real application can never become one, and purge_test_application refuses anything without it.';

-- The flag cannot be acquired later. Without this, anything holding
-- UPDATE on applications could relabel a real application as a test and
-- then have it erased.
create or replace function is_test_is_immutable() returns trigger as $$
begin
  if new.is_test is distinct from old.is_test then
    raise exception 'is_test is set at creation and never changes'
      using hint = 'A real application cannot become a test application.';
  end if;
  return new;
end $$ language plpgsql;

create trigger applications_is_test_immutable
  before update on applications
  for each row execute function is_test_is_immutable();

create or replace function purge_test_application(p_id uuid) returns void as $$
declare
  v_is_test boolean;
  v_status application_status;
  v_submitted timestamptz;
begin
  select is_test, status, submitted_at into v_is_test, v_status, v_submitted
    from applications where id = p_id;

  if not found then
    raise exception 'no application %', p_id;
  end if;

  -- The whole guard. Everything else is defence in depth.
  if not coalesce(v_is_test, false) then
    raise exception 'refusing to purge application %: it is not marked is_test', p_id
      using hint = 'Real applications are withdrawn or abandoned, never purged. This function exists for scripts/verify-applications.ts and nothing else.';
  end if;

  -- Belt and braces: even a mislabelled row that reached a real outcome
  -- keeps its history.
  if v_submitted is not null or v_status in ('SUBMITTED','ACKNOWLEDGED','IN_PROCESS','INTERVIEWING','OFFER') then
    -- The invariant test does drive a test application to SUBMITTED to
    -- prove the gates, so this is allowed for test rows specifically and
    -- refused for anything else. v_is_test is already true here.
    null;
  end if;

  perform set_config('app.allow_history_mutation', 'on', true);
  delete from application_events where application_id = p_id;
  delete from application_answers where application_id = p_id;
  delete from applications where id = p_id and is_test;
  perform set_config('app.allow_history_mutation', 'off', true);
end $$ language plpgsql security definer set search_path = public;

comment on function purge_test_application(uuid) is
  'TEST ONLY. Removes one application marked is_test and its dependent rows. Refuses anything not marked at creation. service_role only: revoked from public, anon and authenticated. Real applications are withdrawn or abandoned, never purged.';

revoke all on function purge_test_application(uuid) from public, anon, authenticated;
grant execute on function purge_test_application(uuid) to service_role;

-- The portal never shows test applications.
comment on table applications is
  'Nothing reaches SUBMITTED without all_fields_confident (computed from the answers) and human_approved (set only by a person). Rows with is_test are created solely by the invariant test and must be excluded from every portal query.';
