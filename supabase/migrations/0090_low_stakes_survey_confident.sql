-- Count LOW_STAKES_SURVEY answers as accounted-for.
--
-- recompute_all_fields_confident treated a required field as unaccounted
-- unless its confidence was VERIFIED, DERIVED or HUMAN_CONFIRMED. The
-- LOW_STAKES_SURVEY confidence (migration 0089) is a safe, deliberate
-- answer to a non-substantive recruiting/attribution question, so a
-- required survey field IS accounted for; leaving it out held
-- all_fields_confident false and blocked READY_TO_SUBMIT on any form with
-- a mandatory "how did you hear about us". Additive: only the accounted
-- set widens; BLOCKED still fails, and nothing else changes.
create or replace function recompute_all_fields_confident() returns trigger as $$
declare
  v_app uuid := coalesce(new.application_id, old.application_id);
  v_total integer;
  v_blocked integer;
  v_unaccounted integer;
begin
  select count(*),
         count(*) filter (where confidence_state = 'BLOCKED'),
         count(*) filter (where is_required
                            and confidence_state not in ('VERIFIED','DERIVED','HUMAN_CONFIRMED','LOW_STAKES_SURVEY'))
    into v_total, v_blocked, v_unaccounted
    from application_answers where application_id = v_app;

  perform set_config('app.recomputing_confidence', 'on', true);

  update applications
     set all_fields_confident = (v_total > 0 and v_blocked = 0 and v_unaccounted = 0),
         updated_at = now()
   where id = v_app;

  if v_blocked > 0 then
    update applications set status = 'BLOCKED_NEEDS_INPUT'
     where id = v_app and status = 'READY_TO_SUBMIT';
  end if;

  perform set_config('app.recomputing_confidence', 'off', true);
  return null;
end $$ language plpgsql;
