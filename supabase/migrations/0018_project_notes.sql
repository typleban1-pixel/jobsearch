-- projects has no notes column, though employment_records does.
--
-- The asymmetry was silently lossy. The intake carried per-project
-- guardrails ("never promote this to employment", "never imply it
-- replaced full-time work") and they had nowhere to land on the row, so
-- they survived only inside an evidence detail string. Guardrails belong
-- on the thing they guard.
alter table projects add column notes text;

comment on column projects.notes is
  'Scope guardrails and the user''s own corrections, held where any generator reading the project will see them.';
