-- The company universe.
--
-- There is no global job search API. Greenhouse, Lever and Ashby publish
-- complete canonical job lists PER COMPANY and none offers cross-company
-- search. Verified 29 Aug 2026: Stripe 574 jobs, Spotify 89, Ramp 139,
-- every global endpoint 404.
--
-- So coverage is not a function of searching well. It is a function of
-- how many companies are known, which makes this table the real input to
-- the product and the reason it is built to grow rather than be pasted in.

create type ats_provider as enum (
  'GREENHOUSE','LEVER','ASHBY','SMARTRECRUITERS','ICIMS',
  'JOBVITE','WORKDAY','OTHER','UNKNOWN'
);

-- Lifecycle. Separates ATS DETECTION from board VERIFICATION, because
-- knowing a company uses Greenhouse and knowing their slug are different
-- facts and the second is the one that can be wrong.
create type company_lifecycle as enum (
  'DISCOVERED',
  'ATS_DETECTION_PENDING',
  'ATS_DETECTED',
  'BOARD_VERIFICATION_PENDING',
  'VERIFIED',
  'ACTIVE',
  'REJECTED',
  'INACTIVE'
);

-- A separate axis from lifecycle on purpose: a watchlisted company can
-- simultaneously be unreachable, and collapsing the two would lose that.
create type watchlist_state as enum (
  'NORMAL','HIGH_PRIORITY','WATCHLIST','MUTED','EXCLUDED'
);

create type discovery_method as enum (
  'MANUAL','ATS_DIRECTORY','JOB_SOURCE','RELATED_COMPANY',
  'SEED_LIST','VC_PORTFOLIO','PUBLIC_DIRECTORY','SEARCH','OTHER'
);

create type size_bucket as enum (
  'B_1_10','B_11_20','B_21_50','B_51_100','B_101_250','B_251_500',
  'B_501_1000','B_1001_5000','B_5001_10000','B_10000_PLUS','UNKNOWN'
);

create table companies (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  domain text,

  ats_provider ats_provider not null default 'UNKNOWN',
  ats_token text,
  ats_detection_method text,

  lifecycle company_lifecycle not null default 'DISCOVERED',
  watchlist watchlist_state not null default 'NORMAL',

  -- Ordering, never filtering. A low score delays a company; it never
  -- removes it. The system exists partly to surface employers that would
  -- not have been searched for.
  priority_score integer not null default 50 check (priority_score between 0 and 100),
  priority_reason text,

  industries text[] not null default '{}',

  -- RESOLVED company size. The full disagreement lives in
  -- source_observations; these columns are the current best answer kept
  -- for fast queries and job cards. Unknown stays unknown: there is no
  -- default bucket and no guess.
  current_size_min integer,
  current_size_max integer,
  current_size_bucket size_bucket not null default 'UNKNOWN',
  current_size_source text,
  current_size_is_estimate boolean,
  current_size_confidence evidence_confidence,
  current_size_verified_at timestamptz,

  -- Hiring activity is NOT a size proxy and is stored separately. It is
  -- measured directly from the board every day, which makes it the more
  -- reliable of the two: a 40-person company with 30 open roles is a
  -- different prospect from a 3,000-person company with four.
  open_job_count integer,
  open_job_count_at timestamptz,
  jobs_posted_last_30d integer,
  hiring_velocity numeric,

  hq_city text, hq_state text, hq_country text,
  has_chicagoland_presence boolean,
  hires_remote_us boolean,

  discovery_method discovery_method not null default 'MANUAL',
  discovery_source text,
  discovery_source_url text,
  discovered_at timestamptz not null default now(),

  verification_confidence evidence_confidence,
  verified_at timestamptz,
  last_checked_at timestamptz,
  last_successful_check_at timestamptz,
  last_failed_check_at timestamptz,
  consecutive_check_failures integer not null default 0,

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (ats_provider, ats_token),
  -- A company cannot be ACTIVE without a proven board. Stops a guessed
  -- slug from becoming a company that looks checked and returns nothing.
  constraint active_companies_are_verified
    check (lifecycle <> 'ACTIVE' or (ats_token is not null and verified_at is not null))
);

comment on column companies.current_size_bucket is
  'Resolved value with provenance. UNKNOWN is a real answer and is displayed as UNKNOWN. Weak size guesses must not feed Opportunity Score strongly.';

comment on column companies.hiring_velocity is
  'Derived from observed board counts over time. Distinct from size and more trustworthy, because it is measured rather than estimated.';

create table company_sources (
  id uuid primary key default uuid_generate_v4(),
  label text not null,
  method discovery_method not null,
  config jsonb not null default '{}',
  enabled boolean not null default true,
  last_run_at timestamptz,
  companies_found integer not null default 0,
  companies_added integer not null default 0,
  notes text,
  created_at timestamptz not null default now()
);

-- Guessing a board slug is cheap and usually wrong, so guesses live here
-- and are proven by an actual fetch before becoming a company.
create table company_token_candidates (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id) on delete cascade,
  company_name text not null,
  ats_provider ats_provider not null,
  candidate_token text not null,
  source text,
  source_url text,
  tested_at timestamptz,
  test_result text,
  job_count integer,
  confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (ats_provider, candidate_token)
);

create table ingest_runs (
  id uuid primary key default uuid_generate_v4(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'RUNNING',
  companies_checked integer not null default 0,
  companies_failed integer not null default 0,
  jobs_seen integer not null default 0,
  jobs_new integer not null default 0,
  jobs_changed integer not null default 0,
  jobs_missing integer not null default 0,
  llm_calls integer not null default 0,
  estimated_cost_cents integer not null default 0,
  error_summary text
);

create table ingest_run_companies (
  run_id uuid not null references ingest_runs(id) on delete restrict,
  company_id uuid not null references companies(id) on delete restrict,
  ok boolean not null,
  job_count integer,
  duration_ms integer,
  error text,
  primary key (run_id, company_id)
);

-- Coverage health. Aggregates over today's rows can be computed anytime;
-- the point of storing them daily is that blind spots over time cannot be
-- reconstructed later.
create table coverage_snapshots (
  snapshot_date date primary key,
  companies_total integer not null,
  companies_active integer not null,
  companies_verified integer not null,
  companies_unreachable integer not null,
  companies_without_ats integer not null,
  boards_greenhouse integer not null default 0,
  boards_lever integer not null default 0,
  boards_ashby integer not null default 0,
  boards_other integer not null default 0,
  live_jobs integer not null,
  by_metro jsonb not null default '{}',
  by_industry jsonb not null default '{}',
  by_size_bucket jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index companies_check_order_idx
  on companies(lifecycle, priority_score desc, last_checked_at nulls first);
create index companies_watchlist_idx on companies(watchlist) where watchlist <> 'NORMAL';
create index companies_domain_idx on companies(domain);
create index companies_size_idx on companies(current_size_bucket);
