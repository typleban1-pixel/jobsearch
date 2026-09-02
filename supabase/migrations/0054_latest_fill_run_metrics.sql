-- Counting an application once.
--
-- feedback_learning_metrics summed every fill run. SpotHero has six:
-- two found no form to observe, three stopped part way, and the sixth
-- reached HANDOFF. Summed, that reported 49 fields encountered and 42
-- answered automatically for an application with fourteen fields, and
-- the 85.7% "automation rate" computed from it was a rate of nothing. A
-- retry made the system look busier and better at once, which is the
-- worst possible direction for a number meant to tell us whether it is
-- actually improving.
--
-- The fix separates two kinds of measurement that were wrongly sharing
-- an aggregation:
--
--   Application STATE is a snapshot. How much of this form is filled has
--   one answer at a time, so it comes from the latest applicable run per
--   application.
--
--   Feedback HISTORY is a stream. Three corrections on one application
--   are three corrections, and they keep being counted individually.
--   Nothing here deduplicates events, mappings, facts, adapter rules or
--   conflicts, and nothing may: solving a double-counted denominator by
--   flattening real history would trade one wrong number for a worse one.
--
-- No historical row is modified. Every run remains exactly as written
-- and remains readable; runs simply stop multiplying the denominator.

-- ============================================================
-- 1. Which run describes an application now
-- ============================================================

-- The ordering is total and deterministic, and never depends on physical
-- row order:
--
--   1. a run that observed a form beats one that did not. A run that
--      found no form observed nothing, and letting its zero stand as the
--      application's field count would report a filled form as empty.
--   2. then the most recent start. A form that changed between attempts
--      is described by the attempt that saw it last, whether that means
--      more fields or fewer.
--   3. then the later finish, with an unfinished run sorting last.
--   4. then the run id, so two runs that tie on everything else still
--      resolve the same way on every execution.
--
-- Test applications are excluded here rather than downstream, so nothing
-- reading this view has to remember to exclude them.
create or replace view latest_fill_run_per_application as
select distinct on (r.application_id)
       r.id,
       r.application_id,
       r.provider,
       r.outcome,
       r.started_at,
       r.finished_at,
       r.fields_attempted,
       r.fields_filled,
       r.fields_left_blank,
       (select count(*) from application_fill_runs h where h.application_id = r.application_id) as runs_for_this_application
  from application_fill_runs r
  join applications a on a.id = r.application_id
 where a.is_test = false
 order by r.application_id,
          (r.fields_attempted > 0) desc,
          r.started_at desc,
          r.finished_at desc nulls last,
          r.id desc;

comment on view latest_fill_run_per_application is
  'One row per non-test application: the run that describes its current fill state. A run that observed a form beats one that did not, then latest start, then latest finish (unfinished last), then run id. Earlier runs are untouched and still readable in application_fill_runs; they are simply not counted again here.';

-- ============================================================
-- 2. The metrics, with state and history kept apart
-- ============================================================

-- Dropped rather than replaced: the column list changes, and CREATE OR
-- REPLACE VIEW cannot rename or reorder existing columns. A view holds
-- no data, so this removes a query definition and nothing else.
drop view if exists feedback_learning_metrics;

create view feedback_learning_metrics as
select
  -- Application state: one observation per application.
  (select count(*) from latest_fill_run_per_application)                     as applications_measured,
  (select count(*) from applications a
    where a.is_test = false
      and not exists (select 1 from application_fill_runs r where r.application_id = a.id))
                                                                             as applications_without_a_fill_run,
  (select count(*) from applications a
    where a.is_test = false and a.status in ('ABANDONED', 'WITHDRAWN'))      as applications_abandoned,
  (select count(*) from application_fill_runs r
     join applications a on a.id = r.application_id
    where a.is_test = false)                                                 as fill_runs_including_retries,
  (select coalesce(sum(fields_attempted), 0) from latest_fill_run_per_application)   as fields_encountered,
  (select coalesce(sum(fields_filled), 0) from latest_fill_run_per_application)      as fields_answered_automatically,
  (select coalesce(sum(fields_left_blank), 0) from latest_fill_run_per_application)  as fields_left_for_human,

  -- Feedback history: every event, counted once each, never collapsed.
  -- Test applications are excluded because they describe nothing about
  -- real forms; that is a filter, not a deduplication.
  (select count(*) from answer_feedback_events e
     join applications a on a.id = e.application_id where a.is_test = false) as interventions,
  (select count(*) from answer_feedback_events e
     join applications a on a.id = e.application_id
    where a.is_test = false and e.proposed_answer is not null
      and lower(e.proposed_answer) is distinct from lower(e.human_answer))   as corrections_to_filled_fields,
  (select count(*) from answer_feedback_events e
     join applications a on a.id = e.application_id
    where a.is_test = false and e.proposed_answer is not null
      and lower(e.proposed_answer) = lower(e.human_answer))                  as confirmations_of_proposals,
  (select count(*) from answer_feedback_events e
     join applications a on a.id = e.application_id
    where a.is_test = false and e.reuse_scope <> 'NONE')                     as reusable_events,
  (select count(*) from answer_feedback_events e
     join applications a on a.id = e.application_id
    where a.is_test = false and e.reuse_scope = 'NONE')                      as one_off_events,
  (select count(*) from semantic_mappings where status = 'ACTIVE')           as semantic_mappings_learned,
  (select count(*) from answer_feedback_events e
     join applications a on a.id = e.application_id
    where a.is_test = false and e.classification = 'PROFILE_FACT'
      and e.resulting_profile_field is not null)                             as profile_facts_learned,
  (select count(*) from contextual_answers)                                  as contextual_answers_learned,
  (select count(*) from ats_adapter_rules)                                   as adapter_rules_learned,
  (select count(*) from feedback_conflicts where status = 'OPEN')            as open_conflicts,
  (select count(*) from feedback_conflicts)                                  as conflicts_all_time;

comment on view feedback_learning_metrics is
  'Automation and correction together. Field counts come from the latest applicable run per application, so a retry cannot inflate them; feedback events, mappings, facts, contextual answers, adapter rules and conflicts are counted individually from their own tables and are never deduplicated. The question it exists to answer is whether human intervention is falling WITHOUT corrections rising. Automation rate alone is not the goal and must never be read as one.';

-- The worker reads these. They are deliberately NOT granted to the
-- portal role: a view is not subject to the row level security on the
-- tables underneath it, so granting one to authenticated would hand out
-- a read path around the policies 0052 set. If the portal ever needs
-- these numbers, they go through a function that checks is_app_owner().
grant select on latest_fill_run_per_application to service_role;
grant select on feedback_learning_metrics to service_role;
