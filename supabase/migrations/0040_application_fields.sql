-- Application fields, and the invariants that make them trustworthy.

alter table application_answers
  -- The employer's own field, kept so a review screen can show what was
  -- actually asked rather than a normalized paraphrase.
  add column field_key text,
  add column field_label text,
  add column is_required boolean not null default true,
  add column confidence_state field_confidence not null default 'BLOCKED',
  add column block_kind block_kind,
  add column blocked_reason text,
  -- Frozen profile rows this answer rests on. Empty for HUMAN_CONFIRMED.
  add column evidence_ids uuid[] not null default '{}',
  -- Rows the matcher considered and rejected, with why. This is what
  -- turns "answer this" into "answer this, and here is what you already
  -- said that is nearby".
  add column considered_evidence jsonb not null default '[]',
  add column resolved_at timestamptz,
  -- Null until the user decides. Never set by the system: an answer
  -- becoming reusable is a separate, explicit act.
  add column promote_to_bank boolean;

comment on column application_answers.confidence_state is
  'The only thing that decides whether a field may be submitted. No Fit score, coverage ratio or match confidence may be cited here: job ranking is comparative and allowed to be wrong, an application answer is not.';
comment on column application_answers.promote_to_bank is
  'Null until the user explicitly promotes the answer. Nothing in the system sets this.';

-- BLOCKED must say why, and a non-blocked field must not claim to be.
alter table application_answers add constraint blocked_states_explain_themselves
  check (
    (confidence_state = 'BLOCKED' and blocked_reason is not null and block_kind is not null)
    or (confidence_state <> 'BLOCKED' and block_kind is null)
  );

-- An answer that is VERIFIED or DERIVED must point at what verified it.
alter table application_answers add constraint grounded_states_cite_evidence
  check (confidence_state not in ('VERIFIED', 'DERIVED') or cardinality(evidence_ids) > 0);

alter table applications
  add column form_snapshot jsonb,
  add column form_snapshot_hash text,
  add column prepared_at timestamptz;

comment on column applications.form_snapshot_hash is
  'Hash of the ATS form structure at preparation time. Filling compares against it and aborts on any difference rather than typing prepared values into a changed form.';

-- ============================================================
-- all_fields_confident is COMPUTED
-- ============================================================
--
-- It was a plain boolean any writer could set to true, which made the
-- submission constraint depend on the honesty of whatever code touched it
-- last. It is now derived from the answers themselves and recalculated on
-- every answer write, so no code path can assert it.

create or replace function recompute_all_fields_confident() returns trigger as $$
declare
  v_app uuid := coalesce(new.application_id, old.application_id);
  v_blocked integer;
  v_unaccounted integer;
begin
  select count(*) filter (where confidence_state = 'BLOCKED'),
         count(*) filter (where is_required
                            and confidence_state not in ('VERIFIED','DERIVED','HUMAN_CONFIRMED'))
    into v_blocked, v_unaccounted
    from application_answers where application_id = v_app;

  update applications
     set all_fields_confident = (v_blocked = 0 and v_unaccounted = 0),
         updated_at = now()
   where id = v_app;

  -- A field that becomes blocked pulls the application back out of the
  -- ready state. Confidence is not a thing you can keep after the reason
  -- for it is gone.
  if v_blocked > 0 then
    update applications set status = 'BLOCKED_NEEDS_INPUT'
     where id = v_app and status = 'READY_TO_SUBMIT';
  end if;

  return null;
end $$ language plpgsql;

create trigger application_answers_recompute
  after insert or update or delete on application_answers
  for each row execute function recompute_all_fields_confident();

-- And it may not be set by hand.
create or replace function all_fields_confident_is_derived() returns trigger as $$
begin
  if tg_op = 'UPDATE'
     and new.all_fields_confident is distinct from old.all_fields_confident
     and coalesce(current_setting('app.recomputing_confidence', true), 'off') <> 'on' then
    raise exception 'all_fields_confident is computed from application_answers and may not be set directly'
      using hint = 'Change the answers. The trigger recalculates it.';
  end if;
  return new;
end $$ language plpgsql;

comment on function all_fields_confident_is_derived() is
  'Blocks hand-setting the submission gate. The recompute trigger sets the session flag; nothing reachable through PostgREST can.';

-- ============================================================
-- Legal transitions, and an event for every one
-- ============================================================

create or replace function application_transition_guard() returns trigger as $$
declare
  ok boolean := false;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT' then
      raise exception 'an application starts at DRAFT, not %', new.status;
    end if;
    insert into application_events (application_id, event, detail, to_status, actor)
    values (new.id, 'created', 'application drafted', new.status,
            coalesce(current_setting('app.actor', true), 'system'));
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

  -- The trigger writes the event, not the caller, so a transition cannot
  -- happen unlogged.
  insert into application_events (application_id, event, detail, from_status, to_status, actor)
  values (new.id, 'status_change', null, old.status, new.status,
          coalesce(current_setting('app.actor', true), 'system'));
  return new;
end $$ language plpgsql;

create trigger applications_transition_guard
  before insert or update on applications
  for each row execute function application_transition_guard();

create trigger applications_confident_is_derived
  before update on applications
  for each row execute function all_fields_confident_is_derived();
