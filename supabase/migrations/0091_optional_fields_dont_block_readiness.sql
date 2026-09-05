-- An unresolved OPTIONAL field must not hold an application out of
-- submission-readiness.
--
-- recompute_all_fields_confident counted EVERY blocked answer, so an
-- optional field the employer marked optional -- a deferred demographic,
-- a pronoun self-ID, an ambiguous "city of residence" left blank --
-- forced all_fields_confident false and the application could never
-- reach READY_TO_SUBMIT, even with every REQUIRED field verified. The
-- fill engine already submits with optional fields blank; this aligns
-- the readiness gate with that reality.
--
-- Fails closed on requiredness: is_required is NOT NULL DEFAULT true, and
-- coalesce(is_required,true) makes any unknown/ambiguous requiredness
-- count as required. A required blocked field still blocks; only
-- genuinely optional blocked fields stop counting. v_unaccounted was
-- already required-only, so this only widens by ignoring optional-blocked.
create or replace function recompute_all_fields_confident() returns trigger as $$
declare
  v_app uuid := coalesce(new.application_id, old.application_id);
  v_total integer;
  v_blocked integer;
  v_unaccounted integer;
begin
  select count(*),
         count(*) filter (where coalesce(is_required, true) and confidence_state = 'BLOCKED'),
         count(*) filter (where coalesce(is_required, true)
                            and confidence_state not in ('VERIFIED','DERIVED','HUMAN_CONFIRMED','LOW_STAKES_SURVEY'))
    into v_total, v_blocked, v_unaccounted
    from application_answers where application_id = v_app;

  perform set_config('app.recomputing_confidence', 'on', true);

  update applications
     set all_fields_confident = (v_total > 0 and v_blocked = 0 and v_unaccounted = 0),
         updated_at = now()
   where id = v_app;

  -- Only a REQUIRED blocked field knocks a ready application back to
  -- needing input; an optional one never did belong there.
  if v_blocked > 0 then
    update applications set status = 'BLOCKED_NEEDS_INPUT'
     where id = v_app and status = 'READY_TO_SUBMIT';
  end if;

  perform set_config('app.recomputing_confidence', 'off', true);
  return null;
end $$ language plpgsql;
