-- Phase 3: eligibility, term matching, and scoring configuration.
--
-- Purely additive. Nothing here writes a profile fact, and nothing here
-- calls a model.

-- ============================================================
-- Eligibility
-- ============================================================

-- Three states, not two, and the third is load bearing.
--
-- The gate exists to avoid paying to extract requirements from a job that
-- could never be taken. It must therefore exclude only HARD failures:
-- geography and work arrangement. It must never exclude on fit, title,
-- unknown salary or company size, because a cheap filter that quietly
-- drops good jobs is worse than the tokens it saves.
--
-- UNCERTAIN is what keeps that honest. A posting naming a US city with no
-- remote language anywhere is genuinely ambiguous: our own normalizer
-- raises that warning on roughly a third of the corpus. Guessing ONSITE
-- would discard real remote roles; guessing REMOTE would waste extraction.
-- So it survives, carrying its uncertainty, and extraction resolves it.
create type eligibility_status as enum (
  'ELIGIBLE',
  'UNCERTAIN',
  'INELIGIBLE'
);

alter table jobs add column eligibility eligibility_status;
alter table jobs add column eligibility_reason text;
alter table jobs add column eligibility_detail text;
alter table jobs add column eligibility_checked_at timestamptz;
-- Bumped when the gate's rules change, so a stale verdict is detectable
-- and re-gating is a query rather than a guess.
alter table jobs add column eligibility_version integer;

comment on column jobs.eligibility is
  'Deterministic hard-exclusion gate. ELIGIBLE and UNCERTAIN both proceed to extraction; only INELIGIBLE is withheld. Never set from an LLM.';

comment on column jobs.eligibility_reason is
  'Machine-readable reason code, one of the values in lib/scoring/eligibility.ts. Grouped in the coverage report.';

create index jobs_eligibility_idx on jobs(eligibility, status);
create index jobs_extraction_queue_idx on jobs(eligibility, extracted_at nulls first)
  where status = 'OPEN';

-- ============================================================
-- Term matching
-- ============================================================

-- How a requirement term was tied to a verified skill. Recorded so the
-- miss rate is measurable rather than asserted, which is the number that
-- decides whether pgvector is worth adding.
create type term_match_method as enum (
  'EXACT',          -- normalized term equals the skill's normalized name
  'ALIAS',          -- matched through the curated alias table
  'RELATED_TERM',   -- matched through skills.related_terms
  'NONE'            -- no match: this is the miss rate
);

alter table job_requirements add column match_method term_match_method;
alter table job_requirements add column matched_term text;

comment on column job_requirements.match_method is
  'NONE is the interesting value. The share of requirement terms landing on NONE is the miss rate; embeddings are justified by measuring it, not by assuming it.';

-- Editable vocabulary rather than a constant in code: a missing alias is
-- a data gap discovered while reading real postings, and fixing it should
-- not require a deploy.
-- gen_random_uuid(), not uuid_generate_v4().
--
-- The earlier migrations use uuid_generate_v4 from uuid-ossp, which lives
-- in the extensions schema. That resolved when they were run through the
-- dashboard SQL editor, whose search_path includes it, but `supabase db
-- push` connects without it and the first attempt at this migration
-- failed on exactly that. gen_random_uuid has been core Postgres since 13
-- and needs no extension at all. Existing tables are unaffected: a column
-- default resolves its function at DDL time.
create table term_aliases (
  id uuid primary key default gen_random_uuid(),
  alias text not null,
  canonical_term text not null,
  note text,
  -- Where the mapping came from, so a curated seed is distinguishable
  -- from something added later while triaging misses.
  origin text not null default 'SEED',
  created_at timestamptz not null default now(),
  unique (alias)
);

create index term_aliases_canonical_idx on term_aliases(canonical_term);

comment on table term_aliases is
  'Many-to-one: several aliases collapse onto one canonical term. Never the reverse, because a term that expands to several meanings is ambiguity, not a synonym.';

-- ============================================================
-- Scoring configuration
-- ============================================================

alter table job_features add column eligibility eligibility_status;
alter table job_features add column feature_version integer not null default 1;

comment on column job_features.features is
  'The complete deterministic input to scoring. Rescoring under new weights reads only this table: no refetch, no model call, no network.';

-- Weight set v1.
--
-- Four scores, deliberately independent:
--
--   fit          verified profile against the role''s actual requirements
--   opportunity  attractiveness regardless of match: compensation, work
--                arrangement, upside, career direction
--   generalist   how far the role rewards breadth and cross-functional
--                ownership
--   specialist   how far it demands narrow depth. DESCRIPTIVE. A high
--                specialist score is not a penalty; it is only a negative
--                where the profile marks that skill AVOID_SPECIALIST.
--
-- Every weight is a signed contribution to exactly one score. Unknown
-- inputs contribute zero to all four and instead raise uncertainty, so a
-- job that hides its salary is never ranked below one that publishes a
-- bad number.
insert into scoring_weights (version, label, weights, is_active, notes) values (
  1,
  'v1 deterministic baseline',
  jsonb_build_object(
    'fit', jsonb_build_object(
      'hard_requirement_met',        12,
      'hard_requirement_missing',   -18,
      'hard_requirement_unclear',      0,
      'preferred_requirement_met',     4,
      'preferred_requirement_missing', -2,
      'transferable_skill',            3,
      'seniority_match',               8,
      'seniority_mismatch',           -6,
      'title_family_match',            5
    ),
    'opportunity', jsonb_build_object(
      'salary_above_target',          14,
      'salary_within_target',          8,
      'salary_below_floor',          -40,
      'remote_preferred',             10,
      'chicagoland_onsite_ok',         6,
      'equity_mentioned',              4,
      'quota_carrying',               -6,
      'travel_heavy',                 -8,
      'hiring_velocity_high',          4
    ),
    'generalist', jsonb_build_object(
      'breadth_of_domains',            6,
      'cross_functional_language',     5,
      'ownership_language',            5,
      'narrow_single_domain',         -6
    ),
    'specialist', jsonb_build_object(
      'deep_single_domain',            8,
      'years_requirement_high',        6,
      'advanced_credential_required',  6,
      'breadth_of_domains',           -4
    ),
    'uncertainty', jsonb_build_object(
      'per_unknown_field',             4,
      'per_unclear_requirement',       6,
      'eligibility_uncertain',        15,
      'salary_unknown',               10,
      'no_requirements_extracted',    35
    )
  ),
  true,
  'Baseline. Unknown inputs contribute zero to every substantive score and only raise uncertainty.'
);
