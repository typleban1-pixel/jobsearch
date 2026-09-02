-- Browser-assisted filling: the record of what was done, and what each
-- ATS was actually observed to do.
--
-- Neither table grants the portal anything new. Both are written by the
-- local worker with the service role and read by the portal, so the
-- record of a fill sits outside anything the browser role can edit.

-- ============================================================
-- 1. Per-provider behaviour: what we OBSERVED, and what we DO
-- ============================================================
--
-- These are two different things and conflating them is how an
-- assumption becomes a finding. The first version of this migration
-- seeded Greenhouse as a measured PARSER_OVERWRITES on the strength of
-- documentation, and then three live forms showed the opposite: the
-- upload was acknowledged and not one field was populated from the
-- resume. Documentation is not an observation.
--
--   parser_mode      what the resume parser has been SEEN to do.
--                    UNKNOWN until measured. Three runs that saw nothing
--                    are evidence, not a provider-wide conclusion, so
--                    they do not make it PARSER_INERT either.
--
--   upload_ordering  what the worker DOES, which is a choice about
--                    safety and may be more conservative than the
--                    evidence requires. Greenhouse uploads first because
--                    reconciling a parse that never happens costs
--                    nothing, while filling before a parse that does
--                    happen loses the answers.
--
-- The ordering is therefore deliberately independent of the mode: it can
-- stay conservative for as long as we like, and the mode stays honest.

create table if not exists ats_form_behaviour (
  provider text primary key,

  -- OBSERVED. Never set from documentation or inference.
  parser_mode text not null default 'UNKNOWN'
    check (parser_mode in ('PARSER_OVERWRITES', 'PARSER_INERT', 'UNKNOWN')),

  -- OPERATING STRATEGY. Chosen, not measured.
  upload_ordering text not null default 'UPLOAD_FIRST'
    check (upload_ordering in ('UPLOAD_FIRST', 'UPLOAD_LAST')),

  -- How many fill runs have contributed evidence about parser_mode. A
  -- mode is only worth trusting against a number.
  observation_count integer not null default 0 check (observation_count >= 0),

  observed_at timestamptz,
  -- What was actually seen. A mode with no evidence is a guess wearing a
  -- column name.
  evidence jsonb not null default '{}'
);

comment on table ats_form_behaviour is
  'Two separate things per ATS. parser_mode is what the resume parser has been OBSERVED to do and stays UNKNOWN until measured. upload_ordering is what the worker chooses to do and may be deliberately more conservative than the evidence requires.';
comment on column ats_form_behaviour.parser_mode is
  'Observed only. UNKNOWN means nobody has measured it. Runs that saw no field populated are recorded as evidence and do NOT make this PARSER_INERT; absence of observed parsing on a handful of forms is not a provider-wide finding.';
comment on column ats_form_behaviour.upload_ordering is
  'Operating strategy, not a measurement. UPLOAD_FIRST reconciles whatever the ATS parsed against the prepared answers; it is the safe default because reconciling a parse that never happened costs nothing, while filling before a parse that does happen loses the answers.';
comment on column ats_form_behaviour.observation_count is
  'Fill runs that have contributed evidence about parser_mode.';

-- All three start UNKNOWN because none has been measured. Greenhouse
-- still uploads first: that is the conservative choice, held
-- independently of what we have observed.
insert into ats_form_behaviour (provider, parser_mode, upload_ordering, evidence) values
  ('GREENHOUSE', 'UNKNOWN', 'UPLOAD_FIRST',
   '{"note":"Documented as parsing uploaded resumes, but across three live board forms the upload was acknowledged and no field was populated. Ordering stays upload-first on purpose."}'),
  ('LEVER', 'UNKNOWN', 'UPLOAD_LAST', '{"note":"not measured"}'),
  ('ASHBY', 'UNKNOWN', 'UPLOAD_LAST', '{"note":"not measured"}')
on conflict (provider) do nothing;

-- ============================================================
-- 2. One fill attempt
-- ============================================================

