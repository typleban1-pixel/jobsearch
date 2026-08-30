-- Jobs, and the evidence trail that decides whether one is still open.
--
-- Phase 2 owns ingestion; this is the table it fills, defined now because
-- the company universe is meaningless without the thing it produces, and
-- because two design decisions here were made deliberately and should not
-- be re-litigated by whoever writes the fetcher.
--
-- DECISION 1: a job's status is derived from observations, never set by
-- a single fetch.
--
-- "Absent from the board once" is not closure. Boards fail, tokens
-- change, slugs move, a request times out. Treating one miss as a close
-- would delete real jobs and, worse, would mark jobs closed that the user
-- has already applied to. Status therefore advances through
-- POSSIBLY_CLOSED -> CLOSED_OR_REMOVED -> CONFIRMED_CLOSED on repeated
-- SUCCESSFUL checks, and a failed check is recorded as a failure rather
-- than as an absence.
--
-- DECISION 2: a removed posting is never a rejection.
--
-- If an application exists, nothing about the job is deleted when the
-- posting disappears: the description, the requirements and the
-- application are preserved, the disappearance is timestamped, and the
-- reason stays UNKNOWN unless it is actually known.

create type job_status as enum (
  'OPEN',
  'LIKELY_OPEN',
  'POSSIBLY_CLOSED',      -- missed one successful check
  'CLOSED_OR_REMOVED',    -- missed several; no longer surfaced
  'CONFIRMED_CLOSED',     -- canonical URL confirms it
  'UNKNOWN'
);

create type removal_reason as enum (
  'FILLED', 'EXPIRED', 'REQUISITION_CLOSED', 'NO_LONGER_ACCEPTING',
  'NOT_FOUND', 'REPLACED', 'REPOSTED', 'TEMPORARILY_UNAVAILABLE', 'UNKNOWN'
);

create type remote_status as enum ('ONSITE', 'HYBRID', 'REMOTE', 'UNCLEAR');

create table jobs (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,

  source ats_provider not null,
  source_job_id text not null,
  requisition_id text,

  title text not null,
  normalized_title text,
  -- Assigned by clustering rather than from a fixed taxonomy, because a
  -- fixed list of titles is exactly what this system is meant not to be.
  career_family text,

  description text,
  description_html text,

  location_raw text,
  city text,
  state text,
  country text,
  postal_code text,
  latitude double precision,
  longitude double precision,
  metro text,

  remote_status remote_status not null default 'UNCLEAR',
  hybrid_days_per_week integer check (hybrid_days_per_week between 0 and 5),

  -- Remote is a claim, not a fact, and the difference decides whether a
  -- job is reachable at all. A posting saying "Remote" while requiring
  -- residency in three states is not remote for this user.
  remote_eligible_states text[],
  remote_excluded_states text[],
  remote_timezone_requirement text,
  requires_occasional_onsite boolean,
  travel_requirement text,
  remote_eligibility_confidence evidence_confidence,

  employment_type text,
  seniority text,

  salary_min integer,
  salary_max integer,
  -- EMPLOYER_LISTED or ESTIMATED, never merged. An estimate that reads as
  -- a listed figure is how a system starts lying quietly.
  salary_source text,
  salary_confidence evidence_confidence,
  bonus_note text,
  equity_note text,
  other_compensation_note text,
  estimated_total_comp_min integer,
  estimated_total_comp_max integer,

  original_url text not null,
  canonical_url text,
  canonical_apply_url text,

  date_posted timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_verified_at timestamptz,

  status job_status not null default 'OPEN',
  consecutive_misses integer not null default 0,
  removed_detected_at timestamptz,
  removal_reason removal_reason,

  -- Skips re-analysis when nothing material changed. The cost model
  -- depends on this being honest, so it hashes the fields that would
  -- change an interpretation, not the whole payload.
  content_hash text,
  analyzed_at timestamptz,
  analysis_version integer not null default 0,

  listing_quality evidence_confidence,
  embedding vector(1536),

  created_at timestamptz not null default now(),
  unique (source, source_job_id)
);

