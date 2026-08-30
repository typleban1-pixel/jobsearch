-- The Master Truth Profile.
--
-- This schema exists to make one rule enforceable rather than merely
-- stated: REFRAME EVIDENCE, NEVER CREATE EVIDENCE. Three structural
-- choices carry that rule.
--
-- 1. Verified and inferred facts live in different rows with a status
--    column, never in the same row with a flag that a later UPDATE can
--    quietly flip. An AI suggestion is a suggestion until a human moves
--    it, and moving it is an explicit state transition.
-- 2. Capability and appetite are separate columns. Being good at video
--    editing and wanting a video editing job are different facts, and
--    collapsing them is how a system starts recommending the career you
--    are trying to leave.
-- 3. Every substantive claim can name its evidence. Not as prose in a
--    notes field, as a foreign key.

create extension if not exists "uuid-ossp";
create extension if not exists vector;

-- ============================================================
-- Enums
-- ============================================================

-- Deliberately five levels, not a 1-10 scale. The distinction that
-- matters is not fine-grained skill, it is the difference between
-- "I have done this repeatedly for money" and "I have touched it".
create type experience_level as enum (
  'EXPERIENCED',  -- repeatedly, professionally or in substantial real work
  'CAPABLE',      -- performed successfully; not claiming specialization
  'EXPOSURE',     -- used or encountered, limited depth
  'LEARNING',     -- actively developing
  'UNKNOWN'       -- encountered by the system, competency not established
);

-- Appetite, not ability. AVOID_SPECIALIST is the important one: the skill
-- still strengthens candidacy for other roles, it just must not become
-- the thing the system recommends a career in.
create type skill_interest as enum (
  'ACTIVELY_SEEK', 'POSITIVE', 'NEUTRAL', 'AVOID_SPECIALIST', 'DO_NOT_SEEK'
);

create type career_importance as enum (
  'CORE',        -- drives discovery
  'SUPPORTING',  -- strengthens matching
  'SECONDARY',   -- supporting evidence only
  'BACKGROUND'   -- breadth; rarely triggers discovery alone
);

create type evidence_confidence as enum (
  'HIGH', 'MEDIUM', 'LOW', 'SELF_REPORTED', 'AI_INFERRED'
);

-- Where a fact used in an application came from. Every answer the system
-- ever gives must be able to answer "where did this come from".
create type provenance_kind as enum (
  'PROFILE', 'EMPLOYMENT_RECORD', 'PROJECT', 'SKILL_RECORD',
  'VERIFIED_ANSWER', 'USER_RESPONSE', 'CALCULATED',
  'AI_DRAFT_FROM_VERIFIED_EVIDENCE'
);

-- A skill's lifecycle. AI may only ever create rows in 'SUGGESTED'.
create type record_status as enum ('SUGGESTED', 'VERIFIED', 'REJECTED', 'DISABLED');

create type employment_type as enum (
  'FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP', 'FREELANCE', 'SELF_EMPLOYED'
);

create type project_kind as enum (
  'PERSONAL_PROJECT', 'STARTUP', 'BUSINESS', 'FREELANCE',
  'TECHNICAL_PROJECT', 'PROTOTYPE', 'PORTFOLIO_PROJECT'
);

-- ============================================================
-- Identity and preferences
-- ============================================================

