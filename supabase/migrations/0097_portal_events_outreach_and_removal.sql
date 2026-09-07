-- The portal records three more kinds of event on an application it owns:
-- the recruiter follow-up note (drafted, edited, sent) and the person's own
-- removal of an application ("Not interested"). Same function, same
-- ownership check, same fixed list -- four names longer. The browser still
-- has no INSERT grant on application_events.
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
    'SUBMISSION_RULED_OUT_BY_USER',
    'OUTREACH_DRAFTED',
    'OUTREACH_EDITED',
    'OUTREACH_SENT',
    'ABANDONED_BY_PERSON'
  ) then
    raise exception 'record_application_event does not write %', p_event;
  end if;
  insert into application_events (application_id, event, detail, actor)
  values (p_application_id, p_event, p_detail,
          coalesce(current_setting('app.actor', true), 'user'));
end $$ language plpgsql security definer set search_path = public;

comment on function record_application_event(uuid, text, text) is
  'Records one of a fixed list of person-initiated events on an application the caller owns: '
  'the submission workflow events, the recruiter follow-up note (drafted, edited, sent), and '
  'the person removing an application. The list is fixed, so this cannot write arbitrary audit '
  'history; the browser has no INSERT grant on application_events.';
