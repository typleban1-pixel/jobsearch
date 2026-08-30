-- The company universe.
--
-- This exists because of a finding that reshapes the whole system: there
-- is no global job search API. Greenhouse, Lever and Ashby all publish
-- complete, canonical, free job lists PER COMPANY, and none of them
-- offers a cross-company search. Verified 29 Aug 2026:
--
--   boards-api.greenhouse.io/v1/boards/stripe/jobs      574 jobs
--   api.lever.co/v0/postings/spotify?mode=json           89 jobs
--   api.ashbyhq.com/posting-api/job-board/ramp          139 jobs
--   any global search endpoint                          404
--
-- So coverage is not a function of how cleverly we search. It is a
-- function of how many companies we know about. This table is therefore
-- the real input to the entire product, and it is built to grow rather
-- than to be pasted in once.

create type ats_provider as enum (
  'GREENHOUSE', 'LEVER', 'ASHBY', 'SMARTRECRUITERS', 'ICIMS',
  'JOBVITE', 'WORKDAY', 'OTHER', 'UNKNOWN'
);

create type company_status as enum (
  'ACTIVE',        -- checked on the normal cadence
  'CANDIDATE',     -- discovered, board token not yet confirmed
  'UNREACHABLE',   -- token wrong or board gone; needs attention
  'PAUSED',        -- deliberately not checked
  'EXCLUDED'       -- never check: staffing agency, known bad fit, etc.
);

create type discovery_method as enum (
  'MANUAL', 'ATS_DIRECTORY', 'JOB_SOURCE', 'RELATED_COMPANY',
  'SEED_LIST', 'SEARCH', 'OTHER'
);

create table companies (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  domain text,

  ats_provider ats_provider not null default 'UNKNOWN',
  -- The board slug, which is what every one of these APIs is keyed on.
  -- Nullable because a company can be known before its board is found.
  ats_token text,

  status company_status not null default 'CANDIDATE',

  -- Ordering, not filtering. Everything in ACTIVE gets checked; this
  -- decides what gets checked first when a run is time or budget bound,
  -- and what gets analyzed first downstream.
  priority_score integer not null default 50 check (priority_score between 0 and 100),
  priority_reason text,

  -- Descriptive, never a gate. The instruction is explicit that industry
  -- should shape priority and must not restrict discovery, because the
  -- whole point is finding roles that would not have been searched for.
  industries text[] not null default '{}',
  employee_count_estimate integer,
  hq_city text,
  hq_state text,
  hq_country text,

  -- Set independently of HQ. A company headquartered anywhere may hire
  -- into Chicagoland or hire remote, and either makes it worth checking.
  has_chicagoland_presence boolean,
  hires_remote_us boolean,

  discovery_method discovery_method not null default 'MANUAL',
  discovery_source text,
  discovered_at timestamptz not null default now(),

  last_checked_at timestamptz,
  last_successful_check_at timestamptz,
  consecutive_check_failures integer not null default 0,
  last_job_count integer,

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One row per board. Two companies may share a name; a board token is
  -- the thing that is actually unique.
  unique (ats_provider, ats_token)
);

comment on column companies.priority_score is
  'Ordering only. A low score delays a company, it never removes it: the system is explicitly meant to surface employers that would not have been searched for.';

comment on column companies.status is
  'CANDIDATE means discovered but unproven. A candidate is promoted to ACTIVE only by a successful board fetch, so a wrong guess at a token never silently produces an empty company that looks checked.';

-- Where companies come from, so discovery can be run, audited and
-- improved rather than being a one-off import.
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

-- Candidate board tokens awaiting confirmation. Guessing a slug is cheap
-- and usually wrong, so guesses live here and are proven by a fetch
-- before they are allowed to become a company row.
create table company_token_candidates (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id) on delete cascade,
  company_name text not null,
  ats_provider ats_provider not null,
  candidate_token text not null,
  source text,
  tested_at timestamptz,
  test_result text,
  job_count integer,
  confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (ats_provider, candidate_token)
);

-- Every ingest run, so silent failure is visible. A discovery system that
-- quietly stops finding jobs looks identical to a quiet job market.
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
  run_id uuid not null references ingest_runs(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  ok boolean not null,
  job_count integer,
  duration_ms integer,
  error text,
  primary key (run_id, company_id)
);

create index companies_check_order_idx
  on companies(status, priority_score desc, last_checked_at nulls first);
create index companies_domain_idx on companies(domain);
