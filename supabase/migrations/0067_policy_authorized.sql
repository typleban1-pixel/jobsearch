-- A second, weaker, honestly-labelled authorization path.
--
-- Today `submitted_requires_approval` makes it structurally impossible for
-- anything to reach SUBMITTED without human_approved = true. That is the
-- strongest guarantee in this schema and its own comment reads "Rather
-- manually finish an application than submit one wrong field."
--
-- Unattended submission cannot coexist with that constraint as written.
-- The two available moves were: set human_approved = true from a worker,
-- which makes the column lie about what happened and destroys the ability
-- to ever tell the two apart; or add a distinct mode and widen the
-- constraint to accept either. This does the second.
--
-- What is NOT weakened: all_fields_confident is still required, so a
-- blocked or unaccounted field still cannot be submitted under any mode.
-- The only thing that changes is WHO authorized it, never whether the
-- evidence gates were met.

create type authorization_mode as enum ('HUMAN_APPROVED', 'POLICY_AUTHORIZED');

alter table applications
  add column if not exists authorization_mode authorization_mode,
  add column if not exists policy_authorized_at timestamptz,
  -- The exact policy in force at the moment of authorization, copied in
  -- rather than referenced, so later edits to the policy cannot rewrite
  -- the account of why this application was allowed to go.
  add column if not exists policy_snapshot jsonb;

comment on column applications.authorization_mode is
  'Which path authorized submission. HUMAN_APPROVED means a person opened this specific application and approved it. POLICY_AUTHORIZED means it matched rules enabled in advance and no person looked at it. These are not equivalent and are never collapsed.';
comment on column applications.policy_snapshot is
  'The policy as it stood when this application was authorized. Copied, not referenced: editing the policy afterwards must not change the record of why this one was allowed.';

-- human_approved keeps its exact original meaning: a person reviewed THIS
-- application. A worker must never set it.
alter table applications
  add constraint policy_authorized_is_not_human_approval check (
    authorization_mode is distinct from 'POLICY_AUTHORIZED' or not human_approved
  );

alter table applications
  add constraint human_approved_sets_its_mode check (
    not human_approved or authorization_mode = 'HUMAN_APPROVED'
  );

alter table applications
  add constraint policy_authorization_is_timestamped check (
    authorization_mode is distinct from 'POLICY_AUTHORIZED'
    or (policy_authorized_at is not null and policy_snapshot is not null)
  );

-- The widened gate. Note what did not move: all_fields_confident and
-- submitted_at are still mandatory for every submitted state.
alter table applications drop constraint if exists submitted_requires_approval;
alter table applications add constraint submitted_requires_authorization check (
  status not in ('SUBMITTED','ACKNOWLEDGED','IN_PROCESS','INTERVIEWING','OFFER')
  or (
    all_fields_confident
    and submitted_at is not null
    and (human_approved or authorization_mode = 'POLICY_AUTHORIZED')
  )
);

comment on constraint submitted_requires_authorization on applications is
  'A partially confident application still cannot become a submitted one. Authorization may now come from a person or from a policy the person enabled in advance, and which of the two it was is recorded in authorization_mode rather than inferred.';

-- Backfill: every application approved before this migration was approved
-- by a person, because no other path existed.
update applications set authorization_mode = 'HUMAN_APPROVED' where human_approved;

-- The configurable policy. One row, same singleton shape as
-- operating_policy, which continues to hold the global kill switch.
create table if not exists automation_policy (
  id uuid primary key default gen_random_uuid(),
  singleton boolean not null default true unique check (singleton),

  -- Candidacy classes that may be submitted without a person looking.
  -- STRETCH deliberately absent: a stretch application is exactly the
  -- one whose evidence gaps deserve a human read.
  auto_submit_candidacy text[] not null default '{CANDIDATE}',
  -- Classes prepared automatically but routed to review rather than sent.
  review_candidacy text[] not null default '{STRETCH}',

  min_fit numeric,
  -- Unknown salary stays unknown. Missing compensation is not evidence
  -- of a low salary and must not be treated as failing the floor.
  allow_unknown_salary boolean not null default true,
  base_salary_floor integer not null default 85000,

  -- Null means no cap, which is not the same as a cap of zero.
  max_applications_per_day integer,

  require_resume_review boolean not null default false,
  excluded_company_ids uuid[] not null default '{}',
  excluded_job_ids uuid[] not null default '{}',

  updated_at timestamptz not null default now()
);

comment on table automation_policy is
  'What an application must satisfy to be authorized without a person reading it. Every evidence, candidacy, confidence and verification gate applies on top of this and is not configurable here.';

insert into automation_policy (singleton) values (true) on conflict do nothing;

alter table automation_policy enable row level security;
drop policy if exists owner_read on public.automation_policy;
create policy owner_read on public.automation_policy for select using (is_app_owner());
drop policy if exists owner_write on public.automation_policy;
create policy owner_write on public.automation_policy for update using (is_app_owner()) with check (is_app_owner());
revoke all on public.automation_policy from authenticated;
grant select, update on public.automation_policy to authenticated;
