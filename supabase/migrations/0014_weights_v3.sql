-- Weight set v3.
--
-- One new term, and it is a MECHANISM rather than a tuning. The user
-- asked explicitly that weights not be adjusted to make results look
-- better before the current model has been measured, and nothing here
-- changes an existing number.
--
-- per_unverified_skill_match exists because the matcher can now tell a
-- requirement that matches nothing from one that matches a skill which is
-- proposed but not yet verified. The second is UNKNOWN, not a gap. It
-- costs zero on Fit and raises uncertainty instead, which is what lets a
-- deliberately conservative first profile be scored at all: without it,
-- 42 unreviewed skills would have manufactured thousands of fake gaps and
-- the scores would have measured how much of the profile had been
-- reviewed rather than anything about the person.
--
-- Weighted low, at 2. An unverified skill is a smaller unknown than an
-- unevaluated legal constraint, because resolving it needs one word from
-- the user rather than new information about the job.
update scoring_weights set is_active = false where version = 2;

insert into scoring_weights (version, label, weights, is_active, notes)
select
  3,
  'v3 unverified-skill aware',
  weights
    || jsonb_build_object(
         'uncertainty',
         (weights -> 'uncertainty') || jsonb_build_object('per_unverified_skill_match', 2)
       ),
  true,
  'Adds per_unverified_skill_match. No existing weight changed: this is a new signal, not a retune.'
from scoring_weights where version = 2;

insert into scoring_weight_changes (from_version, to_version, reason)
values (2, 3,
  'Matcher can now distinguish a requirement matching nothing from one matching a SUGGESTED skill. The latter is unknown rather than a gap and must not cost Fit.');
