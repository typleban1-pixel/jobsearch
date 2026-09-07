-- job_card_summary: the Jobs list, precomputed once instead of on every request.
--
-- /jobs and /job/[id] rebuilt every JobCard from scratch per request: every
-- current job_score (with its fit_breakdown JSON), every OPEN job (18,711 rows,
-- to count variants), every company, every score_reason, location and
-- candidacy row for 1,618 ranked jobs -- 89 PostgREST round trips, 52,758
-- rows, ~19.7 MB, 8-15 seconds -- then sorted the lot in memory to render 50.
--
-- The card is a pure function of stored pipeline output (scores, candidacy,
-- job, company, locations) that changes only when the pipeline rescoring
-- runs. So the pipeline now materializes it here, through the SAME
-- loadJobCards() + matchScore() path the portal used live, and the portal
-- reads one bounded, indexed, sorted, paginated query.
--
-- `card` is the full JobCard object, so the rendering code is unchanged and
-- the list, the detail page and any offline analysis read one shape. The
-- scalar columns exist only to filter, sort and paginate in the database.
--
-- Interest (save/dismiss) and application status are deliberately NOT
-- stored: both change on the user's own actions and are overlaid live from
-- their small source tables, so a save shows instantly without a rebuild.
--
-- Display only. Submission never reads this table: the worker revalidates
-- job status, candidacy, material gaps and every other gate against the
-- authoritative rows before it acts.

create table if not exists job_card_summary (
  job_id            uuid primary key references jobs(id) on delete cascade,
  opening_id        uuid not null,
  match_score       integer not null,
  match_provisional boolean not null default false,
  candidacy_verdict text,
  fit_score         numeric,
  credited_count    integer not null default 0,
  title             text not null,
  company           text not null,
  posted_at         timestamptz,
  first_seen_at     timestamptz,
  eligibility       text,
  card              jsonb not null,
  computed_at       timestamptz not null default now()
);

-- The one ordering the list uses: Match Score, firm before provisional,
-- Formula-3 fit as the tiebreak. Covers ORDER BY ... LIMIT 50 without a sort.
create index if not exists job_card_summary_match_idx
  on job_card_summary (match_score desc, match_provisional asc, fit_score desc);
-- The default tab hides candidacy REJECT.
create index if not exists job_card_summary_candidacy_idx
  on job_card_summary (candidacy_verdict);
-- Sibling variants of an opening, and the interest/application overlays.
create index if not exists job_card_summary_opening_idx
  on job_card_summary (opening_id);

alter table job_card_summary enable row level security;
create policy job_card_summary_owner_read on job_card_summary
  for select to authenticated using (is_app_owner());
grant select on job_card_summary to authenticated;
grant select, insert, update, delete on job_card_summary to service_role;

comment on table job_card_summary is
  'Precomputed Jobs-list cards (full JobCard as jsonb + indexed sort/filter columns), rebuilt by scripts/materialize-job-cards.ts after scoring and candidacy. Display only; never consulted by submission.';
