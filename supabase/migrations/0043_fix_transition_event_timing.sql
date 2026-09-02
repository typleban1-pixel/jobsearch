-- The creation event was written before the row it references existed.
--
-- 0040 put both validation and event logging in one BEFORE INSERT
-- trigger. Validation has to be BEFORE, to reject a bad row; the event
-- has to be AFTER, because application_events has a foreign key to
-- applications and the row is not there yet during BEFORE INSERT. One
-- trigger could not be both, so it is now two.

create or replace function application_transition_guard() returns trigger as $$
declare
  ok boolean := false;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT' then
      raise exception 'an application starts at DRAFT, not %', new.status;
    end if;
    return new;
  end if;

  if new.status = old.status then return new; end if;

  ok := case old.status
    when 'DRAFT'               then new.status in ('PREPARING','ABANDONED','WITHDRAWN')
    when 'PREPARING'           then new.status in ('BLOCKED_NEEDS_INPUT','AWAITING_REVIEW','READY_TO_SUBMIT','DRAFT','ABANDONED')
    when 'BLOCKED_NEEDS_INPUT' then new.status in ('AWAITING_REVIEW','READY_TO_SUBMIT','PREPARING','ABANDONED','WITHDRAWN')
    when 'AWAITING_REVIEW'     then new.status in ('READY_TO_SUBMIT','BLOCKED_NEEDS_INPUT','PREPARING','ABANDONED','WITHDRAWN')
    when 'READY_TO_SUBMIT'     then new.status in ('SUBMITTED','BLOCKED_NEEDS_INPUT','AWAITING_REVIEW','ABANDONED','WITHDRAWN')
    when 'SUBMITTED'           then new.status in ('ACKNOWLEDGED','REJECTED','WITHDRAWN','ABANDONED','IN_PROCESS')
    when 'ACKNOWLEDGED'        then new.status in ('IN_PROCESS','REJECTED','WITHDRAWN','ABANDONED')
    when 'IN_PROCESS'          then new.status in ('INTERVIEWING','REJECTED','WITHDRAWN','ABANDONED')
    when 'INTERVIEWING'        then new.status in ('OFFER','REJECTED','WITHDRAWN','ABANDONED')
    when 'OFFER'               then new.status in ('REJECTED','WITHDRAWN','ABANDONED')
    else false
  end;

  if not ok then
    raise exception 'illegal application transition % -> %', old.status, new.status
      using hint = 'See the state machine in APPLICATIONS.md. Applications are withdrawn or abandoned, never deleted.';
  end if;

  if new.status = 'READY_TO_SUBMIT' and not new.all_fields_confident then
    raise exception 'READY_TO_SUBMIT requires every required field to be VERIFIED, DERIVED or HUMAN_CONFIRMED with no BLOCKED field';
  end if;

  return new;
end $$ language plpgsql;

-- The log, after the fact, so it can reference a row that exists.
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
end $$ language plpgsql;

create trigger applications_log_transition
  after insert or update on applications
  for each row execute function application_log_transition();

comment on function application_log_transition() is
  'Writes the audit event. Separate from the guard because validation must run BEFORE the row exists and logging must run after it does.';
