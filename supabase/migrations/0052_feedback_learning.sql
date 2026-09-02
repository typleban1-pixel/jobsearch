-- Learning from the human, without learning the wrong thing.
--
-- When automation cannot answer a question and Ty answers it himself,
-- that intervention is evidence. What it is evidence ABOUT is the whole
-- problem. "I do not require relocation assistance" is a fact about a
-- person. "Yes, I can commute to that office" is a fact about one
-- office. "That control is the country selector, not a residence field"
-- is a fact about a form. A single table of question text to answer text
-- would flatten all three, and the first time it did, a New York
-- employer would be told he can commute to their office because he once
-- said yes to one in Chicago.
--
-- So the event is recorded in full, classified, and only then allowed to
-- become a reusable rule of a specific kind with a specific scope. The
-- events themselves are history and never change: a record of what the
-- system knew and needed help with at the time is worth nothing if a
-- later version can edit it to look better informed.

-- ============================================================
-- 1. The intervention itself
-- ============================================================

do $$ begin
  create type feedback_classification as enum (
    'PROFILE_FACT','SEMANTIC_MAPPING','CONTEXTUAL_ANSWER','ADAPTER_CORRECTION','ONE_OFF');
exception when duplicate_object then null; end $$;

do $$ begin
  create type feedback_reuse_scope as enum (
    'NONE','JOB','EMPLOYER','PROVIDER','LOCATION','TIME_SENSITIVE','INTENT','GLOBAL_FACT');
exception when duplicate_object then null; end $$;

create table if not exists answer_feedback_events (
  id uuid primary key default uuid_generate_v4(),
  application_id uuid not null references applications(id) on delete restrict,
  job_id uuid references jobs(id) on delete restrict,
  canonical_opening_id uuid,
  employer text,
  provider text,

  -- The question as the form asked it, and the form's own key for it.
  question_raw text not null,
  question_normalized text not null,
  provider_field_key text,

  -- What the system believed BEFORE the human spoke. These are the
  -- fields that make the record an audit trail rather than a rationalization.
  intent_before text,
  confidence_before text not null,
  why_stopped text not null,
  proposed_answer text,

  -- What the human supplied, and the intent they confirmed if any.
  human_answer text not null,
  intent_confirmed text,

  classification feedback_classification not null,
  reuse_scope feedback_reuse_scope not null,
  conditions jsonb not null default '{}',

  -- What this event produced, so a later answer can be traced back.
  resulting_profile_field text,
  resulting_mapping_id uuid,
  resulting_contextual_id uuid,
  resulting_adapter_rule_id uuid,
  audit text[] not null default '{}',

  actor text not null,
  occurred_at timestamptz not null default now(),

  -- Only a human produces feedback. Nothing the system does to itself
  -- may enter this table.
  constraint feedback_actor_is_human check (actor like 'user:%')
);

create index if not exists feedback_events_by_application on answer_feedback_events (application_id, occurred_at);
create index if not exists feedback_events_by_intent on answer_feedback_events (intent_confirmed, occurred_at);

comment on table answer_feedback_events is
  'Append only. One human intervention on an application question, with what the system believed beforehand. Never rewritten: a record that the system needed help is not allowed to become a record that it did not.';
comment on column answer_feedback_events.confidence_before is
  'What the resolver produced before the human answered. Kept so that later reuse can never be presented as knowledge the system already had.';
comment on column answer_feedback_events.conditions is
  'The conditions the answer was given under, chiefly the posting location. A contextual answer without conditions is not reusable at all.';

-- ============================================================
-- 2. What may be reused, and how far
-- ============================================================

