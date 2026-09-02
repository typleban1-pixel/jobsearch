-- An application with no answers is not a confident application.
--
-- recompute_all_fields_confident counts blocked answers and unaccounted
-- required answers, and sets all_fields_confident when both counts are
-- zero. Over an empty set both counts are zero, so the rule reads "no
-- answers" as "nothing wrong with the answers".
--
-- That is reachable, and it is reachable on the unhappy path where it
-- does the most harm. prepareApplication() deletes an application's
-- answers before writing the new ones. If the write then fails -- and it
-- did fail, on the grounded_states_cite_evidence constraint, which is
-- what surfaced this -- the delete has already fired this trigger over
-- an empty table and left all_fields_confident true on an application
-- that now has nothing in it at all.
--
-- The default on the column is false, so a brand-new application was
-- never affected: the trigger is FOR EACH ROW and never fires when there
-- is nothing to delete. Only re-preparing an application that already
-- had answers could flip it, which is why this survived until an
-- application was prepared twice.
--
-- Nothing was submitted through this. READY_TO_SUBMIT is guarded
-- separately in 0043 and human_approved is set only by a person, so the
-- flag being wrong could not by itself send anything. It could make the
-- queue report a wrecked application as complete, which is enough.
--
-- The fix is to require evidence of confidence rather than absence of
-- doubt: at least one answer must exist before an application can claim
-- all of its fields are accounted for.

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
                            and confidence_state not in ('VERIFIED','DERIVED','HUMAN_CONFIRMED'))
    into v_total, v_blocked, v_unaccounted
    from application_answers where application_id = v_app;

  -- Local to this transaction. Not settable through PostgREST, so the
  -- only way to change all_fields_confident is to change the answers.
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

comment on column applications.all_fields_confident is
  'Computed from the answers by recompute_all_fields_confident, never set by hand. True only when at least one answer exists, none is BLOCKED, and every required one is VERIFIED, DERIVED or HUMAN_CONFIRMED. An application with no answers is not confident: emptiness is not agreement.';

-- ============================================================
-- What a stored answer may claim
-- ============================================================
--
-- No schema change. Recorded here because 0039 says VERIFIED means "an
-- approved profile row or approved question-bank answer says so", and
-- the second half of that is now wrong.
--
-- Being in the question bank is storage, not evidence. What a reused
-- answer may claim comes from its answer_provenance:
--
--   USER_RESPONSE   -> HUMAN_CONFIRMED, no evidence ids required. The
--                      user is the source. A self-declaration -- gender,
--                      veteran status, disability -- has no evidence row
--                      behind it and should not be given one.
--   PROFILE, EMPLOYMENT_RECORD, PROJECT, SKILL_RECORD, VERIFIED_ANSWER
--                   -> VERIFIED, and must cite what verified it.
--   CALCULATED      -> DERIVED, and must cite what it was derived from.
--   AI_DRAFT_...    -> never an answer; a draft is a proposal until a
--                      person approves it.
--
-- grounded_states_cite_evidence is unchanged and stays as it is. It was
-- correct: it caught this. The defect was upstream, in a resolver that
-- called a remembered self-declaration VERIFIED.
--
-- A row whose provenance promises evidence and carries none is BLOCKED
-- rather than downgraded, because calling it HUMAN_CONFIRMED would
-- assert the user confirmed something he may never have been asked.

comment on column question_bank.answer_provenance is
  'Where the approved answer came from, and therefore the confidence it may be given at. USER_RESPONSE resolves HUMAN_CONFIRMED and needs no evidence ids; the evidence-backed kinds resolve VERIFIED or DERIVED and must cite their rows. Storage is not evidence: reuse never promotes an answer.';
