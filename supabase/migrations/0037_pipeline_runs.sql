-- A record of every scheduled run.
--
-- launchd writes to a log file, which answers "what happened last night"
-- and nothing else. This answers "is the pipeline healthy", "when did
-- discovery last resolve anything", and "how much extraction is waiting",
-- which are the questions that actually come up.
--
-- Deliberately not append-only-guarded: a run row is operational
-- telemetry, not a claim about the truth profile.

create table pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                       -- 'daily' | 'weekly' | manual label
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  succeeded boolean,
  /** Per-step outcome, so a partial failure names the step that failed. */
  steps jsonb not null default '[]',
  companies_checked integer,
  companies_resolved integer,
  jobs_added integer,
  jobs_closed integer,
  eligible_before integer,
  eligible_after integer,
  /** Jobs waiting on approval, and what they would cost. */
  pending_extraction integer,
  pending_extraction_cost_cents numeric,
  error text
);

create index pipeline_runs_started_idx on pipeline_runs(started_at desc);

comment on table pipeline_runs is
  'One row per scheduled pipeline run. The free, deterministic steps only: model extraction is never triggered from here and requires explicit approval.';
comment on column pipeline_runs.pending_extraction is
  'ELIGIBLE jobs with no requirements yet. They accumulate here rather than being extracted automatically, because extraction costs money.';
