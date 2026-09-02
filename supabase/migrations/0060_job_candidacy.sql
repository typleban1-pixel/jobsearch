-- Whether a job is worth applying to, and the evidence for that verdict.
--
-- Eligibility answers "could he take this job" -- location, salary, role
-- shape. It has never asked whether he is a plausible candidate, and
-- nothing downstream did either: the corpus had 687 ELIGIBLE jobs, zero
-- score snapshots, and no step between scoring and prepareApplication().
-- SpotHero became an application because a job id was passed by hand.
--
-- A verdict is only meaningful against the truth and scoring state that
-- produced it, so every version that could change the answer is stored
-- beside it. A later profile version does not reinterpret an old row; it
-- makes it stale, and stale fails closed.
--
-- Structured, not prose. reason is for a human reading the queue; the
-- columns beneath it are what makes a verdict reproducible.

create table if not exists job_candidacy (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid not null references jobs(id) on delete cascade,

  verdict text not null check (verdict in
    ('APPLICATION_CANDIDATE', 'STRETCH', 'REJECT', 'MANUAL_REVIEW')),
  reason_codes text[] not null default '{}',
  reason text not null,

  -- The state this verdict describes. All four move independently.
  profile_version integer not null,
  formula_version integer not null,
  taxonomy_version integer not null,
  model_version integer not null,

  -- The arithmetic, so the verdict can be recomputed by hand.
  hard_met integer not null,
  hard_total integer not null,
  direct_matches integer not null,
  transferable_matches integer not null,
  baseline_met integer not null,

  -- The gap shape. Each is the set of concepts, not a count, because
  -- WHICH requirement is missing is the whole question.
  occupational jsonb not null default '[]',
  core_gaps text[] not null default '{}',
  gating_gaps text[] not null default '{}',
  unknown_gates text[] not null default '{}',

  created_at timestamptz not null default now()
);

-- One current verdict per job per state. Rescoring under the same state
-- is the same answer; rescoring under a new profile writes a new row and
-- leaves the old one readable.
create unique index if not exists job_candidacy_current
  on job_candidacy (job_id, profile_version, formula_version, taxonomy_version, model_version);
create index if not exists job_candidacy_by_verdict on job_candidacy (verdict, created_at desc);
create index if not exists job_candidacy_by_job on job_candidacy (job_id, created_at desc);

comment on table job_candidacy is
  'Whether a job is worth applying to, with the structured reasoning behind it. Tied to the exact profile, formula, taxonomy and model versions that produced it: a later profile change makes a row stale rather than silently reinterpreting it.';
comment on column job_candidacy.verdict is
  'APPLICATION_CANDIDATE and STRETCH may both proceed to preparation and are never equivalent. REJECT and MANUAL_REVIEW fail closed.';
comment on column job_candidacy.occupational is
  'Every occupational requirement with its resolution and whether it was met. The array, not a count: a job missing "logistics experience" is a different job from one missing "SEO".';
comment on column job_candidacy.unknown_gates is
  'Gating credentials the profile has not declared. These produce MANUAL_REVIEW, never REJECT: silence is not a declared absence.';

alter table job_candidacy enable row level security;
drop policy if exists job_candidacy_owner_read on job_candidacy;
create policy job_candidacy_owner_read on job_candidacy
  for select to authenticated using (is_app_owner());
grant select on job_candidacy to authenticated;

-- ============================================================
-- Preparing an application against a job that did not pass
-- ============================================================
--
-- Retained because the development workflow genuinely needs it: this
-- system was built by preparing SpotHero by hand, and a future
-- correctness investigation may need the same. It is never a default,
-- it records who invoked it and what the verdict actually was, and it
-- does not mean the job passed.

create table if not exists candidacy_overrides (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid not null references jobs(id) on delete cascade,
  application_id uuid references applications(id) on delete set null,

  -- What candidacy actually said. Null when there was no verdict at all,
  -- which is itself a thing worth recording.
  overridden_verdict text,
  candidacy_id uuid references job_candidacy(id) on delete set null,

  invoked_by text not null,
  reason text not null check (length(btrim(reason)) > 0),
  created_at timestamptz not null default now()
);

comment on table candidacy_overrides is
  'A deliberate bypass of the candidacy gate. Its existence is the audit trail: a row here means a person decided to prepare an application the system did not clear, and it never implies the job passed.';

alter table candidacy_overrides enable row level security;
drop policy if exists candidacy_overrides_owner_read on candidacy_overrides;
create policy candidacy_overrides_owner_read on candidacy_overrides
  for select to authenticated using (is_app_owner());
grant select on candidacy_overrides to authenticated;