-- A wording confirmed to carry an intent. Scoped to one ATS until the
-- same wording is confirmed somewhere else: one confirmation is exact
-- evidence about that form, not a general claim about phrasing.
create table if not exists semantic_mappings (
  id uuid primary key default uuid_generate_v4(),
  normalized_question text not null,
  intent_key text not null,
  provider text,
  confirmations integer not null default 1 check (confirmations >= 1),
  status text not null default 'ACTIVE' check (status in ('PROPOSED','ACTIVE','CONTRADICTED')),
  from_event_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists semantic_mappings_identity
  on semantic_mappings (normalized_question, intent_key, coalesce(provider, ''));

comment on table semantic_mappings is
  'Question wording that a human confirmed maps to an intent. Matched on the exact normalized wording only: nothing here generalizes by keyword similarity, because "commute to our Chicago office" and "commute to our New York office" differ by one word and by everything.';
comment on column semantic_mappings.status is
  'CONTRADICTED when a later human answer disagreed. A contradicted mapping stops answering until a person reconciles it; it is never silently switched.';

-- An answer that holds only under its conditions.
create table if not exists contextual_answers (
  id uuid primary key default uuid_generate_v4(),
  intent_key text not null,
  answer text not null,
  scope feedback_reuse_scope not null,
  conditions jsonb not null default '{}',
  employer text,
  provider text,
  job_id uuid references jobs(id) on delete restrict,
  expires_at timestamptz,
  confirmations integer not null default 1 check (confirmations >= 1),
  from_event_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),

  -- A contextual answer that names no conditions could be reused
  -- anywhere, which is the one thing it must never be.
  constraint contextual_answer_has_a_scope
    check (scope <> 'NONE' and (scope <> 'LOCATION' or conditions ? 'locationCity' or conditions ? 'locationMetro'))
);
create index if not exists contextual_answers_by_intent on contextual_answers (intent_key);

comment on table contextual_answers is
  'Answers that are true under stated conditions and false outside them. Reuse requires the conditions to match the new posting; an unknown location never matches a known one.';

