-- The recompute trigger could not write the value it computes.
--
-- 0040 added two triggers that disagreed: one recalculates
-- all_fields_confident from the answers, the other refuses any change to
-- it unless app.recomputing_confidence is on. Nothing set that flag, so
-- the guard blocked the only legitimate writer. The guard was right; the
-- recompute needed to identify itself.

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

  -- Local to this transaction. Not settable through PostgREST, so the
  -- only way to change all_fields_confident is to change the answers.
  perform set_config('app.recomputing_confidence', 'on', true);

  update applications
     set all_fields_confident = (v_blocked = 0 and v_unaccounted = 0),
         updated_at = now()
   where id = v_app;

  if v_blocked > 0 then
    update applications set status = 'BLOCKED_NEEDS_INPUT'
     where id = v_app and status = 'READY_TO_SUBMIT';
  end if;

  perform set_config('app.recomputing_confidence', 'off', true);
  return null;
end $$ language plpgsql;

-- One source of truth for a field's state. is_confident was a second,
-- older boolean saying almost the same thing, and two columns that can
-- disagree about whether something may be submitted is the shape of an
-- accident.
alter table application_answers drop column is_confident;
alter table application_answers drop column needed_user_input;
