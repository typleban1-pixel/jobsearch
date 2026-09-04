-- 0084_resume_generations.sql
--
-- Standalone Resume Builder: paste any job posting -> tailored resume PDF.
--
-- A generation is a REQUEST, mirroring how an application DRAFT is created
-- in the portal and completed on the Mac worker. The deployed portal
-- (publishable key only) inserts a QUEUED row; the worker (service role +
-- Anthropic key + local Chrome) extracts requirements from the pasted
-- text, runs the SAME tailoring + grounding engine an application uses,
-- renders the PDF, and links the immutable `resumes` row. No application
-- record is created -- resumes already stand alone.
--
-- Idempotent: the table is newly introduced and holds no data yet, so a
-- clean drop/recreate applies the integrity rules below whether or not an
-- earlier form of this table was already created.

drop table if exists resume_generations cascade;

create table resume_generations (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'QUEUED'
    check (status in ('QUEUED', 'PREPARING', 'DONE', 'FAILED')),

  -- input: the pasted posting, kept verbatim for audit/reproduction
  pasted_text text not null,              -- normalized plain text (for extraction/audit)
  pasted_html text,                       -- SANITIZED clipboard HTML only; raw clipboard HTML is never persisted
  detected_title text,
  detected_company text,
  corrected_title text,                   -- manual correction, if any
  corrected_company text,
  matched_job_id uuid references jobs(id) on delete set null,  -- optional provenance only

  -- bound to the authoritative evidence used at generation time. Same
  -- integer type and FK the rest of the schema uses, so a generation can
  -- only ever name a profile version that actually exists.
  profile_version integer references profile_versions(version) on delete restrict,
  extraction_version integer,

  -- output
  resume_id uuid references resumes(id) on delete set null,
  artifact_sha256 text check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  content_sha256 text check (content_sha256 ~ '^[0-9a-f]{64}$'),
  tailoring_summary jsonb,                -- the "Show Tailoring Details" payload (evidence provenance, not model reasoning)

  -- failure, understandable and retryable
  error_category text,                    -- POSTING_UNCLEAR, EXTRACTION_FAILED, GROUNDING_FAILED, RENDER_FAILED, WORKER_UNAVAILABLE, ...
  error_detail text,

  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,

  -- A DONE generation proves the whole chain, because the resumes row
  -- carries no structured profile version (only a string in its label)
  -- and does not force content_sha256 to be set. So the binding lives
  -- here: the exact profile snapshot (profile_version -> profile_versions,
  -- which holds truth_hash), the exact grounded content (content_sha256),
  -- and the exact immutable PDF (artifact_sha256).
  constraint resume_generation_done_is_bound
    check (status <> 'DONE' or (
      resume_id is not null
      and profile_version is not null
      and content_sha256 is not null
      and artifact_sha256 is not null)),
  constraint resume_generation_failed_has_reason
    check (status <> 'FAILED' or error_category is not null)
);

-- the worker claims the oldest QUEUED row atomically, like submit-listener
create index resume_generations_queued
  on resume_generations (created_at) where status = 'QUEUED';

alter table resume_generations enable row level security;

create policy resume_generations_owner on resume_generations
  for all using (is_app_owner()) with check (is_app_owner());

-- Two guarantees a CHECK constraint cannot make, because both look at
-- another table or the prior row state:
--
--   1. A DONE generation's recorded artifact_sha256 must EQUAL the SHA on
--      the immutable resumes row it links, so the PDF a person downloads
--      is provably the exact document that passed grounding.
--   2. A DONE generation is immutable. "Regenerate" makes a NEW row; a
--      completed artifact is never mutated, and status never transitions
--      out of DONE.
--
-- Everything else (QUEUED -> PREPARING claim, PREPARING -> DONE/FAILED,
-- FAILED -> QUEUED retry) stays permitted, so a failed attempt can be
-- safely re-queued without ever touching a finished one.
create or replace function resume_generation_integrity() returns trigger as $$
declare linked_artifact text; linked_content text;
begin
  if tg_op = 'UPDATE' and old.status = 'DONE' then
    raise exception 'resume_generation % is DONE and immutable; create a new generation to regenerate', old.id;
  end if;
  if new.status = 'DONE' then
    select artifact_sha256, content_sha256 into linked_artifact, linked_content
      from resumes where id = new.resume_id;
    if linked_artifact is null or linked_content is null then
      raise exception 'DONE generation % links resume % which has no stored artifact/content hash', new.id, new.resume_id;
    end if;
    if new.artifact_sha256 is distinct from linked_artifact then
      raise exception 'DONE generation % artifact_sha256 does not match its linked resume artifact', new.id;
    end if;
    if new.content_sha256 is distinct from linked_content then
      raise exception 'DONE generation % content_sha256 does not match its linked resume content', new.id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger resume_generation_integrity_trg
  before insert or update on resume_generations
  for each row execute function resume_generation_integrity();
