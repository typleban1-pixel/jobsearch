-- Jobs, requirements, features and scores.
--
-- Two ideas run through this file.
--
-- First: what a source SAID and what the system BELIEVES are different
-- things. Sources disagree constantly about salary, location and remote
-- policy. Resolved columns live on the job; every observation is kept in
-- source_observations and nothing is overwritten.
--
-- Second: SCORING PURITY. Every score is a deterministic function of
-- versioned profile data, versioned job data, stored extracted features
-- and versioned weights. An LLM may WRITE a feature. It may never be a
-- term in the score. Same inputs, same score, forever, offline.

create type remote_policy as enum (
  'FULLY_REMOTE','REMOTE_WITH_TRAVEL','HYBRID','ONSITE','UNCLEAR'
);

create type employment_arrangement as enum (
  'FULL_TIME','PART_TIME','CONTRACT','CONTRACT_TO_HIRE','INTERNSHIP','TEMPORARY','UNKNOWN'
);

create type seniority_level as enum (
  'INTERN','ENTRY','ASSOCIATE','MID','SENIOR','LEAD','MANAGER',
  'DIRECTOR','EXECUTIVE','UNKNOWN'
);

-- Staged, because "the URL 404s" is not the same as "the company said
-- the role is filled", and treating them alike either discards live jobs
-- or keeps dead ones.
create type job_status as enum (
  'OPEN','POSSIBLY_CLOSED','CLOSED_OR_REMOVED','CONFIRMED_CLOSED','ARCHIVED'
);

create table jobs (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,

  external_id text not null,
  source text not null,
  url text,
  apply_url text,

  title text not null,
  normalized_title text,
  department text,

  -- RESOLVED values. Provenance for each lives in source_observations.
  location_raw text,
  city text, state text, country text, metro text,
  remote_policy remote_policy not null default 'UNCLEAR',
  remote_geographic_restriction text,
  onsite_days_per_week integer check (onsite_days_per_week between 0 and 5),

  employment_arrangement employment_arrangement not null default 'UNKNOWN',
  seniority seniority_level not null default 'UNKNOWN',

  salary_min integer,
  salary_max integer,
  salary_currency text default 'USD',
  salary_period text,
  salary_is_estimated boolean not null default false,
  salary_source text,

  -- Career-quality signals, deliberately limited to the four that are
  -- reliably stated in postings. Anything subtler (culture, burnout,
  -- growth) is not extractable from a job description without inventing
  -- it, so it is not a column here.
  is_individual_contributor boolean,
  manages_people boolean,
  travel_requirement_pct integer check (travel_requirement_pct between 0 and 100),
  has_quota_or_commission boolean,
  mentions_equity boolean,

  posted_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_seen_open_at timestamptz,

  status job_status not null default 'OPEN',
  status_changed_at timestamptz,
  consecutive_missing_checks integer not null default 0,
  closed_detection_reason text,

  -- Change detection without re-parsing or re-calling an LLM. A job whose
  -- content_hash is unchanged costs nothing on a daily run.
  content_hash text,
  description_hash text,

  -- Set when a run finds requirements, seniority etc. Kept apart from
  -- content_hash so a re-extraction can be forced without faking a
  -- content change.
  extracted_at timestamptz,
  extraction_version integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (source, external_id),
  constraint salary_range_sane check (salary_max is null or salary_min is null or salary_max >= salary_min)
);

comment on column jobs.status is
  'Staged closed detection. Missing from a board is POSSIBLY_CLOSED. Missing repeatedly, or a 404, is CLOSED_OR_REMOVED. Only an explicit signal reaches CONFIRMED_CLOSED. A job is never deleted; it is archived.';

comment on column jobs.remote_policy is
  'UNCLEAR is a real value and never silently becomes FULLY_REMOTE. A posting labelled Remote that requires residence in another state is not remote for this profile, which is what remote_geographic_restriction exists to capture.';

comment on column jobs.salary_is_estimated is
  'True when the number came from an aggregator estimate rather than the employer. Estimated salary must never satisfy the hard salary floor.';

