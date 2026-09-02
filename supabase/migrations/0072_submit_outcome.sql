-- Recording what happened to a submission request.
--
-- The portal writes a request, the local listener claims it, and the
-- real submitter runs. When the request clears, the portal needs to know
-- which of four things happened, and one distinction matters more than
-- the others: whether the irreversible employer Submit action may have
-- occurred. A run that stopped before the click can be retried safely. A
-- run that clicked and could not read a confirmation must never be
-- retried on a guess, because the employer may already have the
-- application.
--
-- submit_click_attempted_at is the load-bearing column. It is written
-- immediately BEFORE the click, so it survives the submitter being
-- SIGKILLed at the 20-minute timeout or dying outright. Its presence
-- means "a click may have happened"; its absence, for a run that has
-- ended, means the click provably did not.

alter table applications
  add column if not exists submit_outcome text,
  add column if not exists submit_outcome_at timestamptz,
  add column if not exists submit_click_attempted_at timestamptz;

-- Four values, not free text. An unrecognised outcome would be read by
-- the portal as "not ambiguous" and could offer a retry on a submission
-- that already reached the employer.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'applications_submit_outcome_check'
  ) then
    alter table applications
      add constraint applications_submit_outcome_check
      check (submit_outcome is null or submit_outcome in
             ('CONFIRMED', 'SAFE_STOP', 'AMBIGUOUS', 'DECLINED'));
  end if;
end $$;

comment on column applications.submit_outcome is
  'How the last submission request ended. CONFIRMED: the employer confirmed receipt. '
  'SAFE_STOP: the run ended before the Submit click, so nothing reached the employer '
  'and a retry is safe. AMBIGUOUS: the click may have occurred and no confirmation was '
  'read; never retry on this without a person establishing what happened. DECLINED: the '
  'request was refused before any browser work.';

comment on column applications.submit_click_attempted_at is
  'Set immediately before the irreversible employer Submit click, and deliberately not '
  'cleared by the submitter. If a run ends with this set and no confirmation, the '
  'outcome is AMBIGUOUS. Cleared only when a person resolves the ambiguity or a new '
  'request is created after a safe stop.';
