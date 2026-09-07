-- Approval batches. Approving an application still requests submission
-- (submit_requested_at), but the request now carries the earliest moment
-- the listener may run it: the next scheduled run at midnight, 8:00 or
-- 16:00 local. "Apply now" in the portal moves that moment to the present.
-- Null means "as soon as the listener sees it", which is what the
-- unattended worker's own requests and every pre-existing request mean.
alter table applications add column if not exists submit_not_before timestamptz;

comment on column applications.submit_not_before is
  'Earliest time the submit listener may claim this request. Set to the next scheduled run '
  '(00:00, 08:00, 16:00 local) when a person approves; cleared to now() by Apply now; null = run at once.';

create index if not exists applications_submit_due_idx
  on applications (submit_not_before)
  where submit_requested_at is not null and submit_started_at is null and submitted_at is null;
