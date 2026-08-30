-- Job versions and application binding.
--
-- A posting is not a fixed object. Titles get retitled, salary bands
-- appear and vanish, "Remote" quietly becomes "Hybrid, 3 days". If the
-- system stores only the current state, then the day after an
-- application is sent there is no way to answer the only question that
-- matters in an interview: what did the posting actually say when I
-- applied?
--
-- So: jobs holds current state, job_versions holds every state it has
-- had, and an application is bound to a VERSION rather than to a job.

create type job_change_kind as enum (
  'TITLE_CHANGED',
  'DESCRIPTION_CHANGED',
  'REQUIREMENTS_CHANGED',
  'SALARY_ADDED',
  'SALARY_REMOVED',
  'SALARY_CHANGED',
  'LOCATION_CHANGED',
  'REMOTE_POLICY_CHANGED',
  'SENIORITY_CHANGED',
  'EMPLOYMENT_TYPE_CHANGED',
  'DEPARTMENT_CHANGED',
  'APPLY_URL_CHANGED',
  'REPOSTED',
  'STATUS_CHANGED',
  'OTHER_CHANGE'
);

create table job_versions (
  id uuid primary key default uuid_generate_v4(),
  -- RESTRICT rather than CASCADE, and deliberately the strictest link in
  -- the graph: it is what makes a job undeletable once any history
  -- exists. Deleting a job would otherwise cascade through versions,
  -- changes, raw payloads and extractions in one statement.
  job_id uuid not null references jobs(id) on delete restrict,
  version_number integer not null,

  -- Frozen copy of everything material, not a reference back to jobs.
  -- The whole point is that this row does not move when the job does.
  title text not null,
  department text,
  location_raw text,
  city text, state text, country text, metro text,
  remote_policy remote_policy not null,
  remote_geographic_restriction text,
  onsite_days_per_week integer,
  employment_arrangement employment_arrangement not null,
  seniority seniority_level not null,
  salary_min integer,
  salary_max integer,
  salary_currency text,
  salary_period text,
  salary_is_estimated boolean not null default false,
  is_individual_contributor boolean,
  manages_people boolean,
  travel_requirement_pct integer,
  has_quota_or_commission boolean,
  mentions_equity boolean,
  description_text text,
  requirements_snapshot jsonb not null default '[]',

  content_hash text not null,
  -- Which parser produced this row. Needed to tell a source change apart
  -- from a change in how we read the source.
  normalizer_version integer not null default 1,
  observed_at timestamptz not null default now(),
  is_current boolean not null default true,

  unique (job_id, version_number)
);

create unique index job_versions_one_current on job_versions(job_id) where is_current;

comment on table job_versions is
  'A new row only when content_hash changes. An unchanged daily fetch writes nothing here and costs no LLM call.';

comment on column job_versions.requirements_snapshot is
  'Requirements frozen as JSON rather than joined from job_requirements, because those rows are re-extracted and would otherwise mutate under a completed application.';

create table job_changes (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid not null references jobs(id) on delete restrict,
  from_version_id uuid references job_versions(id) on delete restrict,
  to_version_id uuid not null references job_versions(id) on delete restrict,
  kind job_change_kind not null,
  field_name text,
  old_value text,
  new_value text,
  -- Set for the changes that can invalidate a decision already made:
  -- a salary band appearing below the floor, remote becoming hybrid,
  -- a hard requirement being added.
  is_material boolean not null default false,
  detected_at timestamptz not null default now()
);

comment on column job_changes.is_material is
  'Drives re-review. A typo fix is not material. A job going from Remote to Hybrid after an application was sent is, and must be surfaced rather than silently absorbed.';

-- ============================================================
-- Applications
-- ============================================================

create type application_status as enum (
  'DRAFT',
  'AWAITING_REVIEW',
  'READY_TO_SUBMIT',
  'BLOCKED_NEEDS_INPUT',
  'SUBMITTED',
  'ACKNOWLEDGED',
  'IN_PROCESS',
  'INTERVIEWING',
  'OFFER',
  'REJECTED',
  'WITHDRAWN',
  'ABANDONED'
);

create type submission_mode as enum ('MANUAL','ASSISTED','AUTOMATED');

create table applications (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid not null references jobs(id) on delete cascade,

  -- Binds to the exact text applied against, and to the exact score that
  -- justified the decision. Neither can shift afterwards.
  job_version_id uuid not null references job_versions(id) on delete restrict,
  decision_snapshot_id uuid,

  status application_status not null default 'DRAFT',
  submission_mode submission_mode not null default 'MANUAL',

  resume_id uuid references resumes(id),
  cover_letter text,

  -- The three gates that must all be true before anything is submitted.
  -- Defaults false; there is no automated path that sets human_approved.
  all_fields_confident boolean not null default false,
  human_approved boolean not null default false,
  human_approved_at timestamptz,
  blocked_reason text,

  submitted_at timestamptz,
  confirmation_reference text,
  confirmation_email_received boolean not null default false,

  outcome_note text,
  last_status_change_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Structural expression of the rule. Nothing reaches SUBMITTED without
  -- confidence in every material field AND explicit human approval.
  -- Rather manually finish an application than submit one wrong field.
  constraint submitted_requires_approval check (
    status not in ('SUBMITTED','ACKNOWLEDGED','IN_PROCESS','INTERVIEWING','OFFER')
    or (human_approved and all_fields_confident and submitted_at is not null)
  )
);

comment on constraint submitted_requires_approval on applications is
  'A partially confident application cannot become a submitted one. Uncertainty routes to BLOCKED_NEEDS_INPUT, which is a question to the user, not a guess.';

-- Every answer actually sent, kept per application. Makes "what did I
-- tell them" answerable, and makes an answer reusable only when it was
-- marked reusable.
create table application_answers (
  id uuid primary key default uuid_generate_v4(),
  application_id uuid not null references applications(id) on delete cascade,
  question_bank_id uuid references question_bank(id),
  question_text text not null,
  answer_text text,
  category question_category not null,
  provenance provenance_kind not null,
  confidence numeric check (confidence between 0 and 1),
  -- False forces the field in front of the user before submission.
  is_confident boolean not null default false,
  needed_user_input boolean not null default false,
  answered_at timestamptz not null default now()
);

create table application_events (
  id uuid primary key default uuid_generate_v4(),
  -- An application is withdrawn or abandoned, never deleted. Its event
  -- log is the record of what was actually sent on your behalf.
  application_id uuid not null references applications(id) on delete restrict,
  event text not null,
  detail text,
  from_status application_status,
  to_status application_status,
  actor text not null default 'system',
  occurred_at timestamptz not null default now()
);

create index job_versions_job_idx on job_versions(job_id, version_number desc);
create index job_changes_job_idx on job_changes(job_id, detected_at desc);
create index job_changes_material_idx on job_changes(detected_at desc) where is_material;
create index applications_status_idx on applications(status, updated_at desc);
create index applications_job_idx on applications(job_id);
create index application_answers_app_idx on application_answers(application_id);
create index application_answers_unconfident_idx on application_answers(application_id) where not is_confident;

alter table resumes
  add constraint resumes_job_version_fk
  foreign key (tailored_for_job_version_id) references job_versions(id) on delete set null;
