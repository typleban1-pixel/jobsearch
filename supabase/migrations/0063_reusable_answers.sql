-- Making an answer the user chose to reuse actually reusable.
--
-- The queue has always offered "reuse this answer on future
-- applications". Ticking it set application_answers.promote_to_bank =
-- true and nothing else: no code read the column, so the promise was
-- never kept. Measured before this migration: 4 answers flagged for
-- reuse, 0 linked to a question_bank row, and 0 rows in every table the
-- feedback architecture writes to.
--
-- Two gaps are closed here.
--
-- 1. A question with no intent had nowhere to be stored. contextual_
--    answers.intent_key was NOT NULL, so an answer to a question the
--    catalog does not recognise could not be written at all. It becomes
--    nullable, and a row may instead be keyed on the exact normalized
--    wording, which is the same unit semantic_mappings already trusts.
--
-- 2. question_bank rows recorded no source. An approved answer that
--    cannot say which application and which question produced it is a
--    claim with no history, which is the thing this project exists to
--    avoid.
--
-- Nothing here weakens a guard. A row must still be keyed on something,
-- a LOCATION-scoped answer must still carry a location, and a
-- QUESTION-scoped answer must carry the wording it is keyed on.

-- ============================================================
-- Answers keyed on a question rather than an intent
-- ============================================================

alter table contextual_answers
  add column if not exists normalized_question text;

-- An answer for a question the catalog does not recognise has no intent
-- to be keyed on, and inventing one to make it storable is exactly the
-- move that turns "5+ years of SEO" into "SEO: yes".
alter table contextual_answers alter column intent_key drop not null;

alter table contextual_answers
  drop constraint if exists contextual_answer_has_a_scope;
alter table contextual_answers
  add constraint contextual_answer_has_a_scope check (
    scope <> 'NONE'
    -- A location-dependent answer names the location it depends on.
    and (scope <> 'LOCATION' or conditions ? 'locationCity' or conditions ? 'locationMetro')
    -- A question-keyed answer names the wording it is keyed on.
    and (scope <> 'QUESTION' or normalized_question is not null)
    -- And every row is keyed on one or the other, so nothing can be
    -- stored that has no way of being looked up again.
    and (intent_key is not null or normalized_question is not null)
  );

create index if not exists contextual_answers_by_question
  on contextual_answers (normalized_question) where normalized_question is not null;

comment on column contextual_answers.normalized_question is
  'The exact normalized wording a QUESTION-scoped answer is keyed on. Reuse requires this to match exactly: a near match is a different question, and answering it from here would be a guess.';
comment on column contextual_answers.intent_key is
  'The intent this answer is for, when the catalog recognises the question. Null for an answer keyed on wording alone. A row must be keyed on one or the other.';

-- ============================================================
-- Where an approved answer came from
-- ============================================================

alter table question_bank
  add column if not exists source_application_id uuid references applications(id) on delete restrict,
  add column if not exists source_answer_id uuid references application_answers(id) on delete set null,
  add column if not exists source_event_id uuid references answer_feedback_events(id) on delete restrict,
  add column if not exists source_question_raw text;

comment on column question_bank.source_application_id is
  'The application whose form asked the question that produced this answer. Recorded so an approved answer can always name the occasion it was given on.';
comment on column question_bank.source_question_raw is
  'The question as the employer actually worded it, kept verbatim. The intent key says what was asked; this says how it was asked.';
comment on column question_bank.source_event_id is
  'The feedback event that promoted this answer. Null only for rows created before promotion existed.';

-- ============================================================
-- What an intervention produced
-- ============================================================
--
-- An event already points at the mapping, contextual answer, adapter
-- rule or profile field it produced. Promotion to the question bank is a
-- fifth thing it can produce and needs the same pointer, under the same
-- fill-once rule: it may be written when it is null and never changed
-- afterwards, so an event can never be reattributed to a different row.

alter table answer_feedback_events
  add column if not exists resulting_question_bank_id uuid references question_bank(id) on delete restrict;

create or replace function feedback_event_guard() returns trigger as $$
declare
  frozen text[] := array['id','application_id','job_id','canonical_opening_id','employer','provider',
    'question_raw','question_normalized','provider_field_key','intent_before','confidence_before',
    'why_stopped','proposed_answer','human_answer','intent_confirmed','classification','reuse_scope',
    'conditions','audit','actor','occurred_at'];
  fill_once text[] := array['resulting_profile_field','resulting_mapping_id',
    'resulting_contextual_id','resulting_adapter_rule_id','resulting_question_bank_id'];
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  k text;
begin
  if coalesce(current_setting('app.allow_history_mutation', true), 'off') = 'on' then
    return new;
  end if;

  foreach k in array frozen loop
    if o -> k is distinct from n -> k then
      raise exception 'answer_feedback_events.% is the record of what was known at the time and cannot be changed', k
        using hint = 'Record a new intervention instead.';
    end if;
  end loop;

  foreach k in array fill_once loop
    if o -> k is distinct from n -> k and o -> k <> 'null'::jsonb then
      raise exception 'answer_feedback_events.% already names what this intervention produced', k;
    end if;
  end loop;

  return new;
end $$ language plpgsql;

-- ============================================================
-- Which answers have already been promoted
-- ============================================================
--
-- promote_to_bank records that the person ASKED for reuse. It cannot
-- also record that reuse happened, because a flag that means both cannot
-- distinguish "not yet" from "done", and a promotion that runs twice
-- would open a conflict against itself.
--
-- Promotion runs in the local worker rather than in the portal, for the
-- same reason preparation does: the deployed portal holds a publishable
-- Supabase key and nothing else, by design, and writing learned
-- knowledge needs more than that. Ticking the box in the queue records
-- the request; the worker fulfils it and stamps the event here.

alter table application_answers
  add column if not exists promoted_event_id uuid references answer_feedback_events(id) on delete restrict;

comment on column application_answers.promote_to_bank is
  'True when the person asked for this answer to be reusable. A request, not a result: promotion is what the worker does about it, and promoted_event_id is where it says so.';
comment on column application_answers.promoted_event_id is
  'The feedback event that promoted this answer, once one has. Null means the request has not been fulfilled yet, which is what makes promotion safe to re-run.';

create index if not exists application_answers_awaiting_promotion
  on application_answers (application_id)
  where promote_to_bank is true and promoted_event_id is null;

-- ============================================================
-- Conflicting reusable answers
-- ============================================================
--
-- feedback_conflicts already covers PROFILE_FACT, SEMANTIC_MAPPING and
-- CONTEXTUAL_ANSWER. A second, different answer to a question the bank
-- already holds is the same shape of problem and needs the same
-- treatment: record both, change nothing, let a person decide.

alter table feedback_conflicts
  drop constraint if exists feedback_conflicts_kind_check;
alter table feedback_conflicts
  add constraint feedback_conflicts_kind_check
  check (kind in ('PROFILE_FACT','SEMANTIC_MAPPING','CONTEXTUAL_ANSWER','BANK_ANSWER'));

comment on table feedback_conflicts is
  'Where new feedback disagrees with something already believed. Opened INSTEAD of a change, never alongside one: nothing in this system resolves a contradiction on its own.';
