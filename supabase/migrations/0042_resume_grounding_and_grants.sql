-- Resume grounding, and the narrowest grants that let the portal work.

alter table resume_claims
  -- The exact text of the frozen rows this claim was written from, stored
  -- beside the claim. A reviewer can then judge the reframing against its
  -- source without reconstructing anything.
  add column source_text text,
  add column generation claim_generation not null default 'SELECTED',
  -- Which checks ran and what they found. Kept for accepted claims too:
  -- proving the guards ran is as useful as proving they fired.
  add column grounding_checks jsonb not null default '[]';

-- Claims the guards REJECTED, kept deliberately.
--
-- A rejected claim that vanishes tells you nothing about whether the
-- guard system works. Keeping the original text and the reason is how the
-- guards themselves get audited.
create table rejected_claims (
  id uuid primary key default gen_random_uuid(),
  resume_id uuid references resumes(id) on delete cascade,
  job_id uuid references jobs(id) on delete set null,
  proposed_text text not null,
  evidence_ids uuid[] not null default '{}',
  source_text text,
  failed_check text not null,
  failure_detail text not null,
  generation claim_generation not null default 'REFRAMED',
  created_at timestamptz not null default now()
);
create index rejected_claims_check_idx on rejected_claims(failed_check, created_at desc);

comment on table rejected_claims is
  'Employer-facing text a guard refused. Kept so the guard system can be audited: a rejection that leaves no trace cannot be reviewed, and a guard that never fires looks identical to one that is broken.';

alter table resumes add column tailoring_strategy text;
alter table resumes add column grounding_version integer;

-- ============================================================
-- Portal grants: exactly what the UI does, nothing wider
-- ============================================================
--
-- 0034 reduced the browser role to reading everything and writing one
-- table. The application phase needs three more operations and no others.
-- Each is paired with a policy; the grant-from-policy discipline in 0032
-- and 0034 still holds.

create policy owner_write on public.applications
  for insert to authenticated with check (is_app_owner());
create policy owner_update on public.applications
  for update to authenticated using (is_app_owner()) with check (is_app_owner());
grant insert, update on public.applications to authenticated;

create policy owner_write on public.application_answers
  for insert to authenticated with check (is_app_owner());
create policy owner_update on public.application_answers
  for update to authenticated using (is_app_owner()) with check (is_app_owner());
grant insert, update on public.application_answers to authenticated;

-- Promoting an answer into the reusable bank is an explicit user action,
-- so the portal needs to write question_bank. It does NOT get delete.
create policy owner_write on public.question_bank
  for insert to authenticated with check (is_app_owner());
create policy owner_update on public.question_bank
  for update to authenticated using (is_app_owner()) with check (is_app_owner());
grant insert, update on public.question_bank to authenticated;

-- Everything else stays read-only to the browser. In particular the
-- truth profile, scoring, evidence and job tables remain unwritable, and
-- application_events stays worker-written so the audit trail cannot be
-- edited from a browser.

comment on table applications is
  'Nothing reaches SUBMITTED without all_fields_confident (computed from the answers) and human_approved (set only by a person). Two independent gates; neither implies the other.';
