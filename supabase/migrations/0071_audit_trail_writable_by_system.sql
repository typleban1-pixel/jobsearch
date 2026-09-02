-- The audit trail must be writable by the system, not by the browser.
--
-- 0042 deliberately withheld INSERT on application_events from the
-- browser role so the audit trail could not be edited from a page. The
-- trigger that records status changes was left running as the caller,
-- so it inherited that refusal: any status change attempted from the
-- portal failed with "permission denied for table application_events"
-- and rolled the whole transaction back.
--
-- Two things were silently broken by this, both looking like something
-- else at the time:
--   - answering the last blocked question never moved an application
--     out of BLOCKED_NEEDS_INPUT, which looked like a stale count
--   - approving an application from the review screen failed outright
--
-- The fix keeps the original intent exactly. The browser still has no
-- INSERT grant and still cannot write an arbitrary event. Only these
-- functions may write, and they only write what actually happened.

create or replace function application_log_transition() returns trigger as $$
begin
  if tg_op = 'INSERT' then
    insert into application_events (application_id, event, detail, to_status, actor)
    values (new.id, 'created', 'application drafted', new.status,
            coalesce(current_setting('app.actor', true), 'system'));
  elsif new.status is distinct from old.status then
    insert into application_events (application_id, event, from_status, to_status, actor)
    values (new.id, 'status_change', old.status, new.status,
            coalesce(current_setting('app.actor', true), 'system'));
  end if;
  return null;
end $$ language plpgsql security definer set search_path = public;

-- One named event, written by the system on the caller's behalf.
--
-- The approval detail (which artifact, which answer set) is worth
-- keeping, and the browser cannot be given free INSERT to record it.
-- This records that one event and nothing else: the event name is fixed
-- here, not supplied by the caller, so this cannot become a way to write
-- arbitrary audit history.
create or replace function record_application_approval(
  p_application_id uuid,
  p_detail text
) returns void as $$
begin
  if not is_app_owner() then
    raise exception 'only the owner may approve an application';
  end if;
  insert into application_events (application_id, event, detail, actor)
  values (p_application_id, 'HUMAN_APPROVED', p_detail,
          coalesce(current_setting('app.actor', true), 'user'));
end $$ language plpgsql security definer set search_path = public;

revoke all on function record_application_approval(uuid, text) from public;
grant execute on function record_application_approval(uuid, text) to authenticated;

comment on function record_application_approval(uuid, text) is
  'Records the HUMAN_APPROVED audit event for an application the caller owns. '
  'The event name is fixed by this function; the browser has no INSERT grant on '
  'application_events and still cannot write arbitrary audit history.';