-- Singleton. The constraint is the point: this system is for one person,
-- and a second profile row would mean an application could be assembled
-- from two different people's facts.
create table profile (
  id uuid primary key default uuid_generate_v4(),
  singleton boolean not null default true unique check (singleton),

  legal_first_name text not null,
  legal_last_name text not null,
  preferred_name text,

  email_job_search text not null,
  phone text,
  address_line text,
  city text,
  state text,
  postal_code text,
  country text not null default 'US',
  latitude double precision,
  longitude double precision,

  linkedin_url text,
  portfolio_url text,
  website_urls text[] not null default '{}',

  -- Answered once, reused everywhere, never inferred.
  work_authorization text,
  requires_sponsorship boolean,
  willing_to_relocate boolean not null default false,
  travel_tolerance text,

  salary_target_min integer,
  salary_target_ideal integer,
  salary_hard_floor integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column profile.salary_hard_floor is
  'A deal breaker, not a preference. Jobs below this are excluded before ranking rather than ranked low.';

-- Location rules live here rather than in code, so changing what counts
-- as an acceptable commute is an edit rather than a deploy.
create type location_stance as enum ('PREFERRED', 'ACCEPTABLE', 'NEUTRAL', 'AVOID', 'EXCLUDE');

create table location_preferences (
  id uuid primary key default uuid_generate_v4(),
  label text not null,
  stance location_stance not null,

  -- Any of these may be null; a rule matches on whichever are set.
  country text,
  state text,
  metro text,
  city text,
  postal_code text,
  center_latitude double precision,
  center_longitude double precision,
  radius_miles integer,
  max_commute_minutes integer,

  -- Onsite frequency this rule tolerates. Null means no constraint.
  max_onsite_days_per_week integer check (max_onsite_days_per_week between 0 and 5),
  notes text,
  created_at timestamptz not null default now()
);

comment on table location_preferences is
  'Chicagoland is expressed as rows here (metro, suburbs, radius), never as a string match on "Chicago". A job in Naperville is Chicagoland; a job labelled "Chicago" that is actually onsite in another state is not.';

-- Work I want and work I refuse, weighted. Kept as rows rather than an
-- enum because this list is discovered over time and is personal.
create type appetite as enum ('WANT', 'AVOID');

create table work_preferences (
  id uuid primary key default uuid_generate_v4(),
  kind appetite not null,
  statement text not null,
  weight integer not null default 5 check (weight between 1 and 10),
  notes text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Evidence: the spine
-- ============================================================

-- One table, referenced by everything that makes a claim. A skill, a
-- resume bullet and an application answer all point at the same rows, so
-- "what is this based on" has one answer rather than three.
create table evidence (
  id uuid primary key default uuid_generate_v4(),
  summary text not null,
  detail text,
  confidence evidence_confidence not null default 'SELF_REPORTED',

  -- What produced this. AI_INFERRED evidence can exist, but it can never
  -- be the sole support for a claim made to an employer.
  origin provenance_kind not null default 'USER_RESPONSE',
  source_url text,
  occurred_start date,
  occurred_end date,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Employment, projects, education
-- ============================================================

create table employment_records (
  id uuid primary key default uuid_generate_v4(),
  employer text not null,

  -- The factual title and the title we are willing to show are separate
  -- columns on purpose. Neither is silently editable into the other, and
  -- a display title requires an explicit decision.
  actual_title text not null,
  display_title text,

  start_month date not null,
  end_month date,
  is_current boolean not null default false,
  location text,
  employment_type employment_type,

  responsibilities text[] not null default '{}',
  accomplishments text[] not null default '{}',
  metrics jsonb not null default '[]',
  tools text[] not null default '{}',
  notes text,

  created_at timestamptz not null default now(),
  constraint employment_dates_sane check (end_month is null or end_month >= start_month)
);

comment on column employment_records.metrics is
  'Structured so a number can carry its own basis. A metric with no basis is not usable in an application.';

create table projects (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  kind project_kind not null,
  start_month date,
  end_month date,
  description text not null,

  -- Distinct from a team description. What an employer is entitled to
  -- hear is what this person did.
  my_contribution text not null,
  tools text[] not null default '{}',
  results text,
  current_status text,
  revenue_note text,
  created_at timestamptz not null default now()
);

comment on table projects is
  'Never promoted into employment_records. A project is real experience and is not a job, and the system must not let one become the other.';

create table education (
  id uuid primary key default uuid_generate_v4(),
  institution text not null,
  credential text,
  field_of_study text,
  start_month date,
  end_month date,
  completed boolean not null default true,
  notes text
);

-- ============================================================
-- Skills and capabilities
-- ============================================================

create table skills (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  category text,

  status record_status not null default 'SUGGESTED',
  level experience_level not null default 'UNKNOWN',

  -- Optional and deliberately not mapped to a word. 5 does not mean
  -- expert; only an explicit authorization does.
  proficiency integer check (proficiency between 1 and 5),
  claim_expert boolean not null default false,

  interest skill_interest not null default 'NEUTRAL',
  importance career_importance not null default 'SUPPORTING',

  -- Free text, and load bearing: "I would not want an advanced technical
  -- interview on this" must reach resume wording and answer drafting.
  restrictions text[] not null default '{}',
  related_terms text[] not null default '{}',

  evidence_confidence evidence_confidence not null default 'SELF_REPORTED',
  last_confirmed date,
  notes text,

  -- Set when the AI proposed this skill, with what it reasoned from.
  suggested_rationale text,
  suggested_at timestamptz,
  verified_at timestamptz,

  created_at timestamptz not null default now(),
  unique (name)
);

comment on column skills.status is
  'AI may only ever insert SUGGESTED. Promotion to VERIFIED is a human action and is recorded with verified_at. Nothing in the matching or application path may read a SUGGESTED row as fact.';

comment on column skills.claim_expert is
  'Separate from proficiency so that calling this person an expert is always a deliberate act. Defaults false and no code path may set it.';

create table skill_evidence (
  skill_id uuid not null references skills(id) on delete cascade,
  evidence_id uuid not null references evidence(id) on delete cascade,
  primary key (skill_id, evidence_id)
);

-- Skills the AI believes it can see, held apart from the profile until
-- a human rules on them. Options per the spec: add as experienced,
-- capable, exposure, reject, ask later.
create table suggested_skills (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  rationale text not null,
  supporting_evidence_ids uuid[] not null default '{}',
  proposed_level experience_level,
  -- A terminology gap is not an experience gap. The first asks "is this
  -- what you would call what you did"; the second is a real absence.
  is_terminology_candidate boolean not null default false,
  resolution text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Answers and resumes
-- ============================================================

-- Answers worth reusing, with their source. A one-time answer is not
-- saved here unless explicitly promoted.
create table verified_answers (
  id uuid primary key default uuid_generate_v4(),
  question_key text not null unique,
  question_text text not null,
  answer text not null,
  provenance provenance_kind not null,
  evidence_ids uuid[] not null default '{}',
  sensitive boolean not null default false,
  last_used timestamptz,
  created_at timestamptz not null default now()
);

comment on column verified_answers.sensitive is
  'Legal, demographic or consequential answers. Never auto-filled from a pattern; always the stored explicit preference or a question to the user.';

create table resumes (
  id uuid primary key default uuid_generate_v4(),
  label text not null,
  is_master boolean not null default false,
  strategy text,
  content jsonb not null,
  file_path text,
  -- Set for tailored resumes so the wrong company's document can never be
  -- uploaded: verified against the job at upload time.
  tailored_for_job_id uuid,
  derived_from uuid references resumes(id),
  created_at timestamptz not null default now()
);

create unique index resumes_one_master on resumes(is_master) where is_master;

create table resume_claims (
  id uuid primary key default uuid_generate_v4(),
  resume_id uuid not null references resumes(id) on delete cascade,
  claim text not null,
  evidence_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

comment on table resume_claims is
  'Every substantive line of a tailored resume traces to evidence. A claim with no evidence rows is the definition of the thing this system must never produce.';

create index skills_status_idx on skills(status, importance);
create index employment_current_idx on employment_records(is_current, start_month desc);