-- Full description text lives apart from the hot row. Descriptions are
-- large and rarely needed, and separating them keeps every list, scoring
-- pass and daily diff off multi-kilobyte columns.
create table job_descriptions (
  job_id uuid primary key references jobs(id) on delete cascade,
  description_text text,
  description_html text,
  fetched_at timestamptz not null default now(),
  content_hash text
);

-- ============================================================
-- Source observations
-- ============================================================

-- One consolidated table rather than per-entity observation tables.
--
-- Tradeoff, taken deliberately: polymorphic subject_id cannot carry a
-- foreign key, so referential integrity for these rows is enforced in
-- code and by the cleanup path, not by Postgres. Accepted because every
-- entity here (job, company, requirement) needs identical "who said
-- what, when, and did we believe them" behaviour, and three near-copies
-- would drift apart. A partial index per subject_type recovers the query
-- performance a dedicated table would have given.
create type observation_subject as enum ('JOB','COMPANY','JOB_REQUIREMENT');

create table source_observations (
  id uuid primary key default uuid_generate_v4(),
  subject_type observation_subject not null,
  subject_id uuid not null,

  field_name text not null,
  observed_value text,
  observed_numeric numeric,
  observed_json jsonb,

  source text not null,
  source_url text,
  confidence evidence_confidence not null default 'MEDIUM',
  is_estimate boolean not null default false,

  observed_at timestamptz not null default now(),

  -- Whether this observation is the one currently reflected in the
  -- entity's resolved columns. Conflicting observations stay, marked
  -- false; nothing is deleted to make the picture tidy.
  is_resolved_value boolean not null default false,
  superseded_at timestamptz,
  resolution_note text
);

comment on table source_observations is
  'Append only. Preserves what each source said. The entity''s resolved columns are the current operational answer; this is the record of disagreement behind it. Never delete an observation because it conflicts.';

create index obs_job_idx on source_observations(subject_id, field_name, observed_at desc)
  where subject_type = 'JOB';
create index obs_company_idx on source_observations(subject_id, field_name, observed_at desc)
  where subject_type = 'COMPANY';
create index obs_requirement_idx on source_observations(subject_id, field_name, observed_at desc)
  where subject_type = 'JOB_REQUIREMENT';

-- ============================================================
-- Requirements
-- ============================================================

create type requirement_kind as enum (
  'SKILL','TOOL','CREDENTIAL','EDUCATION','EXPERIENCE_YEARS',
  'DOMAIN','LEGAL','LOGISTICAL','OTHER'
);

-- Three valued, never boolean. "Preferred" is not "required", and the
-- system frequently cannot tell which a sentence means. Collapsing
-- UNCLEAR into either direction produces false rejections or false
-- matches, both of which are worse than saying so.
create type hard_requirement_state as enum ('HARD','PREFERRED','UNCLEAR');

create table job_requirements (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid not null references jobs(id) on delete cascade,

  kind requirement_kind not null,
  raw_text text not null,
  normalized_term text,
  skill_id uuid references skills(id),

  is_hard_requirement hard_requirement_state not null default 'UNCLEAR',
  hard_requirement_reason text,

  minimum_years numeric,
  extraction_confidence numeric check (extraction_confidence between 0 and 1),
  extracted_by text,
  extraction_version integer,
  created_at timestamptz not null default now()
);

comment on column job_requirements.is_hard_requirement is
  'Extracted semantically by an LLM. Compared deterministically at scoring time. The LLM decides what the sentence means; it never decides whether the candidate passes.';

-- ============================================================
-- Deterministic scoring
-- ============================================================

