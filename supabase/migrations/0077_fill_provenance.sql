-- What a fill run actually did, recorded whether or not a machine drove it.
--
-- 0048 gave a run its outcome and its field counts. Three things it did
-- not give it turned out to matter, and the Popl application proved it:
-- the system opened an Ashby form, filled part of it, a person finished
-- and submitted it, and NOTHING in this database records that the form
-- was ever opened. The application carries submission_mode = MANUAL,
-- which is true and is also the wrong place to look: submission_mode
-- says who pressed submit, not who filled the fields.
--
-- So these columns are deliberately about the FILL, and they are read
-- alongside applications.submission_mode rather than derived from it.
-- A partial fill followed by a human takeover is a run with
-- fill_mode = ASSISTED_MANUAL, submit_click_attempted = false, and an
-- honest stop reason. It is not an automated submission, and no column
-- here can be read as saying it was.
--
-- What is NOT changed: the fill_outcome enum. It stays exactly
-- {HANDOFF} united with the worker's stop reasons, because every way a
-- partial fill can end is already named there and inventing a value
-- would be vocabulary for its own sake. scripts/verify-0048.ts keeps
-- checking that, unmodified.

alter table application_fill_runs
  -- Who drove the browser. AUTOMATED is the worker filling from prepared
  -- answers. ASSISTED_MANUAL is the system opening the employer form and
  -- filling part of it while a person watches and then takes over. The
  -- default is AUTOMATED because every row written before this migration
  -- was written by the automated filler.
  add column if not exists fill_mode text not null default 'AUTOMATED'
    check (fill_mode in ('AUTOMATED', 'ASSISTED_MANUAL')),

  -- The exact artifact handed to the employer's file input, and its hash
  -- AT UPLOAD TIME. Denormalised on purpose: resumes.artifact_sha256 is
  -- the resume's current hash, and the question this answers is what
  -- bytes the employer received, which must stay answerable after any
  -- later re-render.
  add column if not exists resume_id uuid references resumes(id),
  add column if not exists artifact_sha256 text,
  add column if not exists artifact_path text,

  -- The irreversible boundary, on the run. applications
  -- .submit_click_attempted_at is the authority for one application;
  -- this is per run, so a run that filled and stopped stays visibly
  -- distinct from the run that went on to click. False is the truthful
  -- default: no code path in the filler can click submit.
  add column if not exists submit_click_attempted boolean not null default false;

-- A hash with no file, or a file with no hash, is half a record.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'fill_run_artifact_is_complete'
  ) then
    alter table application_fill_runs
      add constraint fill_run_artifact_is_complete
      check ((artifact_path is null) = (artifact_sha256 is null));
  end if;
end $$;

comment on column application_fill_runs.fill_mode is
  'Who drove the browser for this run. AUTOMATED is the worker filling from prepared answers; ASSISTED_MANUAL is the system opening the employer form and filling part of it before a person takes over. Independent of applications.submission_mode, which records who pressed submit.';
comment on column application_fill_runs.artifact_sha256 is
  'SHA-256 of the artifact actually uploaded, frozen at upload time. Deliberately not read through resume_id: the question is what bytes the employer received, which must survive any later re-render of that resume.';
comment on column application_fill_runs.submit_click_attempted is
  'Whether an irreversible employer submit action may have been taken during this run. False for every run written by the filler, which has no code path that clicks submit.';

-- Read-only to the portal, exactly as 0048 left it. Restated because a
-- column added to a table does not inherit an intention.
revoke all on public.application_fill_runs from authenticated;
grant select on public.application_fill_runs to authenticated;
