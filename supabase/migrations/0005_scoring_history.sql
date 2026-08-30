-- Score history, market analytics and the LLM cost ledger.
--
-- One rule governs this file: a snapshot EMBEDS, it never REFERENCES.
--
-- The purpose of a snapshot is to answer "why did I apply to this in
-- November" in March. A snapshot built from foreign keys answers that
-- question with March's data, which is not an answer. So every snapshot
-- row carries frozen copies of the numbers, the weights and the reasons,
-- and is append only.

create type snapshot_trigger as enum (
  'FIRST_SCORED','APPROVED','APPLIED','MANUAL','WEIGHTS_CHANGED','PROFILE_CHANGED'
);

create table job_score_snapshots (
  id uuid primary key default uuid_generate_v4(),
  -- RESTRICT, not CASCADE. A job that justified a decision cannot be
  -- deleted out from under the record of that decision. Jobs are
  -- archived, never deleted.
  job_id uuid not null references jobs(id) on delete restrict,
  trigger snapshot_trigger not null,

  -- Frozen scores.
  fit_score numeric not null,
  opportunity_score numeric,
  generalist_score numeric,
  specialist_score numeric,
  uncertainty_score numeric,
  unknown_field_count integer not null default 0,
  unclear_requirement_count integer not null default 0,

  -- Frozen inputs. The weights object is copied, not pointed at, so a
  -- later edit or deletion of a weight set cannot rewrite history.
  profile_version integer not null references profile_versions(version) on delete restrict,
  -- Hash of the frozen truth set behind that version, so a
  -- reconstruction can be verified rather than assumed intact.
  profile_truth_hash text,
  weights_version integer not null,
  weights_snapshot jsonb not null,
  extraction_version integer not null,
  normalizer_version integer,
  features_snapshot jsonb not null,

  -- Frozen explanation, in the same shape score_reasons rows have.
  reasons_snapshot jsonb not null default '[]',

  -- Frozen job facts. job_versions is itself immutable, so pointing at a
  -- version is safe and avoids copying the description a second time;
  -- the scalar copies below let the snapshot be read without any join.
  job_version_id uuid references job_versions(id) on delete restrict,
  job_version_number integer,
  job_external_id text,
  job_url_at_time text,
  job_title_at_time text not null,
  seniority_at_time seniority_level,
  city_at_time text,
  state_at_time text,
  metro_at_time text,
  salary_min_at_time integer,
  salary_max_at_time integer,
  salary_was_estimated boolean,
  remote_policy_at_time remote_policy,
  remote_restriction_at_time text,

  -- Frozen company facts. Anything the Opportunity Score can read has to
  -- be frozen, or retuning a company's size silently changes why a past
  -- application looked worth making.
  company_id uuid references companies(id) on delete restrict,
  company_name_at_time text not null,
  company_size_bucket_at_time size_bucket,
  company_size_min_at_time integer,
  company_size_max_at_time integer,
  company_industries_at_time text[],
  company_open_job_count_at_time integer,

  created_at timestamptz not null default now()
);

comment on table job_score_snapshots is
  'Append only and immutable. Never updated, never deleted while its job exists. Everything needed to explain a past decision is inside the row.';

comment on column job_score_snapshots.weights_snapshot is
  'A copy of the weights, deliberately duplicating scoring_weights.weights. Denormalized on purpose: a snapshot that referenced the weight set would be silently rewritten the next time weights were tuned.';

alter table applications
  add constraint applications_decision_snapshot_fk
  foreign key (decision_snapshot_id) references job_score_snapshots(id) on delete restrict;

-- Weight changes as an audit trail, so a shift in what the system
-- recommends is traceable to a decision rather than appearing as drift.
create table scoring_weight_changes (
  id uuid primary key default uuid_generate_v4(),
  from_version integer,
  to_version integer not null,
  reason text,
  jobs_rescored integer,
  rank_shift_summary jsonb,
  changed_at timestamptz not null default now()
);

-- ============================================================
-- Market analytics
-- ============================================================

