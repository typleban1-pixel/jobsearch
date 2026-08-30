-- Weight set v4, for the rebuilt Fit model.
--
-- Not a retune of v3. The scoring model changed shape, so v3's keys no
-- longer describe it: there is no "hard_requirement_missing" any more
-- because Fit is a coverage ratio rather than a sum of penalties, and
-- there are new terms because dimensions that existed only as unused keys
-- now actually fire.
--
-- The numbers are chosen to make the SEMANTICS legible, not to make any
-- particular job score well:
--
--   coverage_scale 70   full coverage of a posting's demands is worth 70,
--                       leaving room for seniority and title signals to
--                       matter without swamping evidence.
--   transferable_skill 2  adjacent evidence already earns half credit
--                       inside coverage; this is a small extra
--                       acknowledgement, not a second helping.
--   gating_credential_unmet -15  a licence cannot be substituted for.
--                       Deliberately large and deliberately per-credential.
--   education_gate_unmet -4  smaller, because education is currently
--                       UNVERIFIED rather than known absent. It should
--                       shrink to nothing once education is verified.
--
-- Generalist is rebuilt around functional span. The old version gave
-- nearly every job 16 because it counted requirement kinds, and every
-- posting has three.
update scoring_weights set is_active = false where version = 3;

insert into scoring_weights (version, label, weights, is_active, notes) values (
  4,
  'v4 coverage-based fit',
  jsonb_build_object(
    'fit', jsonb_build_object(
      'coverage_scale',            70,
      'transferable_skill',         2,
      'gating_credential_unmet',  -15,
      'education_gate_unmet',      -4,
      'seniority_match',            8,
      'seniority_mismatch',        -6,
      'title_family_match',         6
    ),
    'opportunity', jsonb_build_object(
      'salary_above_target',       14,
      'salary_within_target',       8,
      'salary_below_floor',       -40,
      'remote_preferred',          10,
      'chicagoland_onsite_ok',      6,
      'equity_mentioned',           4,
      'quota_carrying',            -6
    ),
    'generalist', jsonb_build_object(
      'spans_four_plus_functions', 16,
      'spans_three_functions',     10,
      'spans_two_functions',        4,
      'single_function',           -6,
      'ownership_language',         4
    ),
    'specialist', jsonb_build_object(
      'deep_single_domain',        10,
      'advanced_credential_required', 5,
      'depth_language',             4
    ),
    'uncertainty', jsonb_build_object(
      'per_unknown_field',          4,
      'per_unclear_requirement',    2,
      'eligibility_uncertain',     15,
      'salary_unknown',            10,
      'no_requirements_extracted', 35,
      'per_unmatched_trait',        1,
      'per_unevaluated_constraint', 3,
      'per_unverified_skill_match', 2,
      'unscorable_posting',        40
    )
  ),
  true,
  'Fit rebuilt as concept coverage. Positive signals activated. Generalist measured by functional span.'
);

insert into scoring_weight_changes (from_version, to_version, reason)
values (3, 4,
  'Fit was a penalty counter correlating -0.75 with requirement count, with a maximum of zero. Rebuilt as a coverage ratio over deduplicated concepts, with credential gating, education gating, seniority and title-family signals, and functional-span generalist scoring.');
