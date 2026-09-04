-- The prepare-listener claims a DRAFT with an ownership marker, never by
-- moving status: prepareApplication() remains the sole owner of the
-- DRAFT -> PREPARING -> AWAITING_REVIEW/BLOCKED_NEEDS_INPUT state machine.
-- A single UPDATE stamps prepare_started_at only where status='DRAFT' and
-- prepare_started_at is null, so exactly one worker can win the row.
alter table applications
  add column if not exists prepare_started_at timestamptz;

comment on column applications.prepare_started_at is
  'Ownership marker for the prepare-listener''s atomic DRAFT claim. Set to now() '
  'when a worker claims the DRAFT (status is left untouched so prepareApplication '
  'still drives every status transition); cleared when preparation finishes or is '
  'released. A stamp older than the stale cutoff was left by a dead process and is '
  'reclaimed (a stuck PREPARING row is returned to DRAFT, the transition '
  'prepareApplication itself uses on failure). Never gates submission.';

-- The claim poll wants the oldest unclaimed, unblocked DRAFT quickly.
create index if not exists applications_prepare_claim_idx
  on applications (created_at)
  where status = 'DRAFT' and prepare_started_at is null and blocked_reason is null and is_test = false;
