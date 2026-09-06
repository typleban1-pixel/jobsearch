-- A third adapter capability tier: ASSISTED_SUBMIT.
--
-- PRODUCTION  the adapter submits UNATTENDED (Greenhouse). Every autonomous
--             submit gate keys on exactly this value.
-- ASSISTED_SUBMIT
--             the adapter can reliably PREPARE and FILL and read the form
--             back, but a human must complete an anti-bot / final-submit step
--             the system must not perform (Lever's hCaptcha). It is NEVER
--             submitted unattended: decide(), the submit-listener and the
--             submit-time readiness check all still require PRODUCTION, so
--             adding this value cannot make anything auto-submit.
-- IN_DEVELOPMENT / NONE  unchanged.
--
-- Additive only: widens the allowed set; no existing row changes.
alter table ats_policy drop constraint ats_policy_capability_check;
alter table ats_policy add constraint ats_policy_capability_check
  check (capability in ('NONE', 'IN_DEVELOPMENT', 'ASSISTED_SUBMIT', 'PRODUCTION'));
