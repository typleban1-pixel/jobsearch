-- Batch extraction, built so a crash cannot buy the same work twice.
--
-- THE WINDOW THAT SHAPES THIS SCHEMA
--
-- The Message Batches API accepts no client-supplied idempotency key.
-- The documented request body is `requests[]` of {custom_id, params} and
-- one optional user-profile header; there is nothing to make create
-- safely retryable. So this sequence is genuinely ambiguous:
--
--   local intent written
--   create request reaches Anthropic and succeeds
--   the process dies before the batch id comes back
--
-- provider_batch_id IS NULL does NOT prove nothing was submitted. A
-- worker that retried on that assumption would create and pay for a
-- second batch. The SUBMITTING state exists to make that state
-- representable and terminal-until-a-human-looks.
--
-- Reconciliation cannot fully resolve it automatically either: listing
-- batches returns no developer identifier, and results_url is null until
-- processing ends, so an in-flight orphan can only be matched by
-- created_at and request_counts. That is a heuristic, not proof, which
-- is why an ambiguous submit requires approval rather than a retry.

create table if not exists extraction_batches (
  id uuid primary key default uuid_generate_v4(),

  -- Deterministic over the exact work planned. Two runs planning the
  -- same jobs at the same versions produce the same key, so a duplicate
  -- plan is refused by the unique index rather than submitted.
  intent_key text not null unique,
  -- The full request set as it will be sent. Written BEFORE the network
  -- call and never rewritten: recovery needs to know exactly what was
  -- offered, not what we would offer now.
  intent jsonb not null,

  provider_batch_id text unique,
  status text not null default 'PLANNED' check (status in
    ('PLANNED', 'SUBMITTING', 'SUBMITTED', 'PROCESSING',
     'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED', 'AMBIGUOUS')),

  extraction_version integer not null,
  model text not null,
  schema_version integer not null,
  request_count integer not null check (request_count > 0),

  estimated_cost_cents numeric,
  actual_cost_cents numeric,

  submitting_at timestamptz,
  submitted_at timestamptz,
  completed_at timestamptz,
  -- Set when a create outcome is unknown. Cleared only by a person.
  ambiguous_reason text,
  resolved_by text,
  resolved_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A batch that reached the provider must carry its id; one that never
-- left must not. AMBIGUOUS is the exception and the whole point: it is
-- the state where we do not know.
alter table extraction_batches drop constraint if exists batch_id_matches_status;
alter table extraction_batches add constraint batch_id_matches_status check (
  (status in ('PLANNED', 'SUBMITTING') and provider_batch_id is null)
  or (status = 'AMBIGUOUS')
  or (status in ('SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED')
      and provider_batch_id is not null)
);

alter table extraction_batches drop constraint if exists batch_ambiguous_has_a_reason;
alter table extraction_batches add constraint batch_ambiguous_has_a_reason
  check (status <> 'AMBIGUOUS' or ambiguous_reason is not null);

create table if not exists extraction_batch_requests (
  id uuid primary key default uuid_generate_v4(),
  batch_id uuid not null references extraction_batches(id) on delete cascade,

  -- Sent to the provider and used to match results back. Deterministic
  -- over the identity below, truncated to the API's 64-char limit.
  custom_id text not null,
  job_id uuid not null references jobs(id) on delete cascade,

  -- Request identity, durable ACROSS batches.
  --
  -- The description hash alone is not identity: the same text can belong
  -- to several job records, and a later extractor or schema version
  -- legitimately needs a fresh extraction of the same text. attempt
  -- makes a deliberate retry of a terminal failure a NEW request rather
  -- than something that quietly defeats the guard below.
  description_hash text not null,
  extraction_version integer not null,
  schema_version integer not null,
  attempt integer not null default 1 check (attempt > 0),

  status text not null default 'PENDING' check (status in
    ('PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED')),
  result_persisted_at timestamptz,
  error text,

  created_at timestamptz not null default now(),
  unique (batch_id, custom_id)
);

-- One live request per identity, across every batch.
--
-- This is what stops a second batch being planned over work already in
-- flight. Terminal requests are excluded, so a failed or expired one can
-- be retried -- but only as attempt N+1, which is a different row and an
-- explicit decision.
create unique index if not exists extraction_request_one_live_per_identity
  on extraction_batch_requests (job_id, description_hash, extraction_version, schema_version, attempt);

create index if not exists extraction_requests_live
  on extraction_batch_requests (status) where status = 'PENDING';
create index if not exists extraction_batches_open
  on extraction_batches (status) where status not in ('COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED');

comment on table extraction_batches is
  'One row per Anthropic Message Batch. The intent is written before the network call and never rewritten, because the create endpoint has no idempotency key and a crash mid-create leaves an outcome nobody can infer from provider_batch_id.';
comment on column extraction_batches.status is
  'AMBIGUOUS means a create request was sent and its outcome is unknown. It is never retried automatically: listing batches returns no developer identifier, so an in-flight orphan cannot be matched with certainty and a person must resolve it.';
comment on column extraction_batch_requests.attempt is
  'A deliberate retry of a terminal request is attempt N+1 and a new row, so retrying is visible rather than a silent bypass of the one-live-per-identity guard.';

alter table extraction_batches enable row level security;
alter table extraction_batch_requests enable row level security;
drop policy if exists extraction_batches_owner_read on extraction_batches;
create policy extraction_batches_owner_read on extraction_batches
  for select to authenticated using (is_app_owner());
drop policy if exists extraction_batch_requests_owner_read on extraction_batch_requests;
create policy extraction_batch_requests_owner_read on extraction_batch_requests
  for select to authenticated using (is_app_owner());
grant select on extraction_batches to authenticated;
grant select on extraction_batch_requests to authenticated;