-- Weights are versioned rows, so a score can always be reproduced from
-- the weight set that produced it.
create table scoring_weights (
  id uuid primary key default uuid_generate_v4(),
  version integer not null unique,
  label text not null,
  weights jsonb not null,
  is_active boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

create unique index scoring_weights_one_active on scoring_weights(is_active) where is_active;

-- The complete deterministic input to scoring, computed once and cached.
-- Rescoring under new weights reads this table only: no refetch, no LLM
-- call, no network.
create table job_features (
  job_id uuid primary key references jobs(id) on delete cascade,
  extraction_version integer not null,
  features jsonb not null,
  computed_at timestamptz not null default now()
);

create table job_scores (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid not null references jobs(id) on delete cascade,

  fit_score numeric not null,
  opportunity_score numeric,
  generalist_score numeric,
  specialist_score numeric,

  -- Reproducibility triple. A score is only comparable to another score
  -- computed from the same three.
  profile_version integer not null,
  weights_version integer not null references scoring_weights(version),
  extraction_version integer not null,

  -- UNCLEAR requirements and unknown fields, surfaced rather than
  -- averaged away. A high score with high uncertainty is a different
  -- recommendation from a high score with low uncertainty.
  uncertainty_score numeric,
  unknown_field_count integer not null default 0,
  unclear_requirement_count integer not null default 0,

  is_current boolean not null default true,
  computed_at timestamptz not null default now(),
  unique (job_id, profile_version, weights_version, extraction_version)
);

create unique index job_scores_one_current on job_scores(job_id) where is_current;

comment on table job_scores is
  'Deterministic function of job_features, profile_version and scoring_weights. Never depends on a live LLM call. Recomputable offline for every job at once.';

-- Replaces a free-form rationale blob. Typed rows are filterable
-- ("show every job rejected only on a years-of-experience line") and,
-- being generated by the scorer rather than written by a model, cannot
-- drift from the arithmetic they explain.
create type score_reason_kind as enum (
  'SKILL_MATCH','SKILL_GAP','TRANSFERABLE_SKILL','TITLE_MATCH','TITLE_MISMATCH',
  'SENIORITY_MATCH','SENIORITY_MISMATCH','LOCATION_MATCH','LOCATION_MISMATCH',
  'REMOTE_ELIGIBLE','REMOTE_INELIGIBLE','SALARY_MATCH','SALARY_BELOW_FLOOR',
  'SALARY_UNKNOWN','HARD_REQUIREMENT_MET','HARD_REQUIREMENT_MISSING',
  'HARD_REQUIREMENT_UNCLEAR','PREFERENCE_MATCH','PREFERENCE_CONFLICT',
  'COMPANY_SIGNAL','GENERALIST_SIGNAL','SPECIALIST_SIGNAL','UNKNOWN_DATA'
);

create table score_reasons (
  id uuid primary key default uuid_generate_v4(),
  score_id uuid not null references job_scores(id) on delete cascade,
  kind score_reason_kind not null,
  subject text,
  detail text,
  points numeric,
  requirement_id uuid references job_requirements(id) on delete set null,
  skill_id uuid references skills(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table score_reasons is
  'Emitted by the deterministic scorer, one row per term. The sum of points reconciles to the score. An LLM may later phrase these for reading; it never produces them.';

create table job_relations (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid not null references jobs(id) on delete cascade,
  related_job_id uuid not null references jobs(id) on delete cascade,
  relation text not null,
  confidence numeric,
  created_at timestamptz not null default now(),
  unique (job_id, related_job_id, relation),
  constraint no_self_relation check (job_id <> related_job_id)
);

create index jobs_company_status_idx on jobs(company_id, status);
create index jobs_status_seen_idx on jobs(status, last_seen_at desc);
create index jobs_open_posted_idx on jobs(posted_at desc) where status = 'OPEN';
create index jobs_content_hash_idx on jobs(content_hash);
create index jobs_remote_idx on jobs(remote_policy) where status = 'OPEN';
create index jobs_metro_idx on jobs(metro) where status = 'OPEN';
create index job_requirements_job_idx on job_requirements(job_id, is_hard_requirement);
create index job_requirements_term_idx on job_requirements(normalized_term);
create index job_scores_rank_idx on job_scores(fit_score desc) where is_current;
create index score_reasons_score_idx on score_reasons(score_id, kind);

-- Close the forward references left open in 0001, now that the target
-- tables exist.
-- RESTRICT throughout: question_occurrences is append-only history, so a
-- parent deletion would arrive as an UPDATE on a frozen row and fail with
-- a confusing message. Better that the deletion itself is refused.
alter table question_occurrences
  add constraint question_occurrences_company_fk
  foreign key (company_id) references companies(id) on delete restrict;

alter table question_occurrences
  add constraint question_occurrences_job_fk
  foreign key (job_id) references jobs(id) on delete restrict;

alter table resumes
  add constraint resumes_job_fk
  foreign key (tailored_for_job_id) references jobs(id) on delete set null;
