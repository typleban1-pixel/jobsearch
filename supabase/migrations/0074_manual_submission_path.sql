-- Recording a submission a person already made.
--
-- Authorizing a machine to submit and recording that a human did submit
-- are different operations, and the state machine only had rules for the
-- first. Every path to SUBMITTED ran through READY_TO_SUBMIT, which
-- requires all_fields_confident, which is computed from mapped answer
-- rows. Ashby and Workday publish no application form, so those
-- applications have no answer rows, the trigger that computes the flag
-- never fires, and the column sits at its default of false forever.
--
-- The result: Popl's Senior Digital Marketing Manager was genuinely
-- submitted by hand, with an employer confirmation screenshot, and the
-- system had no legal way to say so. A record that cannot describe what
-- happened invites applying twice.
--
-- This adds ONE new transition, AWAITING_REVIEW -> SUBMITTED, permitted
-- only while a transaction-local flag is set, which only the function
-- below sets. It is not a general relaxation: a direct UPDATE still
-- fails exactly as before.

create or replace function application_transition_guard() returns trigger as $$
declare ok boolean;
begin
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

  -- The manual-confirmation path, and nothing else, may record a
  -- submission a person already made. The flag is transaction-local and
  -- set only inside record_manual_submission below.
  if not ok
     and old.status = 'AWAITING_REVIEW' and new.status = 'SUBMITTED'
     and coalesce(current_setting('app.manual_submission', true), '') = 'on' then
    ok := true;
  end if;

  if not ok then
    raise exception 'illegal application transition % -> %', old.status, new.status
      using hint = 'See the state machine in APPLICATIONS.md. Applications are withdrawn or abandoned, never deleted.';
  end if;

  -- Unchanged. The manual path never reaches READY_TO_SUBMIT, so this
  -- still governs every machine submission exactly as before.
  if new.status = 'READY_TO_SUBMIT' and not new.all_fields_confident then
    raise exception 'READY_TO_SUBMIT requires every required field to be VERIFIED, DERIVED or HUMAN_CONFIRMED with no BLOCKED field';
  end if;

  return new;
end $$ language plpgsql security definer set search_path = public;

-- The one operation allowed to use it.
--
-- Every guard here is checkable in the database. Whether the evidence
-- actually resolves on disk is checked by the caller before this runs,
-- because the database cannot see the filesystem.
create or replace function record_manual_submission(
  p_application_id uuid,
  p_submitted_at   timestamptz,
  p_confirmation_reference text,
  p_detail         text
) returns void as $$
declare
  a applications%rowtype;
  v_opening uuid;
  v_dupes integer;
begin
  select * into a from applications where id = p_application_id for update;
  if not found then raise exception 'no such application'; end if;

  if a.submitted_at is not null then
    raise exception 'already submitted at %', a.submitted_at;
  end if;
  if a.submission_mode is distinct from 'MANUAL' then
    raise exception 'this path records MANUAL submissions only; submission_mode is %', a.submission_mode;
  end if;
  if p_confirmation_reference is null or btrim(p_confirmation_reference) = '' then
    raise exception 'a manual submission needs employer confirmation evidence';
  end if;
  if p_submitted_at is null then
    raise exception 'a manual submission needs the time it was actually submitted';
  end if;
  -- If the automation may have clicked, this is the ambiguous case and
  -- belongs in the ambiguity-resolution workflow, not here.
  if a.submit_click_attempted_at is not null then
    raise exception 'the automation attempted a submit click on this application; resolve the ambiguity instead';
  end if;

  select canonical_opening_id into v_opening from jobs where id = a.job_id;
  if v_opening is not null then
    select count(*) into v_dupes
      from applications x join jobs j on j.id = x.job_id
     where x.id <> p_application_id
       and x.submitted_at is not null
       and j.canonical_opening_id = v_opening;
    if v_dupes > 0 then
      raise exception 'another application on this opening is already submitted';
    end if;
  end if;

  perform set_config('app.manual_submission', 'on', true);
  update applications
     set status = 'SUBMITTED',
         submitted_at = p_submitted_at,
         confirmation_reference = p_confirmation_reference,
         confirmation_email_received = false,
         submit_outcome = 'CONFIRMED',
         submit_outcome_at = now()
   where id = p_application_id;
  perform set_config('app.manual_submission', '', true);

  insert into application_events (application_id, event, detail, actor)
  values (p_application_id, 'SUBMISSION_CONFIRMED_BY_USER', p_detail,
          coalesce(current_setting('app.actor', true), 'user'));
end $$ language plpgsql security definer set search_path = public;

revoke all on function record_manual_submission(uuid, timestamptz, text, text) from public;
grant execute on function record_manual_submission(uuid, timestamptz, text, text) to authenticated, service_role;

comment on function record_manual_submission(uuid, timestamptz, text, text) is
  'Records a submission a person already completed on the employer site. Requires '
  'submission_mode MANUAL, employer confirmation evidence, a real submitted_at, no '
  'automated submit click, and passing duplicate-opening protection. Never sets '
  'all_fields_confident, never reaches READY_TO_SUBMIT, and never makes the application '
  'eligible for the automated worker.';
