-- How the resume READS, recorded separately from whether it is true.
--
-- Three different questions get asked of an employer-facing document,
-- and they need three different records because they have three
-- different consequences. Whether every sentence is supported is truth,
-- it lives in resume_claims, and failing it stops everything. Whether
-- the file parses is structure. Whether a screening reader would notice
-- the strongest thing in it is communication, and that is what this
-- table holds.
--
-- These rows are ANALYSIS, not evidence. A screening score is one
-- model's opinion of one draft on one day. It may be compared against
-- another draft's score and used to decide which reads better. It may
-- never justify a sentence, change an eligibility decision, or be cited
-- as support for anything: that is why the score lives here and not
-- anywhere near job_score_snapshots or resume_claims.
--
-- Immutable, for a specific reason. The interesting question later is
-- "did the resume we sent actually read the way we thought it did",
-- and that question cannot be answered by a record that was updated
-- after the outcome was known.

create table if not exists resume_screening_evaluations (
  id uuid primary key default uuid_generate_v4(),
  resume_id uuid not null references resumes(id) on delete restrict,
  application_id uuid references applications(id) on delete restrict,
  job_id uuid references jobs(id) on delete restrict,
  job_version_id uuid references job_versions(id) on delete restrict,

  -- Which document was read. The hash is the join between an evaluation
  -- and the exact content it describes: revise the resume and the hash
  -- changes, so an old evaluation stays attached to the old draft rather
  -- than appearing to describe the new one.
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  iteration integer not null default 0 check (iteration >= 0),

  evaluator_version integer not null,
  model text not null,

  -- The reading itself.
  findings jsonb not null default '[]',
  requirement_coverage jsonb not null default '[]',
  assessment jsonb not null default '{}',
  -- Comparative only. Constrained to a range so a broken evaluator
  -- cannot quietly store a number nothing can compare.
  score numeric not null check (score >= 0 and score <= 100),

  -- What reconciliation concluded, which is where the two kinds of gap
  -- are separated and where the decision not to act is recorded.
  communication_gaps jsonb not null default '[]',
  real_evidence_gaps jsonb not null default '[]',
  revision_decisions jsonb not null default '[]',
  stopped_because text,

  -- Cost, per evaluation, so a cheaper model can be argued for on
  -- numbers rather than on impression.
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  estimated_cost_cents numeric not null default 0 check (estimated_cost_cents >= 0),
  latency_ms integer not null default 0 check (latency_ms >= 0),

  created_at timestamptz not null default now()
);

create index if not exists screening_by_resume on resume_screening_evaluations (resume_id, iteration);
create index if not exists screening_by_content on resume_screening_evaluations (content_sha256);
create index if not exists screening_by_application on resume_screening_evaluations (application_id, created_at);

comment on table resume_screening_evaluations is
  'What a blind screening reader concluded from one draft. Analysis, never evidence: a score here cannot support a claim, cannot change eligibility, and cannot cause a form to be filled. Append only, because the value of the record is that it says what we believed before we knew the outcome.';
comment on column resume_screening_evaluations.content_sha256 is
  'The canonical content hash of the exact ResumeDoc that was read. Changing the resume changes this, so an evaluation can never drift onto a document it did not describe.';
comment on column resume_screening_evaluations.score is
  'Comparative only, for ranking drafts of the same resume against each other. Not a probability, not a fit score, and never an input to any deterministic guard.';
comment on column resume_screening_evaluations.real_evidence_gaps is
  'Requirements the evidence does not establish. Recorded and left alone. Closing one of these means doing the work, not rewriting the sentence.';

-- Frozen the moment it is written.
drop trigger if exists screening_evaluations_immutable on resume_screening_evaluations;
create trigger screening_evaluations_immutable before update on resume_screening_evaluations
  for each row execute function history_guard('{}', '{}');

drop trigger if exists screening_evaluations_no_delete on resume_screening_evaluations;
create trigger screening_evaluations_no_delete before delete on resume_screening_evaluations
  for each row execute function history_no_delete();

-- One evaluation per draft per iteration per evaluator. A second run of
-- the same evaluator over the same bytes is the same reading, and
-- storing it twice would make a repeated run look like agreement.
create unique index if not exists screening_one_per_draft_iteration
  on resume_screening_evaluations (resume_id, content_sha256, iteration, evaluator_version, model);

alter table resume_screening_evaluations enable row level security;

drop policy if exists screening_owner_read on resume_screening_evaluations;
create policy screening_owner_read on resume_screening_evaluations
  for select to authenticated using (is_app_owner());
grant select on resume_screening_evaluations to authenticated;

-- Cost, per model, so benchmarking a cheaper evaluator is a query rather
-- than an argument.
create or replace view screening_cost_by_model as
select model,
       evaluator_version,
       count(*)                              as evaluations,
       count(distinct resume_id)             as resumes_read,
       sum(input_tokens)                     as input_tokens,
       sum(output_tokens)                    as output_tokens,
       round(sum(estimated_cost_cents), 2)   as estimated_cost_cents,
       round(avg(latency_ms))                as avg_latency_ms,
       round(avg(score), 1)                  as avg_score,
       max(iteration)                        as deepest_revision_pass
  from resume_screening_evaluations
 group by model, evaluator_version;

comment on view screening_cost_by_model is
  'What each evaluator model costs and how it scores. Exists so a cheaper model can be compared against a stronger one on measured numbers rather than on impression.';

grant select on screening_cost_by_model to service_role;
