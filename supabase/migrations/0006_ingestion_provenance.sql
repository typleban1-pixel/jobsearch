-- Raw source provenance.
--
-- Built to answer one question that only has a good answer if the
-- evidence was kept at the time: when a job turns out to be described
-- wrongly, WHO was wrong?
--
--   SOURCE WAS WRONG          the board itself said it
--   OUR FETCH/PARSER WAS WRONG we mangled what the board said
--   LLM EXTRACTION WAS WRONG   we read it fine, the model concluded wrong
--
-- Distinguishing those three requires three artifacts kept side by side:
-- the bytes as returned, the normalized object our parser produced from
-- them, and the structured output the model produced from that. Each
-- carries the version of the code that made it. With only the final
-- answer stored, every one of these failures looks identical.

-- One row per HTTP request. Cheap, and the only place a transport-level
-- failure is visible: a 200 with an empty array and a 503 look the same
-- by the time they reach the jobs table.
create table source_fetches (
  id uuid primary key default uuid_generate_v4(),
  ingest_run_id uuid references ingest_runs(id) on delete restrict,
  company_id uuid references companies(id) on delete restrict,
  ats_provider ats_provider not null,

  endpoint_url text not null,
  http_method text not null default 'GET',
  http_status integer,
  ok boolean not null,
  error text,

  response_bytes integer,
  response_hash text,
  jobs_in_payload integer,
  duration_ms integer,
  fetcher_version integer not null default 1,

  -- Retained selectively, not always. A full board payload is large and
  -- an unchanged daily fetch teaches nothing.
  raw_body text,
  raw_body_retained boolean not null default false,
  retention_reason text,
  retain_until date,
  raw_body_pruned_at timestamptz,

  fetched_at timestamptz not null default now()
);

comment on column source_fetches.raw_body is
  'Retained when the fetch failed, when the payload produced new or changed jobs, when the job count moved sharply, or when flagged for investigation. Otherwise only the hash is kept: an unchanged payload is fully described by a hash that matches yesterday''s.';

comment on column source_fetches.raw_body_pruned_at is
  'Set when a body is dropped, so an absent payload reads as pruned rather than as never captured. Silence and deletion must not look alike.';

-- One row per job per CONTENT CHANGE, not per fetch. A board checked
-- daily for a year produces one row for a job that never changed.
create table job_raw_payloads (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid not null references jobs(id) on delete restrict,
  job_version_id uuid references job_versions(id) on delete restrict,
  source_fetch_id uuid references source_fetches(id) on delete restrict,
  ingest_run_id uuid references ingest_runs(id) on delete restrict,

  source text not null,
  -- The requisition id exactly as the source gave it, kept verbatim.
  -- Sources reuse, pad and re-key these, and a normalized copy loses the
  -- evidence needed to prove a collision was theirs.
  source_job_id text not null,
  source_url text,

  -- What the source returned for this job.
  raw_fragment jsonb,
  raw_fragment_hash text not null,
  raw_fragment_bytes integer,
  raw_fragment_pruned_at timestamptz,

  -- What our parser made of it, and which parser.
  normalized jsonb not null,
  normalizer_version integer not null,
  normalization_warnings text[] not null default '{}',

  content_hash text not null,
  fetched_at timestamptz not null,
  retain_until date,
  retention_reason text,

  unique (job_id, raw_fragment_hash)
);

comment on table job_raw_payloads is
  'raw_fragment and normalized sit in the same row on purpose. Comparing them is the entire test for whether the source or the parser was wrong, and that comparison is impossible if either was discarded.';

comment on column job_raw_payloads.retain_until is
  'Null means keep indefinitely. The pruner must never drop a payload whose job_version_id is referenced by an application or a score snapshot, regardless of this date.';

-- What the model concluded, and from what. Stored apart from
-- job_requirements because requirements get re-extracted: without this,
-- a later re-extraction erases the evidence that the earlier one was
-- wrong.
create table job_extractions (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid not null references jobs(id) on delete restrict,
  job_version_id uuid references job_versions(id) on delete restrict,
  raw_payload_id uuid references job_raw_payloads(id) on delete restrict,

  extraction_version integer not null,
  llm_tier text not null,
  llm_call_id uuid references llm_calls(id) on delete restrict,

  -- Hash of what was actually fed to the model, so an extraction can be
  -- reproduced against the same input. The input itself is not stored
  -- here: it is already in job_raw_payloads, and duplicating it would put
  -- a second copy of profile-adjacent text in a second place.
  input_hash text not null,
  output jsonb not null,
  requirements_extracted integer,
  succeeded boolean not null default true,
  error text,
  superseded_by uuid references job_extractions(id) on delete restrict,
  created_at timestamptz not null default now()
);

comment on table job_extractions is
  'No prompt text and no raw model response prose. Structured output only. Prompts may carry profile data and this table is not classified to hold it.';

-- The three artifacts lined up for one job version, which is the query
-- actually run when something looks wrong.
create or replace view job_provenance as
select
  j.id                      as job_id,
  j.title                   as current_title,
  jv.id                     as job_version_id,
  jv.version_number,
  jv.observed_at,
  sf.endpoint_url,
  sf.http_status,
  sf.fetched_at             as fetch_time,
  sf.raw_body_retained,
  rp.source_job_id,
  rp.raw_fragment           as source_said,
  rp.raw_fragment_pruned_at,
  rp.normalized             as parser_produced,
  rp.normalizer_version,
  rp.normalization_warnings,
  ex.output                 as llm_produced,
  ex.extraction_version,
  ex.llm_tier,
  ex.succeeded              as extraction_succeeded
from jobs j
join job_versions jv        on jv.job_id = j.id
left join job_raw_payloads rp on rp.job_version_id = jv.id
left join source_fetches sf on sf.id = rp.source_fetch_id
left join job_extractions ex on ex.job_version_id = jv.id and ex.superseded_by is null;

comment on view job_provenance is
  'source_said vs parser_produced vs llm_produced, side by side. Reading left to right localizes a bad job description to exactly one of the three stages.';

alter table jobs add column normalizer_version integer;
alter table jobs add column fetcher_version integer;

create index source_fetches_run_idx on source_fetches(ingest_run_id, fetched_at desc);
create index source_fetches_company_idx on source_fetches(company_id, fetched_at desc);
create index source_fetches_failed_idx on source_fetches(fetched_at desc) where not ok;
create index source_fetches_prunable_idx on source_fetches(retain_until) where raw_body_retained;
create index job_raw_payloads_job_idx on job_raw_payloads(job_id, fetched_at desc);
create index job_raw_payloads_source_idx on job_raw_payloads(source, source_job_id);
create index job_raw_payloads_prunable_idx on job_raw_payloads(retain_until) where raw_fragment_pruned_at is null;
create index job_extractions_job_idx on job_extractions(job_id, created_at desc);
create index job_extractions_current_idx on job_extractions(job_version_id) where superseded_by is null;
