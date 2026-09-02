-- Provenance for a shared extraction.
--
-- 42.2% of open jobs carry a byte-identical description_hash with
-- another job, and extraction selected per job and never grouped, so 705
-- of 2,562 historical extractions re-sent text the model had already
-- seen. Same input, same model, same prompt: the second call could only
-- return the same answer, at full price.
--
-- Sharing the result is only defensible if it stays auditable, so a job
-- that reused another's extraction records which one, and the hash the
-- two agreed on at the time. That last column is what makes invalidation
-- decidable rather than assumed: when either description changes, its
-- hash no longer equals extraction_reuse_hash and the reuse is stale.
--
-- Grouping is on the hash alone. Not title, not company, not similarity.
-- 817 same-company-same-title pairs in this corpus have DIFFERENT
-- descriptions, and sharing between them would invent requirements for
-- one posting out of another's words.

alter table jobs
  add column if not exists extraction_source_job_id uuid references jobs(id) on delete set null,
  add column if not exists extraction_reuse_hash text;

-- Both or neither. A source without the hash it agreed on cannot be
-- invalidated, and a hash without a source names nothing.
alter table jobs drop constraint if exists jobs_extraction_reuse_is_complete;
alter table jobs add constraint jobs_extraction_reuse_is_complete
  check ((extraction_source_job_id is null) = (extraction_reuse_hash is null));

-- A job may not borrow from itself: that would make the leader look like
-- a follower and hide which call actually happened.
alter table jobs drop constraint if exists jobs_extraction_source_is_another_job;
alter table jobs add constraint jobs_extraction_source_is_another_job
  check (extraction_source_job_id is null or extraction_source_job_id <> id);

create index if not exists jobs_by_extraction_source on jobs (extraction_source_job_id);
create index if not exists jobs_by_description_hash on jobs (description_hash);

comment on column jobs.extraction_source_job_id is
  'The job whose extraction this one reused. Null when this job was extracted directly. Reuse requires a byte-identical description_hash, never a similar one.';
comment on column jobs.extraction_reuse_hash is
  'The description_hash both jobs shared when the result was reused. Reuse is stale once either job''s current description_hash differs from this.';
