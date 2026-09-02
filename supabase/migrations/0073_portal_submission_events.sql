-- Portal-written audit events, from a fixed vocabulary.
--
-- 0071 gave the browser one narrow function for the approval event and
-- deliberately withheld INSERT on application_events, so the audit trail
-- could not be edited from a page. The submission-request workflow needs
-- to record three more things a person does. Rather than open the table,
-- this widens that same door by exactly three names.
--
-- The allowlist is the point. A caller chooses which of these happened;
-- it cannot invent an event, and it cannot write on an application it
-- does not own.

create or replace function record_application_event(
  p_application_id uuid,
  p_event text,
  p_detail text
) returns void as $$
begin
  if not is_app_owner() then
    raise exception 'only the owner may record events on an application';
  end if;
  if p_event not in (
    'SUBMIT_REQUESTED',
    'SUBMISSION_CONFIRMED_BY_USER',
    'SUBMISSION_RULED_OUT_BY_USER'
  ) then
    raise exception 'record_application_event does not write %', p_event;
  end if;
  insert into application_events (application_id, event, detail, actor)
  values (p_application_id, p_event, p_detail,
          coalesce(current_setting('app.actor', true), 'user'));
end $$ language plpgsql security definer set search_path = public;

revoke all on function record_application_event(uuid, text, text) from public;
grant execute on function record_application_event(uuid, text, text) to authenticated;

comment on function record_application_event(uuid, text, text) is
  'Records one of three submission-workflow events on an application the caller owns. '
  'The event name is checked against a fixed list, so this cannot be used to write '
  'arbitrary audit history; the browser still has no INSERT grant on application_events.';