-- What was learned about a form. Never an answer about the person.
create table if not exists ats_adapter_rules (
  id uuid primary key default uuid_generate_v4(),
  provider text not null,
  kind text not null check (kind in ('WIDGET_HELPER','CONTROL_IDENTITY','OPTION_SEMANTICS','FIELD_LABEL')),
  subject text not null,
  note text not null,
  confirmations integer not null default 1 check (confirmations >= 1),
  from_event_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create unique index if not exists ats_adapter_rules_identity on ats_adapter_rules (provider, kind, subject);

comment on table ats_adapter_rules is
  'Form behaviour learned from an intervention: which control a label belongs to, which entry is a widget helper. Improves snapshotting and reconciliation. Holds no personal answer and is never consulted for one.';

-- Feedback that disagrees with something already believed.
create table if not exists feedback_conflicts (
  id uuid primary key default uuid_generate_v4(),
  kind text not null check (kind in ('PROFILE_FACT','SEMANTIC_MAPPING','CONTEXTUAL_ANSWER')),
  subject text not null,
  existing text not null,
  incoming text not null,
  from_event_id uuid references answer_feedback_events(id) on delete restrict,
  status text not null default 'OPEN' check (status in ('OPEN','RESOLVED')),
  resolution text,
  resolved_by text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,

  constraint resolution_names_a_person
    check (status = 'OPEN' or (resolved_by is not null and resolution is not null))
);

comment on table feedback_conflicts is
  'A correction that contradicts an established fact or mapping. Opening one is the whole behaviour: nothing auto-resolves, because whichever side is right, a person decides which.';

-- ============================================================
-- 3. History stays history
-- ============================================================

-- The event is frozen the moment it is written, with one exception: the
-- pointers to what it produced are filled in immediately afterwards, as
-- the derived rows come into existence, and only while they are still
-- null. Nothing can go back and reattribute an event to a different
-- rule, or repoint a rule at a different event.
create or replace function feedback_event_guard() returns trigger as $$
declare
  frozen text[] := array['id','application_id','job_id','canonical_opening_id','employer','provider',
    'question_raw','question_normalized','provider_field_key','intent_before','confidence_before',
    'why_stopped','proposed_answer','human_answer','intent_confirmed','classification','reuse_scope',
    'conditions','audit','actor','occurred_at'];
  fill_once text[] := array['resulting_profile_field','resulting_mapping_id',
    'resulting_contextual_id','resulting_adapter_rule_id'];
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

drop trigger if exists feedback_events_immutable on answer_feedback_events;
create trigger feedback_events_immutable before update on answer_feedback_events
  for each row execute function feedback_event_guard();

drop trigger if exists feedback_events_no_delete on answer_feedback_events;
create trigger feedback_events_no_delete before delete on answer_feedback_events
  for each row execute function history_no_delete();

-- Learned rules are allowed to strengthen, weaken and be re-scoped as
-- evidence accumulates. What they may not do is change which event they
-- came from or what question they are about.
drop trigger if exists semantic_mappings_provenance on semantic_mappings;
create trigger semantic_mappings_provenance before update on semantic_mappings
  for each row execute function history_guard('{confirmations,status,provider,updated_at,from_event_ids}', '{}');

drop trigger if exists contextual_answers_provenance on contextual_answers;
create trigger contextual_answers_provenance before update on contextual_answers
  for each row execute function history_guard('{confirmations,expires_at,from_event_ids}', '{}');

-- ============================================================
-- 4. Reachable from the portal, read only
-- ============================================================

alter table answer_feedback_events enable row level security;
alter table semantic_mappings enable row level security;
alter table contextual_answers enable row level security;
alter table ats_adapter_rules enable row level security;
alter table feedback_conflicts enable row level security;

do $$
declare t text;
begin
  foreach t in array array['answer_feedback_events','semantic_mappings','contextual_answers',
                           'ats_adapter_rules','feedback_conflicts'] loop
    execute format('drop policy if exists %I_owner_read on public.%I', t, t);
    execute format($p$create policy %I_owner_read on public.%I for select to authenticated using (is_app_owner())$p$, t, t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- ============================================================
-- 5. Whether any of this is working
-- ============================================================

-- Deliberately counts corrections alongside automation. A rising
-- automation rate with a rising correction rate is a system getting
-- worse, and one number without the other hides it.
create or replace view feedback_learning_metrics as
select
  (select count(*) from application_fill_runs)                                as fill_runs,
  (select coalesce(sum(fields_attempted), 0) from application_fill_runs)      as fields_encountered,
  (select coalesce(sum(fields_filled), 0) from application_fill_runs)         as fields_answered_automatically,
  (select coalesce(sum(fields_left_blank), 0) from application_fill_runs)     as fields_left_for_human,
  (select count(*) from answer_feedback_events)                              as interventions,
  (select count(*) from answer_feedback_events where proposed_answer is not null
     and lower(proposed_answer) is distinct from lower(human_answer))         as corrections_to_filled_fields,
  (select count(*) from answer_feedback_events where proposed_answer is not null
     and lower(proposed_answer) = lower(human_answer))                        as confirmations_of_proposals,
  (select count(*) from answer_feedback_events where reuse_scope <> 'NONE')   as reusable_events,
  (select count(*) from answer_feedback_events where reuse_scope = 'NONE')    as one_off_events,
  (select count(*) from semantic_mappings where status = 'ACTIVE')            as semantic_mappings_learned,
  (select count(*) from answer_feedback_events
     where classification = 'PROFILE_FACT' and resulting_profile_field is not null) as profile_facts_learned,
  (select count(*) from ats_adapter_rules)                                    as adapter_rules_learned,
  (select count(*) from feedback_conflicts where status = 'OPEN')             as open_conflicts;

comment on view feedback_learning_metrics is
  'Automation and correction together. The question this exists to answer is whether human intervention is falling WITHOUT corrections rising; automation rate alone is not the goal and must never be read as one.';
