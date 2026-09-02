-- How many tries an evaluation took, and why the first one failed.
--
-- The blind evaluator now retries once when the model returns something
-- the schema refuses. Measured against 20 real postings, that retry is
-- doing a great deal of work: 10 of 17 usable evaluations came from the
-- second attempt rather than the first. A stored evaluation that does
-- not say which attempt produced it hides that entirely, and the first
-- question anyone will ask about a future model or a cheaper one is
-- whether it needed the retry as often.
--
-- Diagnostics only. Neither column is read by any decision, and neither
-- may become one: an evaluation that took two attempts is not worth less
-- than one that took a single attempt, it just cost more.
--
-- SAFE TO RE-RUN. The first attempt at this migration failed on the view
-- statement below and rolled back, leaving nothing behind. Every
-- statement here is idempotent anyway, so it does not matter whether the
-- columns already exist.

alter table resume_screening_evaluations
  add column if not exists attempts integer not null default 1;

alter table resume_screening_evaluations
  drop constraint if exists resume_screening_evaluations_attempts_check;
alter table resume_screening_evaluations
  add constraint resume_screening_evaluations_attempts_check
  check (attempts >= 1 and attempts <= 2);

alter table resume_screening_evaluations
  add column if not exists first_attempt_failure text;

comment on column resume_screening_evaluations.attempts is
  'How many calls produced this evaluation. Capped at 2 by the evaluator: one attempt and at most one retry, so a malformed model cannot be paid for indefinitely.';
comment on column resume_screening_evaluations.first_attempt_failure is
  'Why the first response was rejected, when there was a retry. Null when the first attempt was usable. Kept so the retry rate can be tracked per model rather than guessed.';

-- ============================================================
-- Retry frequency, appended to the existing cost view
-- ============================================================

-- The first version of this statement inserted the two new columns after
-- resumes_read, in the position where they read most naturally. Postgres
-- refused it:
--
--   cannot change name of view column "input_tokens" to "needed_a_retry"
--
-- CREATE OR REPLACE VIEW is not a redefinition. It keeps the existing
-- column list and compares position by position, so inserting a column
-- in the middle reads as renaming every column after it and changing
-- their types. Only appending is allowed.
--
-- The ten existing columns therefore keep their names, their order and
-- their expressions exactly, and the two diagnostics go on the end. That
-- is a smaller change than the original in every respect except where
-- the eye lands, and the alternative would have been to drop the view
-- and recreate it, which needlessly breaks anything selecting from it
-- for the sake of column order.
create or replace view screening_cost_by_model as
select model,
       evaluator_version,
       count(*)                                          as evaluations,
       count(distinct resume_id)                         as resumes_read,
       sum(input_tokens)                                 as input_tokens,
       sum(output_tokens)                                as output_tokens,
       round(sum(estimated_cost_cents), 2)               as estimated_cost_cents,
       round(avg(latency_ms))                            as avg_latency_ms,
       round(avg(score), 1)                              as avg_score,
       max(iteration)                                    as deepest_revision_pass,
       -- Appended by 0057. Existing columns above are untouched.
       count(*) filter (where attempts > 1)              as needed_a_retry,
       round(100.0 * count(*) filter (where attempts > 1)
             / nullif(count(*), 0), 1)                   as retry_rate_pct
  from resume_screening_evaluations
 group by model, evaluator_version;

comment on view screening_cost_by_model is
  'What each evaluator model costs, how often it has to be asked twice, and how it scores. Exists so a cheaper model can be compared against a stronger one on measured numbers rather than on impression.';

grant select on screening_cost_by_model to service_role;