-- The outcome is a closed set, enforced by the database: exactly one
-- success plus every stop reason the worker implements. No parallel
-- vocabulary, and no value meaning "submitted", because the filler has
-- no code path that could produce one and this makes that true of the
-- data as well as the code.
--
-- HANDOFF is the success. It means READBACK finished, the guards were
-- torn down, and control returned to a person with the form on screen
-- and the submit control untouched. It is not a stop, which is why the
-- set cannot be exactly the stop reasons.
--
-- Kept in step with lib/browser/stopReasons.ts by
-- scripts/verify-0048.ts, which fails if the two ever drift.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'fill_outcome') then
    create type fill_outcome as enum (
      -- the one success
      'HANDOFF',
      -- every stop
      'LOGIN_WALL',
      'SSO_PROMPT',
      'CAPTCHA',
      'FORM_CHANGED',
      'POSTING_CHANGED',
      'SELECTOR_AMBIGUOUS',
      'UNLABELLED_REQUIRED_FIELD',
      'READBACK_MISMATCH',
      'UPLOAD_UNACKNOWLEDGED',
      'PARSER_CONFLICT',
      'PARSER_FILLED_BLOCKED_FIELD',
      'PARSER_BEHAVIOUR_LEARNED',
      'REQUIRED_FIELD_BLOCKED',
      'AMBIGUOUS_NAVIGATION',
      'SUBMISSION_ATTEMPT_BLOCKED',
      'DYNAMIC_LOOP_LIMIT',
      'APPLICATION_NOT_READY',
      'NO_FORM_FOUND',
      'PROVIDER_UNSUPPORTED',
      'BROWSER_ERROR'
    );
  end if;
end $$;

comment on type fill_outcome is
  'Every way a browser-assisted fill can end: HANDOFF plus every stop reason. HANDOFF means readback finished and control was returned to a person with the form on screen and the submit control untouched. It does NOT mean submitted, and there is deliberately no value that does.';

create table if not exists application_fill_runs (
  id uuid primary key default uuid_generate_v4(),
  application_id uuid not null references applications(id) on delete restrict,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  provider text not null,
  outcome fill_outcome not null,
  stop_detail text,
  form_snapshot_hash_at_fill text,
  fields_attempted integer not null default 0 check (fields_attempted >= 0),
  fields_filled integer not null default 0 check (fields_filled >= 0),
  fields_left_blank integer not null default 0 check (fields_left_blank >= 0),
  -- What the ATS parser did, and what was done about it. Kept because
  -- "the employer's software inferred this" and "we asserted this" are
  -- different claims and must stay distinguishable.
  parser_reconciliation jsonb not null default '[]',
  -- Anything the submission guards stopped. Non-empty is always a defect
  -- worth reading, never a warning to skim.
  guard_report jsonb not null default '{}',
  screenshot_dir text
);

create index if not exists application_fill_runs_by_application
  on application_fill_runs (application_id, started_at desc);

comment on table application_fill_runs is
  'One browser-assisted fill attempt, written by the local worker only. A run never submits: the outcome type has no value meaning "submitted", because the filler has no code path that could produce one.';
comment on column application_fill_runs.parser_reconciliation is
  'Per field: what the ATS parsed from the uploaded resume, what was prepared, and which won. Distinguishes the employer''s inference from this system''s assertions.';

-- ============================================================
-- 3. Read-only to the portal
-- ============================================================

alter table ats_form_behaviour enable row level security;
alter table application_fill_runs enable row level security;

drop policy if exists owner_read on public.ats_form_behaviour;
drop policy if exists owner_read on public.application_fill_runs;
create policy owner_read on public.ats_form_behaviour for select using (is_app_owner());
create policy owner_read on public.application_fill_runs for select using (is_app_owner());

revoke all on public.ats_form_behaviour from authenticated;
revoke all on public.application_fill_runs from authenticated;
grant select on public.ats_form_behaviour to authenticated;
grant select on public.application_fill_runs to authenticated;