comment on column jobs.consecutive_misses is
  'Incremented only when the board was fetched SUCCESSFULLY and this job was absent. A failed fetch never touches it, which is what keeps a board outage from closing every job at a company.';

comment on column jobs.status is
  'Derived, never assigned by a single observation. See the header of this migration.';

-- One row per job per successful check. This is what makes closure
-- evidence-based and what lets the timeline show when a posting actually
-- disappeared rather than when somebody noticed.
create table job_observations (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid not null references jobs(id) on delete cascade,
  run_id uuid references ingest_runs(id) on delete set null,
  observed_at timestamptz not null default now(),
  present boolean not null,
  content_hash text,
  changed boolean not null default false
);

create index job_observations_job_idx on job_observations(job_id, observed_at desc);

-- Requirements are extracted semantically because "required" and
-- "preferred" are written in prose and the distinction is often genuinely
-- ambiguous. The extraction is LLM work; everything downstream that acts
-- on it is deterministic, and ambiguity is preserved rather than resolved
-- by guessing.
create table job_requirements (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid not null references jobs(id) on delete cascade,
  requirement text not null,
  kind text not null,                  -- SKILL, CREDENTIAL, EDUCATION, AUTHORIZATION, LOCATION, EXPERIENCE_YEARS
  is_hard_requirement boolean,         -- null = genuinely ambiguous; not a default of false
  ambiguity_note text,
  extracted_confidence evidence_confidence not null default 'AI_INFERRED',
  years_required numeric,
  created_at timestamptz not null default now()
);

comment on column job_requirements.is_hard_requirement is
  'Three-valued on purpose. NULL means the posting did not make it clear, which is different from "not required" and must stay different: a NULL surfaces to the user, a false silently passes.';

-- Duplicates across boards, and near-neighbours that are not duplicates.
create type relation_kind as enum (
  'CONFIRMED_DUPLICATE', 'LIKELY_DUPLICATE', 'RELATED_POSITION',
  'SAME_REQUISITION', 'LIKELY_REPOST'
);

create table job_relations (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid not null references jobs(id) on delete cascade,
  related_job_id uuid not null references jobs(id) on delete cascade,
  relation relation_kind not null,
  basis text not null,
  similarity numeric,
  created_at timestamptz not null default now(),
  check (job_id <> related_job_id),
  unique (job_id, related_job_id, relation)
);

comment on table job_relations is
  'Growth Manager and Senior Growth Manager are RELATED_POSITION, not duplicates. Collapsing them would hide real jobs; treating a syndicated copy as new would apply twice to one requisition.';

-- Scores are a separate table because they are recomputed when the
-- PROFILE changes, without refetching or re-analyzing the listing.
create table job_scores (
  job_id uuid primary key references jobs(id) on delete cascade,
  fit_score integer check (fit_score between 0 and 100),
  fit_confidence evidence_confidence,
  opportunity_score integer check (opportunity_score between 0 and 100),
  generalist_fit integer check (generalist_fit between 0 and 100),
  specialist_risk integer check (specialist_risk between 0 and 100),
  interview_plausibility integer check (interview_plausibility between 0 and 100),
  application_effort text,
  hard_requirement_conflict boolean not null default false,
  rationale jsonb not null default '{}',
  scored_at timestamptz not null default now(),
  profile_version integer not null default 0
);

comment on column job_scores.profile_version is
  'Bumped whenever the truth profile changes. Rows behind the current version are restale and get rescored, which is how a skill moving from EXPOSURE to CAPABLE lifts jobs already in the corpus.';

create index jobs_status_idx on jobs(status, last_seen_at desc);
create index jobs_company_idx on jobs(company_id, status);
create index jobs_hash_idx on jobs(content_hash);
create index job_scores_rank_idx on job_scores(opportunity_score desc, fit_score desc);
