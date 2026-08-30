-- Weight set v2.
--
-- Identical to v1 except for two new uncertainty terms, and it exists as
-- a new version rather than an edit because v1 already produced scores
-- and job_scores rows cite the weights version that made them. Editing
-- v1 in place would silently rewrite the meaning of every past score.
--
-- The change: requirement kinds now fall into three classes rather than
-- being treated alike.
--
--   skill-matchable  SKILL, TOOL, CREDENTIAL, EDUCATION, DOMAIN,
--                    EXPERIENCE_YEARS. A miss here is a real gap and
--                    still costs fit.
--   constraint       LEGAL, LOGISTICAL. "Must reside in California",
--                    "will not sponsor work visas", "15% travel". Real,
--                    checkable, and checkable against profile ATTRIBUTES
--                    rather than against skills. Matching them against a
--                    skills table guarantees a miss, so they contribute
--                    nothing to fit and raise uncertainty until there is
--                    something that can actually evaluate them.
--   trait            TRAIT, OTHER. Contribute nothing to fit.
--
-- Both new terms are small. An unevaluated constraint is a real gap in
-- what we know and deserves more weight than a trait we may never be able
-- to evaluate at all.
update scoring_weights set is_active = false where version = 1;

insert into scoring_weights (version, label, weights, is_active, notes)
select
  2,
  'v2 trait and constraint aware',
  weights
    || jsonb_build_object(
         'uncertainty',
         (weights -> 'uncertainty')
           || jsonb_build_object(
                'per_unmatched_trait', 1,
                'per_unevaluated_constraint', 3
              )
       ),
  true,
  'Adds trait and constraint handling. Unmatched traits and unevaluated constraints contribute nothing to fit and only raise uncertainty.'
from scoring_weights where version = 1;

insert into scoring_weight_changes (from_version, to_version, reason)
values (1, 2,
  'Pilot found 25 of 256 requirements were soft traits that no skills table can match, each costing -18 fit under v1. Traits and constraints now contribute 0 to fit.');
