-- The Master Truth Profile.
--
-- Makes one rule structurally enforceable rather than merely stated:
-- REFRAME EVIDENCE, NEVER CREATE EVIDENCE. See docs/INVARIANTS.md.
--
-- Four choices carry it:
--   Verified and suggested facts are different row states, and promotion
--   is an explicit act with a timestamp.
--   Capability and appetite are separate columns.
--   Evidence has polarity, and the ABSENCE of evidence is neither
--   positive nor negative.
--   Consequential metrics are rows with an approval flag, not free JSON.

create extension if not exists "uuid-ossp";
create extension if not exists vector;

-- ============================================================
-- Classification and provenance
-- ============================================================

-- Applied to columns via the registry at the end of this file, and
-- enforced at the LLM boundary: nothing above SENSITIVE is ever placed in
-- a prompt, a log, a frontend payload or an audit trail.
create type data_classification as enum (
  'PUBLIC_PROFILE',    -- portfolio URL, public site
  'NORMAL_PERSONAL',   -- employment history, skills
  'SENSITIVE',         -- home address, phone, exact DOB-adjacent data
  'CREDENTIAL_SECRET'  -- passwords, API keys, session tokens. Never stored here.
);

create type provenance_kind as enum (
  'PROFILE', 'EMPLOYMENT_RECORD', 'PROJECT', 'SKILL_RECORD',
  'VERIFIED_ANSWER', 'USER_RESPONSE', 'CALCULATED',
  'AI_DRAFT_FROM_VERIFIED_EVIDENCE'
);

create type evidence_confidence as enum (
  'HIGH', 'MEDIUM', 'LOW', 'SELF_REPORTED', 'AI_INFERRED'
);

-- The lifecycle every AI-proposable record shares. AI may only ever
-- insert SUGGESTED.
create type record_status as enum ('SUGGESTED', 'VERIFIED', 'REJECTED', 'DISABLED');

-- ============================================================
-- Skills vocabulary
-- ============================================================

-- Five levels, not a 1-10 scale. The distinction that matters is not fine
-- gradation, it is "done repeatedly for money" versus "touched once".
create type experience_level as enum (
  'EXPERIENCED', 'CAPABLE', 'EXPOSURE', 'LEARNING', 'UNKNOWN'
);

-- Appetite, not ability. AVOID_SPECIALIST is the load-bearing value: the
-- skill still strengthens candidacy elsewhere, it just must never become
-- the career the system recommends.
create type skill_interest as enum (
  'ACTIVELY_SEEK', 'POSITIVE', 'NEUTRAL', 'AVOID_SPECIALIST', 'DO_NOT_SEEK'
);

create type career_importance as enum ('CORE', 'SUPPORTING', 'SECONDARY', 'BACKGROUND');

-- ============================================================
-- Evidence
-- ============================================================

-- Four distinct concepts, and conflating any two of them breaks scoring.
-- The fourth, UNKNOWN, is represented by the absence of a row: there is
-- deliberately no 'UNKNOWN' value here, because a system that can write
-- down "unknown" starts treating it as a finding.
create type evidence_polarity as enum (
  'POSITIVE',           -- I have actually done X
  'VERIFIED_ABSENCE',   -- I explicitly confirmed I have NOT done X
  'PREFERENCE_AGAINST'  -- I can do X, but do not want a career centered on it
);

create table evidence (
  id uuid primary key default uuid_generate_v4(),
  polarity evidence_polarity not null default 'POSITIVE',
  summary text not null,
  detail text,
  confidence evidence_confidence not null default 'SELF_REPORTED',
  origin provenance_kind not null default 'USER_RESPONSE',
  classification data_classification not null default 'NORMAL_PERSONAL',
  source_url text,
  occurred_start date,
  occurred_end date,
  created_at timestamptz not null default now()
);

comment on type evidence_polarity is
  'UNKNOWN is not a value here. It is the absence of any row, and scoring must treat it as neutral. Absence of evidence is not evidence of absence: only VERIFIED_ABSENCE is a mismatch.';

comment on column evidence.polarity is
  'PREFERENCE_AGAINST reduces Opportunity Score without reducing Fit. Being good at video editing and wanting a video editing job are different facts.';

