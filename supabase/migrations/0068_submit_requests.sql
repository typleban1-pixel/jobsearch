-- Asking the worker to run an application, from the browser.
--
-- The first version of this wrote an application_events row. That table
-- deliberately has no insert policy for the browser, because the audit
-- trail is worker-written and must not be editable from a page, so every
-- click was silently rejected by RLS and the page redirected as though it
-- had worked. The request belongs on the application itself, which the
-- portal is already permitted to update, and the worker keeps writing the
-- audit trail from the service role as it always did.

alter table applications
  add column if not exists submit_requested_at timestamptz,
  -- Set by the worker when it picks the request up, so the portal can
  -- tell "you asked" from "it is running" from "it finished and here is
  -- what happened".
  add column if not exists submit_started_at timestamptz;

comment on column applications.submit_requested_at is
  'When you asked the local worker to run this application. Cleared when the worker finishes, so a stale request cannot cause a second run.';
comment on column applications.submit_started_at is
  'When the worker picked the request up. Lets the portal distinguish a queued request from one already in a browser.';

create index if not exists applications_submit_requested
  on applications (submit_requested_at) where submit_requested_at is not null;
