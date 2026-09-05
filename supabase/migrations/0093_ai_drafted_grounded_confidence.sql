-- A grounded, AI-drafted open-ended answer is its own confidence.
--
-- "Why are you interested", "describe relevant experience", "tell us a fun
-- fact" are composed by the engine from VERIFIED/HUMAN_CONFIRMED evidence,
-- reframed for relevance and grounding-checked so they invent nothing. That
-- is neither a profile lookup (VERIFIED), a deterministic transform
-- (DERIVED), a person's own words (HUMAN_CONFIRMED), nor a throwaway survey
-- answer (LOW_STAKES_SURVEY). It gets its own value so the record shows what
-- produced it. It carries no evidence_ids requirement (it is not in the
-- VERIFIED/DERIVED set the grounded_states_cite_evidence check governs).
--
-- Additive; recompute is recreated to count it as accounted-for, alongside
-- the required-only blocked rule (0091) and LOW_STAKES_SURVEY (0090).
alter type field_confidence add value if not exists 'AI_DRAFTED_GROUNDED';

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
                            and confidence_state not in
                              ('VERIFIED','DERIVED','HUMAN_CONFIRMED','LOW_STAKES_SURVEY','AI_DRAFTED_GROUNDED'))
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
