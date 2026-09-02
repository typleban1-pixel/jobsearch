-- How far through a board we have actually read.
--
-- Workday caps a page at 20 and a large employer has thousands of
-- postings, so one run cannot see a whole board. Without somewhere to
-- record progress, "the first 600" silently becomes "the board", and a
-- newly discovered employer stays permanently half-known.
--
-- This separates two different jobs that were previously one:
--
--   BACKFILL   walk a new board to the end, across as many runs as it
--              takes, resuming from next_offset each time
--   REFRESH    once complete, read only far enough to reach postings we
--              already have, because the board is ordered newest first
--
-- Deliberately small. It is a cursor and a completeness flag, not a
-- scheduler.

create table if not exists board_ingest_state (
  provider ats_provider not null,
  token text not null,

  -- Where the next backfill run resumes. Meaningful only while
  -- backfill_complete is false.
  next_offset integer not null default 0 check (next_offset >= 0),

  -- True once a page came back short, which is the board telling us we
  -- reached the end.
  backfill_complete boolean not null default false,
  backfill_completed_at timestamptz,

  -- Postings seen during the backfill traversal, for reporting only.
  postings_seen integer not null default 0,

  last_run_at timestamptz,
  last_error text,

  primary key (provider, token)
);

comment on table board_ingest_state is
  'Per-board traversal cursor. Exists so a paginated board is eventually read in full rather than the first N postings being mistaken for the whole thing.';
comment on column board_ingest_state.backfill_complete is
  'Set when a short page proves the end of the board was reached. Until then the board is known to be partially ingested.';

alter table board_ingest_state enable row level security;
drop policy if exists owner_read on public.board_ingest_state;
create policy owner_read on public.board_ingest_state for select using (is_app_owner());
revoke all on public.board_ingest_state from authenticated;
grant select on public.board_ingest_state to authenticated;
