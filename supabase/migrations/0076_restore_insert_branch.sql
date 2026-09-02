-- Restores the INSERT branch that 0074 dropped.
--
-- The trigger is BEFORE INSERT OR UPDATE. On INSERT, old is NULL, so the
-- transition table falls through to "else false" and every new
-- application is rejected with "illegal application transition <NULL> ->
-- DRAFT". 0074 rebuilt this function from the body written in 0043,
-- which had already delegated the "created" event to
-- application_log_transition and therefore shows no INSERT branch; the
-- deployed function still had one. Replacing it lost that.
--
-- This restores the INSERT rule (an application starts at DRAFT and
-- nowhere else) and keeps 0074's manual-submission transition. The
-- "created" event stays where 0043 put it, in the AFTER trigger, so it
-- is not written twice.

create or replace function application_transition_guard() returns trigger as $$
declare ok boolean;
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

  -- The manual-confirmation path, and nothing else. Transaction-local
  -- flag, set only inside record_manual_submission.
  if not ok
     and old.status = 'AWAITING_REVIEW' and new.status = 'SUBMITTED'
     and coalesce(current_setting('app.manual_submission', true), '') = 'on' then
    ok := true;
  end if;

  if not ok then
    raise exception 'illegal application transition % -> %', old.status, new.status
      using hint = 'See the state machine in APPLICATIONS.md. Applications are withdrawn or abandoned, never deleted.';
  end if;

  if new.status = 'READY_TO_SUBMIT' and not new.all_fields_confident then
    raise exception 'READY_TO_SUBMIT requires every required field to be VERIFIED, DERIVED or HUMAN_CONFIRMED with no BLOCKED field';
  end if;

  return new;
end $$ language plpgsql security definer set search_path = public;