-- Daily rollups, because the interesting questions are about change over
-- time and cannot be reconstructed from a table that only holds today.
create table job_market_daily (
  snapshot_date date not null,
  dimension text not null,
  dimension_value text not null,

  jobs_open integer not null default 0,
  jobs_new integer not null default 0,
  jobs_closed integer not null default 0,
  companies_hiring integer not null default 0,

  median_salary_min integer,
  median_salary_max integer,
  salary_disclosed_count integer not null default 0,
  remote_count integer not null default 0,
  hybrid_count integer not null default 0,
  onsite_count integer not null default 0,

  median_days_open numeric,

  -- Sample size travels with every number, and the confidence tier is
  -- stored rather than computed at read time so a chart cannot lose it.
  sample_size integer not null,
  confidence_tier text not null,

  created_at timestamptz not null default now(),
  primary key (snapshot_date, dimension, dimension_value),

  -- Under 10, only raw counts may be shown: 10 to 19 very low confidence,
  -- 20 to 49 provisional, 50+ stronger.
  constraint confidence_tier_matches_sample check (
    confidence_tier = case
      when sample_size < 10 then 'RAW_COUNT_ONLY'
      when sample_size < 20 then 'VERY_LOW'
      when sample_size < 50 then 'PROVISIONAL'
      else 'STRONGER'
    end
  )
);

comment on constraint confidence_tier_matches_sample on job_market_daily is
  'A trend built from 6 postings is not a trend. The tier is enforced rather than trusted, so no display path can present a thin sample as a finding.';

-- Skill demand over time, kept separate from job_market_daily because
-- its grain is a term rather than a market dimension.
create table skill_demand_daily (
  snapshot_date date not null,
  normalized_term text not null,
  mention_count integer not null default 0,
  hard_requirement_count integer not null default 0,
  preferred_count integer not null default 0,
  unclear_count integer not null default 0,
  jobs_considered integer not null,
  sample_size integer not null,
  confidence_tier text not null,
  primary key (snapshot_date, normalized_term)
);

-- Gaps as measured, not as guessed. A skill only counts as a gap when a
-- real posting named it and the profile had no VERIFIED evidence.
create table skill_gap_observations (
  id uuid primary key default uuid_generate_v4(),
  snapshot_date date not null,
  normalized_term text not null,
  skill_id uuid references skills(id),
  jobs_requiring integer not null,
  jobs_requiring_as_hard integer not null,
  profile_has_evidence boolean not null,
  profile_level experience_level,
  created_at timestamptz not null default now(),
  unique (snapshot_date, normalized_term)
);

-- ============================================================
-- Cost and LLM ledger
-- ============================================================

-- The funnel is cheap-first by design: fetch, hash, deterministic
-- filter, then and only then a model. This table is how that stays true
-- instead of merely intended.
create table llm_calls (
  id uuid primary key default uuid_generate_v4(),
  tier text not null,
  purpose text not null,
  subject_type text,
  subject_id uuid,
  input_tokens integer,
  output_tokens integer,
  estimated_cost_cents numeric,
  duration_ms integer,
  cache_hit boolean not null default false,
  succeeded boolean not null default true,
  error text,
  ingest_run_id uuid references ingest_runs(id) on delete restrict,
  called_at timestamptz not null default now()
);

comment on table llm_calls is
  'Records tier and purpose only. No prompt text and no response text, because prompts carry profile data and this table is not classified to hold it.';

create table cost_daily (
  snapshot_date date primary key,
  jobs_fetched integer not null default 0,
  jobs_hash_unchanged integer not null default 0,
  jobs_filtered_deterministically integer not null default 0,
  jobs_sent_to_llm integer not null default 0,
  llm_calls integer not null default 0,
  total_cost_cents numeric not null default 0,
  cost_per_scored_job_cents numeric
);

comment on table cost_daily is
  'jobs_hash_unchanged and jobs_filtered_deterministically are the numbers to watch. If they fall, the funnel has stopped working and cost is about to scale with the company universe.';

create index snapshots_job_idx on job_score_snapshots(job_id, created_at desc);
create index snapshots_trigger_idx on job_score_snapshots(trigger, created_at desc);
create index market_daily_dim_idx on job_market_daily(dimension, dimension_value, snapshot_date desc);
create index skill_demand_term_idx on skill_demand_daily(normalized_term, snapshot_date desc);
create index llm_calls_day_idx on llm_calls(called_at desc, purpose);