-- ============================================================
-- Identity and preferences
-- ============================================================

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

  work_authorization text,
  requires_sponsorship boolean,
  willing_to_relocate boolean not null default false,
  travel_tolerance text,

  salary_target_min integer,
  salary_target_ideal integer,
  salary_hard_floor integer,

  -- Bumped on any change that could alter a score. Snapshots and stale
  -- score detection both compare against it, which is what makes
  -- "rescore without refetching" possible.
  profile_version integer not null default 1,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column profile.profile_version is
  'Incremented whenever verified profile data changes. job_scores rows behind the current version are stale and get recomputed from cached features, with no refetch and no LLM call.';

comment on column profile.salary_hard_floor is
  'A deal breaker, not a preference. Excluded before ranking rather than ranked low.';

create type location_stance as enum ('PREFERRED', 'ACCEPTABLE', 'NEUTRAL', 'AVOID', 'EXCLUDE');

create table location_preferences (
  id uuid primary key default uuid_generate_v4(),
  label text not null,
  stance location_stance not null,
  country text, state text, metro text, city text, postal_code text,
  center_latitude double precision,
  center_longitude double precision,
  radius_miles integer,
  max_commute_minutes integer,
  max_onsite_days_per_week integer check (max_onsite_days_per_week between 0 and 5),
  -- A remote rule needs to say WHICH remote is acceptable, since a
  -- posting saying "Remote" while requiring residency elsewhere is not.
  applies_to_remote boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

comment on table location_preferences is
  'Chicagoland is rows here (metro, suburbs, radius), never a string match on "Chicago". Naperville is Chicagoland; a listing labelled Chicago that is onsite elsewhere is not. Configuration, so changing an acceptable commute is an edit and not a deploy.';

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
-- Employment, metrics, projects, education
-- ============================================================

create type employment_type as enum (
  'FULL_TIME','PART_TIME','CONTRACT','INTERNSHIP','FREELANCE','SELF_EMPLOYED'
);

create table employment_records (
  id uuid primary key default uuid_generate_v4(),
  status record_status not null default 'SUGGESTED',
  employer text not null,

  -- The factual title and the title we are willing to show are separate
  -- columns. Neither silently becomes the other.
  actual_title text not null,
  display_title text,

  start_month date not null,
  end_month date,
  is_current boolean not null default false,
  location text,
  employment_type employment_type,

  responsibilities text[] not null default '{}',
  accomplishments text[] not null default '{}',
  tools text[] not null default '{}',
  notes text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint employment_dates_sane check (end_month is null or end_month >= start_month)
);

-- Metrics are rows, not JSON, because they are the most consequential and
-- most abusable facts in the profile. "$6,000/month" and "$70,000 ARR"
-- may describe the same thing over different periods, and the system must
-- never pick whichever sounds larger. Each is approved separately, in
-- exact approved wording, tied to evidence.
create table metrics (
  id uuid primary key default uuid_generate_v4(),
  employment_id uuid references employment_records(id) on delete cascade,
  project_id uuid,

  label text not null,
  approved_wording text not null,
  numeric_value numeric,
  unit text,
  period_start date,
  period_end date,

  evidence_id uuid references evidence(id),
  confidence evidence_confidence not null default 'SELF_REPORTED',

  -- Gate. A metric with this false may be stored, discussed and reviewed,
  -- and may never appear in a resume, an answer or a message.
  approved_for_use boolean not null default false,
  approved_at timestamptz,
  context_note text,
  created_at timestamptz not null default now(),

  constraint metric_belongs_somewhere check (employment_id is not null or project_id is not null)
);

comment on column metrics.approved_wording is
  'The exact sentence permitted in an application. Generation selects from these strings; it does not compose its own phrasing of a number.';

comment on column metrics.approved_for_use is
  'Defaults false. No automated path may set it. An unapproved metric is invisible to every generation path.';

create type project_kind as enum (
  'PERSONAL_PROJECT','STARTUP','BUSINESS','FREELANCE',
  'TECHNICAL_PROJECT','PROTOTYPE','PORTFOLIO_PROJECT'
);

create table projects (
  id uuid primary key default uuid_generate_v4(),
  status record_status not null default 'SUGGESTED',
  name text not null,
  kind project_kind not null,
  start_month date,
  end_month date,
  description text not null,
  my_contribution text not null,
  tools text[] not null default '{}',
  results text,
  current_status text,
  revenue_note text,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table projects is
  'Never promoted into employment_records. A project is real experience and is not a job. There is deliberately no code path that converts one into the other.';

alter table metrics add constraint metrics_project_fk
  foreign key (project_id) references projects(id) on delete cascade;

create table education (
  id uuid primary key default uuid_generate_v4(),
  status record_status not null default 'SUGGESTED',
  institution text not null,
  credential text,
  field_of_study text,
  start_month date,
  end_month date,
  completed boolean not null default true,
  verified_at timestamptz,
  notes text
);

-- ============================================================
-- Skills
-- ============================================================

create table skills (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique,
  category text,

  status record_status not null default 'SUGGESTED',
  level experience_level not null default 'UNKNOWN',

  proficiency integer check (proficiency between 1 and 5),
  -- Separate from proficiency so that calling this person an expert is
  -- always a deliberate act. 5 is not the word "expert".
  claim_expert boolean not null default false,

  interest skill_interest not null default 'NEUTRAL',
  importance career_importance not null default 'SUPPORTING',

  -- Load bearing. "I would not want an advanced technical interview on
  -- this" has to reach resume wording and answer drafting.
  restrictions text[] not null default '{}',
  related_terms text[] not null default '{}',

  evidence_confidence evidence_confidence not null default 'SELF_REPORTED',
  last_confirmed date,
  notes text,

  suggested_rationale text,
  suggested_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default now(),

  -- A verified skill must record when it was verified. Prevents a row
  -- being flipped to VERIFIED without leaving a trace.
  constraint verified_skills_are_stamped
    check (status <> 'VERIFIED' or verified_at is not null)
);

comment on column skills.status is
  'AI may only insert SUGGESTED. Nothing in matching, scoring or application generation may read a SUGGESTED row as fact. Promotion is a human act.';

create table skill_evidence (
  skill_id uuid not null references skills(id) on delete cascade,
  evidence_id uuid not null references evidence(id) on delete cascade,
  primary key (skill_id, evidence_id)
);

create table suggested_skills (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  rationale text not null,
  supporting_evidence_ids uuid[] not null default '{}',
  proposed_level experience_level,
  -- A terminology gap asks "is this what you would call what you did".
  -- An experience gap is a real absence. They must not be merged.
  is_terminology_candidate boolean not null default false,
  resolution text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Question bank
-- ============================================================

-- Replaces a simple answers table. Keyed on normalized intent rather than
-- question wording, because the same question arrives phrased twenty ways
-- across twenty ATS platforms.
create type question_category as enum (
  'A_VERIFIED_FACT',        -- auto-fill from profile
  'B_CALCULATED',           -- derived conservatively from evidence
  'C_AI_DRAFTED_GROUNDED',  -- written from verified evidence
  'D_SENSITIVE',            -- legal, demographic, consequential: stored preference or ask
  'E_UNKNOWN'               -- ask
);

create table question_bank (
  id uuid primary key default uuid_generate_v4(),
  intent_key text not null unique,
  intent_description text not null,
  category question_category not null,

  approved_answer text,
  answer_provenance provenance_kind,
  evidence_ids uuid[] not null default '{}',

  -- Category C answers are job-specific by nature. Reuse without review
  -- is how a message about the wrong company gets sent.
  reuse_allowed boolean not null default false,
  sensitive boolean not null default false,
  classification data_classification not null default 'NORMAL_PERSONAL',

  last_reviewed timestamptz,
  created_at timestamptz not null default now(),

  -- A sensitive question can never be silently auto-filled from a
  -- pattern; it needs an explicit stored preference or it asks.
  constraint sensitive_questions_are_category_d
    check (not sensitive or category = 'D_SENSITIVE')
);

-- Every real-world phrasing seen, so intent matching improves from
-- observation instead of guesswork.
create table question_occurrences (
  id uuid primary key default uuid_generate_v4(),
  question_bank_id uuid references question_bank(id) on delete restrict,
  original_wording text not null,
  ats text,
  company_id uuid,
  job_id uuid,
  matched_confidence numeric,
  matched_by text,
  seen_at timestamptz not null default now()
);

-- ============================================================
-- Resumes
-- ============================================================

create table resumes (
  id uuid primary key default uuid_generate_v4(),
  label text not null,
  is_master boolean not null default false,
  strategy text,
  content jsonb not null,
  file_path text,
  tailored_for_job_id uuid,
  tailored_for_job_version_id uuid,
  derived_from uuid references resumes(id),
  created_at timestamptz not null default now()
);

create unique index resumes_one_master on resumes(is_master) where is_master;

create table resume_claims (
  id uuid primary key default uuid_generate_v4(),
  resume_id uuid not null references resumes(id) on delete cascade,
  claim text not null,
  evidence_ids uuid[] not null default '{}',
  metric_id uuid references metrics(id),
  created_at timestamptz not null default now()
);

comment on table resume_claims is
  'Every substantive line traces to evidence or an approved metric. A claim with neither is exactly what this system exists not to produce.';

-- ============================================================
-- Data classification registry
-- ============================================================

-- Column-level classification, held as data so the LLM boundary and the
-- export path can both read it. A redaction helper consults this before
-- any payload leaves the system; the scoring model has no business
-- knowing a street address.
create table data_classifications (
  table_name text not null,
  column_name text not null,
  classification data_classification not null,
  reason text,
  primary key (table_name, column_name)
);

insert into data_classifications (table_name, column_name, classification, reason) values
  ('profile','address_line','SENSITIVE','Home address. Never needed for scoring.'),
  ('profile','phone','SENSITIVE','Only ever used to fill an application field.'),
  ('profile','latitude','SENSITIVE','Precise home location.'),
  ('profile','longitude','SENSITIVE','Precise home location.'),
  ('profile','postal_code','SENSITIVE','Used for commute maths; redact before prompts.'),
  ('profile','legal_first_name','NORMAL_PERSONAL',null),
  ('profile','legal_last_name','NORMAL_PERSONAL',null),
  ('profile','email_job_search','NORMAL_PERSONAL','Dedicated address, not personal email.'),
  ('profile','portfolio_url','PUBLIC_PROFILE',null),
  ('profile','linkedin_url','PUBLIC_PROFILE',null),
  ('profile','website_urls','PUBLIC_PROFILE',null),
  ('profile','work_authorization','SENSITIVE','Legal status.'),
  ('profile','requires_sponsorship','SENSITIVE','Legal status.'),
  ('profile','salary_target_min','SENSITIVE','Negotiating position.'),
  ('profile','salary_target_ideal','SENSITIVE','Negotiating position.'),
  ('profile','salary_hard_floor','SENSITIVE','Negotiating position.');

comment on table data_classifications is
  'Read by the LLM boundary before building any prompt. SENSITIVE and CREDENTIAL_SECRET never appear in prompts, logs, frontend payloads or audit trails. No credential is stored in this database at all.';

create index skills_status_idx on skills(status, importance);
create index skills_level_idx on skills(level, interest);
create index employment_current_idx on employment_records(is_current, start_month desc);
create index evidence_polarity_idx on evidence(polarity, confidence);
create index metrics_approved_idx on metrics(approved_for_use) where approved_for_use;

-- ============================================================
-- Profile versioning: making the integer real
-- ============================================================

-- profile.profile_version on its own is a label. To defend a decision
-- made months ago the system has to be able to answer what version 7
-- ACTUALLY CONTAINED, not merely that it existed.
--
-- Two mechanisms, with two different jobs:
--
--   profile_versions + profile_version_rows  answers "what was true".
--   truth_change_log                          answers "what changed".
--
-- Reconstruction is a frozen row set rather than a replay of the log,
-- deliberately. Replay puts the correctness of history in application
-- code, where a bug silently rewrites the past. A frozen set is captured
-- once, by one function, and can be read with a single WHERE clause.
--
-- The duplication this costs is small in absolute terms: the verified
-- truth set is a few hundred rows, versions bump only when verified data
-- changes, and a working lifetime of versions is a few megabytes. That is
-- a better trade than a clever normalization whose reconstruction query
-- has to be trusted.

create table profile_versions (
  version integer primary key,
  reason text not null,
  -- Hash over the frozen row set, so a reconstruction can be checked
  -- rather than assumed intact.
  truth_hash text,
  row_count integer,
  -- The transaction that cut this version. Recorded explicitly rather
  -- than read from xmin, because the deferred constraint below needs to
  -- prove the snapshot and the version increment were the same event,
  -- and a value it can compare is worth more than one it must infer.
  created_xact xid8 not null default pg_current_xact_id(),
  created_at timestamptz not null default now()
);

create table profile_version_rows (
  profile_version integer not null references profile_versions(version) on delete restrict,
  source_table text not null,
  row_id uuid not null,
  row_data jsonb not null,
  primary key (profile_version, source_table, row_id)
);

comment on table profile_version_rows is
  'Frozen copy of every VERIFIED truth row at the moment a version was cut. Append only. Reconstructing version 7 is: select row_data where profile_version = 7.';

-- Every mutation of a truth table, including ones that do not bump the
-- version: a SUGGESTED row being inserted, a rejection, a note edit.
-- This is the audit trail, not the reconstruction mechanism.
create table truth_change_log (
  id uuid primary key default uuid_generate_v4(),
  source_table text not null,
  row_id uuid,
  operation text not null,
  changed_fields text[] not null default '{}',
  old_data jsonb,
  new_data jsonb,
  profile_version_at_time integer,
  actor text not null default 'unknown',
  occurred_at timestamptz not null default now()
);

comment on table truth_change_log is
  'Append only. Records who changed what and when, including AI-inserted SUGGESTED rows that never became verified. Answers "did something try to write this as fact".';

create or replace function log_truth_change() returns trigger as $$
declare
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_changed text[] := '{}';
  k text;
begin
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(v_old) loop
      if (v_old -> k) is distinct from (v_new -> k) then
        v_changed := v_changed || k;
      end if;
    end loop;
    if cardinality(v_changed) = 0 then
      return new;
    end if;
  end if;

  insert into truth_change_log (
    source_table, row_id, operation, changed_fields, old_data, new_data,
    profile_version_at_time, actor
  ) values (
    tg_table_name,
    coalesce((v_new ->> 'id')::uuid, (v_old ->> 'id')::uuid),
    tg_op,
    v_changed,
    v_old,
    v_new,
    (select profile_version from profile where singleton),
    coalesce(current_setting('app.actor', true), 'unknown')
  );

  return case tg_op when 'DELETE' then old else new end;
end $$ language plpgsql security definer set search_path = public;

do $$
declare t text;
begin
  foreach t in array array[
    'profile','location_preferences','work_preferences','evidence',
    'employment_records','metrics','projects','education','skills',
    'skill_evidence','suggested_skills','question_bank','resume_claims'
  ] loop
    execute format(
      'create trigger %I_truth_log after insert or update or delete on %I
         for each row execute function log_truth_change()', t || '_log', t);
  end loop;
end $$;

-- Cuts a version and freezes the verified truth set in one transaction.
-- The only supported way to bump profile_version: a bare UPDATE on the
-- integer would produce a label with nothing behind it.
create or replace function bump_profile_version(p_reason text)
returns integer as $$
declare v integer;
begin
  -- Next version comes from the registry, never from the column being
  -- written. If the counter were ever moved by hand, incrementing it
  -- would silently reuse a version number that already has a different
  -- truth set frozen under it.
  select coalesce(max(version), 0) + 1 into v from profile_versions;

  update profile set profile_version = v, updated_at = now() where singleton;

  if not found then
    raise exception 'bump_profile_version: no profile row exists yet';
  end if;

  -- Gathered first, so the version row can be written with its hash and
  -- count already final. profile_versions is append-only under the
  -- guards in 0007, which means there is no second pass to fill them in.
  drop table if exists _pv_rows;
  create temp table _pv_rows (source_table text, row_id uuid, row_data jsonb)
    on commit drop;

  insert into _pv_rows select 'profile', id, to_jsonb(r) from profile r;
  insert into _pv_rows select 'location_preferences', id, to_jsonb(r) from location_preferences r;
  insert into _pv_rows select 'work_preferences', id, to_jsonb(r) from work_preferences r;
  insert into _pv_rows select 'evidence', id, to_jsonb(r) from evidence r;
  insert into _pv_rows select 'employment_records', id, to_jsonb(r) from employment_records r
    where r.status = 'VERIFIED';
  insert into _pv_rows select 'projects', id, to_jsonb(r) from projects r
    where r.status = 'VERIFIED';
  insert into _pv_rows select 'education', id, to_jsonb(r) from education r
    where r.status = 'VERIFIED';
  insert into _pv_rows select 'skills', id, to_jsonb(r) from skills r
    where r.status = 'VERIFIED';
  -- skill_evidence has a composite key and no id column, so the frozen
  -- row_id is derived from both halves. Keying on skill_id alone would
  -- collide for any skill backed by more than one piece of evidence.
  insert into _pv_rows select 'skill_evidence',
      md5(r.skill_id::text || r.evidence_id::text)::uuid, to_jsonb(r)
    from skill_evidence r
    where r.skill_id in (select id from skills where status = 'VERIFIED');
  -- Only approved metrics. An unapproved metric was never usable, so it
  -- was never part of the truth that produced a score.
  insert into _pv_rows select 'metrics', id, to_jsonb(r) from metrics r
    where r.approved_for_use;
  insert into _pv_rows select 'question_bank', id, to_jsonb(r) from question_bank r
    where r.approved_answer is not null;

  insert into profile_versions (version, reason, row_count, truth_hash)
  select v, p_reason, count(*),
         md5(coalesce(string_agg(row_data::text, '|' order by source_table, row_id), ''))
  from _pv_rows;

  insert into profile_version_rows (profile_version, source_table, row_id, row_data)
  select v, source_table, row_id, row_data from _pv_rows;

  drop table _pv_rows;
  return v;
end $$ language plpgsql security definer set search_path = public;

comment on function bump_profile_version(text) is
  'The only supported way to advance profile_version. Bumps and freezes atomically, so an integer never exists without the truth set behind it.';

-- ============================================================
-- Enforcing that the integer cannot lie
-- ============================================================

-- The invariant: a profile version cannot exist unless its immutable
-- profile_versions row and profile_version_rows snapshot were created in
-- the same transaction that advanced the counter.
--
-- A DEFERRED CONSTRAINT trigger is the only shape that can state this.
-- An ordinary BEFORE/AFTER trigger fires mid-statement, when the snapshot
-- legitimately does not exist yet, so it could only ever check a session
-- flag: a convention wearing a trigger's clothes. Deferring to commit
-- lets the check assert the finished state instead of the intent.
--
-- It verifies four things, and the last two are what make it more than a
-- presence check: the snapshot must be complete and must hash to what it
-- claims. A hand-written INSERT into profile_versions cannot satisfy it
-- without also correctly freezing and hashing every verified row, at
-- which point the writer has done exactly what bump_profile_version does.
create or replace function assert_profile_version_snapshot() returns trigger as $$
declare
  pv profile_versions%rowtype;
  actual_count integer;
  actual_hash text;
begin
  if tg_op = 'UPDATE' then
    if new.profile_version = old.profile_version then
      return null;
    end if;
    if new.profile_version < old.profile_version then
      raise exception 'profile_version cannot move backwards (% to %)',
        old.profile_version, new.profile_version
        using hint = 'Versions are cited by score snapshots and applications. Cut a new version instead.';
    end if;
  end if;

  -- Version 1 is the seed: the profile row exists, nothing is verified
  -- yet, and there is nothing to freeze. It carries no snapshot, and
  -- job_score_snapshots.profile_version references profile_versions, so
  -- nothing can ever be scored against it.
  if tg_op = 'INSERT' and new.profile_version = 1 then
    return null;
  end if;

  select * into pv from profile_versions where version = new.profile_version;
  if not found then
    raise exception 'profile_version % has no profile_versions row', new.profile_version
      using hint = 'Advance the version with bump_profile_version(reason). An integer with no frozen truth set behind it is a label, not a version.';
  end if;

  if pv.created_xact is distinct from pg_current_xact_id() then
    raise exception 'profile_version % was frozen in an earlier transaction', new.profile_version
      using hint = 'The snapshot and the version increment must be the same event. Use bump_profile_version(reason).';
  end if;

  select count(*),
         md5(coalesce(string_agg(row_data::text, '|' order by source_table, row_id), ''))
    into actual_count, actual_hash
    from profile_version_rows where profile_version = new.profile_version;

  if actual_count = 0 then
    raise exception 'profile_version % has an empty snapshot', new.profile_version;
  end if;

  if actual_count <> pv.row_count or actual_hash is distinct from pv.truth_hash then
    raise exception 'profile_version % snapshot is incomplete or does not match its own hash (% rows/% expected)',
      new.profile_version, actual_count, pv.row_count
      using hint = 'The frozen row set must match the row_count and truth_hash recorded with the version.';
  end if;

  return null;
end $$ language plpgsql;

create constraint trigger profile_version_requires_snapshot
  after insert or update on profile
  deferrable initially deferred
  for each row execute function assert_profile_version_snapshot();

comment on function assert_profile_version_snapshot() is
  'Deferred to commit. Binds profile.profile_version to a complete, hash-matching, same-transaction snapshot. Applies to every role including the owner: there is no session flag to set and no way to opt out.';

insert into data_classifications (table_name, column_name, classification, reason) values
  ('profile_version_rows','row_data','SENSITIVE','Frozen copies of profile rows, including address and salary floor. Never sent to an LLM.'),
  ('truth_change_log','old_data','SENSITIVE','May contain any truth column, including sensitive ones.'),
  ('truth_change_log','new_data','SENSITIVE','May contain any truth column, including sensitive ones.');

create index truth_change_log_table_idx on truth_change_log(source_table, occurred_at desc);
create index truth_change_log_row_idx on truth_change_log(row_id, occurred_at desc);
create index profile_version_rows_table_idx on profile_version_rows(source_table, row_id);
