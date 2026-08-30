-- How precisely a date is actually known.
--
-- employment_records.start_month is a NOT NULL date, so storing "2019"
-- means writing 2019-01-01 and hoping nobody reads it as January. That is
-- a small silent fabrication of exactly the kind this schema exists to
-- prevent: a generated resume would happily print "January 2019" from a
-- value that only ever meant "sometime in 2019".
--
-- The user supplied years and asked to be asked rather than have months
-- invented. This records which it is.
create type date_precision as enum ('YEAR', 'MONTH', 'DAY');

alter table employment_records add column start_precision date_precision not null default 'MONTH';
alter table employment_records add column end_precision date_precision;

alter table projects add column start_precision date_precision;
alter table projects add column end_precision date_precision;

comment on column employment_records.start_precision is
  'YEAR means the stored day and month are padding and must never be rendered. Any generated document shows a year alone.';

-- A single employer can appear more than once. Paused-and-resumed work is
-- two stints, and collapsing it into one row would claim continuous
-- employment across a period the person was working somewhere else
-- entirely.
alter table employment_records add column stint integer not null default 1;
alter table employment_records add column stint_note text;

comment on column employment_records.stint is
  'Ordinal for repeat engagements with the same employer. Two rows for one employer is correct data, not a duplicate.';

-- Why a role ended. Applications and interviews ask directly, and the
-- honest answer is worth storing once rather than improvised each time.
alter table employment_records add column departure_reason text;

comment on column employment_records.departure_reason is
  'The user''s own words. Never inferred, never generated, and never surfaced without the user choosing to use it.';
