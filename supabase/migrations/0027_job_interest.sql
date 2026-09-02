-- Saving and dismissing, from the portal.
--
-- Keyed to the canonical opening rather than the job row. Dismissing
-- Brex's "Manager, CX AI Strategy" should not leave its four other city
-- variants in the list, and saving one variant should not read as four
-- saved jobs. The job that triggered the decision is recorded so the
-- choice can be traced back to what was actually on screen.
--
-- This is a decision, not evidence. It never reaches scoring and never
-- reaches the truth profile.

create type interest_state as enum ('SAVED', 'NOT_INTERESTED');

create table job_interest (
  id uuid primary key default gen_random_uuid(),
  canonical_opening_id uuid not null references openings(id) on delete cascade,
  -- The variant that was on screen. Not the identity of the decision.
  decided_from_job_id uuid references jobs(id) on delete set null,
  state interest_state not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One standing decision per opening. Changing your mind is an update.
  constraint job_interest_one_per_opening unique (canonical_opening_id)
);

create index job_interest_state_idx on job_interest(state);

comment on table job_interest is
  'Saved and not-interested decisions, per canonical opening. Presentation state only: never read by scoring, eligibility or the truth profile.';

grant select, insert, update, delete on job_interest to service_role;
