-- Which score a reason contributes to.
--
-- 0003 gave score_reasons a kind and points but no dimension, so which of
-- the four scores a row belonged to was implied by its kind
-- (SALARY_MATCH must be opportunity, SKILL_GAP must be fit). That implicit
-- mapping lives in code and drifts silently: adding a kind that plausibly
-- affects two dimensions would make reconciliation ambiguous with nothing
-- to catch it.
--
-- Naming the dimension makes the invariant checkable in SQL: for each
-- dimension, the sum of its reasons' points equals the stored score. A
-- reconciliation that requires a lookup table is not a reconciliation.
create type score_dimension as enum (
  'FIT',
  'OPPORTUNITY',
  'GENERALIST',
  'SPECIALIST',
  'UNCERTAINTY'
);

alter table score_reasons add column dimension score_dimension;

create index score_reasons_dimension_idx on score_reasons(score_id, dimension);

comment on column score_reasons.dimension is
  'The score this row contributes to. Sum of points per dimension must equal the corresponding column on job_scores; scripts/scoring-selftest.ts asserts it.';

-- Raw sums, not clamped. Clamping to 0-100 would break reconciliation,
-- and the scores are only ever compared to each other.
comment on column job_scores.fit_score is
  'Raw sum of FIT reason points. Unbounded and signed on purpose: it is a ranking quantity, not a percentage, and clamping would stop the reasons from reconciling to it.';
