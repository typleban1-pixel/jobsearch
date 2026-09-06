-- Salary expectation is a strategic, employer-facing disclosure, distinct from
-- ordinary verified identity/work-authorization facts. The answer resolver used
-- to auto-fill it from salary_target_min/ideal whenever a form asked. It is now
-- released only when the person has explicitly authorized employer-facing salary
-- disclosure; absent authorization the resolver BLOCKS the field to review.
--
-- Default false: do not disclose. Flipping this to true restores autonomous
-- salary answering from the stored target. No historical answer is rewritten.
alter table profile
  add column if not exists disclose_salary_to_employers boolean not null default false;

comment on column profile.disclose_salary_to_employers is
  'When true, the answer resolver may autonomously state the stored salary target to employers. Default false: salary expectation routes to human review instead.';
