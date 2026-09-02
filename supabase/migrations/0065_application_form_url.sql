-- Where the application form actually is, as distinct from where the job
-- is described.
--
-- jobs.apply_url holds what Greenhouse's API calls absolute_url, and for
-- a company using a custom-branded board that is the employer's own
-- careers page rather than a form. It is the right URL for provenance
-- and for a person clicking through, and it is the wrong URL for a
-- browser adapter, which opened stripe.com/jobs/search?gh_jid=7844214,
-- found a job description with an "Apply for this role" button and
-- correctly stopped with NO_FORM_FOUND.
--
-- Measured before this migration: 1,505 of 2,786 Greenhouse jobs, 54%,
-- carry an apply_url that is not a form. stripe.com 575,
-- careers.toasttab.com 313, www.brex.com 294, www.samsara.com 248,
-- www.betterment.com 31, sproutsocial.com 17, www.observe.ai 16,
-- spothero.com 11. The last of those includes the one application that
-- had already been reviewed and approved, so the fill path had never
-- been exercisable against it.
--
-- apply_url is NOT repurposed. Overwriting it would destroy the
-- employer's canonical link and silently change what an existing column
-- means, and both of those are worse than adding a column. The form URL
-- is a different fact and gets its own field.

alter table jobs
  add column if not exists application_form_url text,
  add column if not exists application_form_url_verified_at timestamptz;

comment on column jobs.apply_url is
  'The employer''s canonical link for this posting, as the board reported it. Right for provenance and for a person clicking through; NOT necessarily a form, because a custom-branded board returns the company careers page here.';
comment on column jobs.application_form_url is
  'The application form itself, derived from the board token and job id and verified against the ATS before being written. Null means no form could be resolved, and the browser adapter must refuse rather than guess: following an "Apply" link on an employer page is how a filler ends up on the wrong requisition.';
comment on column jobs.application_form_url_verified_at is
  'When the ATS last confirmed that this board and job id name this exact posting. Null alongside a non-null form url should never happen; the backfill writes both together or neither.';

create index if not exists jobs_with_a_form_url on jobs (source)
  where application_form_url is not null;
