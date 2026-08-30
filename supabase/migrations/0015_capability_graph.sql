-- The semantic layer between job requirements and profile evidence.
--
-- A 1 percent hard-requirement match rate proved that comparing raw
-- extracted phrases against skill names does not work. Postings do not
-- write "pricing"; they write "analytical pricing management".
--
-- The instruction was explicit about how NOT to fix this: no
-- indiscriminate fuzzy matching, because similar words do not mean
-- equivalent experience. So there is no similarity score anywhere here.
-- A relation either exists as a row or it does not, it says which KIND of
-- relation it is, it carries the reasoning, and it can be read, argued
-- with and reverted.

-- Four outcomes, ordered by strength. They must never collapse into one
-- another: an unknown scored as an absence invents a gap, and an absence
-- scored as unknown hides a real one.
create type capability_match as enum (
  'DIRECT',       -- the profile evidences this concept itself
  'TRANSFERABLE', -- adjacent verified evidence partially supports it
  'UNKNOWN',      -- proposed but unverified, or simply not established
  'ABSENT'        -- nothing in the profile speaks to it at all
);

create table capability_relations (
  id uuid primary key default gen_random_uuid(),
  -- The concept as it appears in job requirements, already normalized.
  requirement_concept text not null,
  -- The profile skill that answers it.
  satisfied_by_skill text not null,
  relation capability_match not null,
  -- Why. A relation without a reason cannot be argued with later.
  rationale text not null,
  origin text not null default 'SEED',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  unique (requirement_concept, satisfied_by_skill)
);

create index capability_relations_concept_idx on capability_relations(requirement_concept);

comment on table capability_relations is
  'Deterministic and inspectable. TRANSFERABLE means adjacent evidence partially supports the requirement and earns partial credit, never full. An LLM may propose rows here during extraction; it never scores with them.';

-- Requirement classification, stored so it is queryable and so a
-- reclassification is visible as a version change rather than a silent
-- behaviour shift.
create type requirement_class as enum (
  'GATING_CREDENTIAL', 'EDUCATION', 'SKILL', 'TRAIT', 'CONSTRAINT', 'GENERIC'
);

alter table job_requirements add column requirement_class requirement_class;
alter table job_requirements add column concept text;
alter table job_requirements add column education_level text;
alter table job_requirements add column education_field text;
alter table job_requirements add column taxonomy_version integer;

create index job_requirements_class_idx on job_requirements(requirement_class, is_hard_requirement);
create index job_requirements_concept_idx on job_requirements(concept);

comment on column job_requirements.requirement_class is
  'Decided from the requirement text, not from the extractor label. A gating credential is not a skill: adjacent experience cannot substitute for a licence, and a phrase like "technology proficiency" is not a capability at all.';

-- A job with too little extracted information is UNSCORABLE, which is
-- different from scoring badly and very different from scoring well.
--
-- In the first pass the top two ranked jobs had zero requirements, one of
-- them a posting that shipped with a "Plug in job spec" placeholder still
-- in the body. They won because nothing could penalise them. Absence of
-- information is not evidence of fit.
alter table job_scores add column scorable boolean not null default true;
alter table job_scores add column unscorable_reason text;

create index job_scores_scorable_idx on job_scores(scorable, fit_score desc) where is_current;

comment on column job_scores.scorable is
  'False when the posting carries too few evaluable requirements to judge. Such jobs are ranked separately, never mixed into the main list.';
