-- The concept set behind a MANUAL_REVIEW / UNRESOLVED_ROLE_DEFINING_REQUIREMENT
-- verdict.
--
-- Stored as a set for the same reason core_gaps is: WHICH requirement is
-- unresolved is the whole question, and recovering it by parsing the
-- reason prose is parsing, not recall.
--
-- Model 4 produces these. An unresolved role-defining requirement is
-- neither met nor missing, and excluding it from the hard-requirement
-- ratio would let the remaining requirements stand in for it.
alter table job_candidacy
  add column if not exists unresolved_core text[] not null default '{}';

comment on column job_candidacy.unresolved_core is
  'Role-defining or occupational HARD requirements left UNKNOWN. From model 4 these produce MANUAL_REVIEW: an unresolved requirement is neither met nor missing, and excluding it from the hard-requirement ratio would let the remaining requirements stand in for it.';
