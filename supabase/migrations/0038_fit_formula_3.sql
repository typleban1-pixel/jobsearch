-- Fit formula version 3.
--
-- Two principles, no weight changes. scoring_weights stays at v5.
--
-- 1. Baseline-aware requirement weighting. A generic education
--    requirement below the profile's own verified attainment is a
--    qualification FLOOR: everyone still in the running clears it, so it
--    separates nobody, and it carries 0.15 rather than full weight.
--    Field-specific requirements are never floors.
--
--    This replaces inverse document frequency, which measured the wrong
--    thing. IDF scores RARITY, and in a corpus of white-collar postings
--    "high school diploma or GED" is rare: it was weighted 0.69 against
--    "bachelor degree" at 0.47, and six barista postings reached Fit
--    21-23 on that single requirement.
--
-- 2. Evidence-gated priors. Title-family and seniority were flat, a
--    combined +14 handed to any posting with a familiar-looking title,
--    against a coverage component typically worth 8 to 13. They now scale
--    by min(1, credited/3). A prior modifies evidence; it does not
--    substitute for it.
--
-- Measured on 687 eligible jobs, profile version 5:
--    top 25 with <=1 credited concept   14 -> 0
--    top 25 whose credit is a floor     13 -> 0
--    Gopuff Regional Manager I (6 of 19)   rank 94 -> 22
--    Gopuff barista postings (1 of 6)      rank  4 -> 128
--
-- Formula 2 rows are preserved. Every score cites its formula version, so
-- the change is auditable and reversible by rescoring.

-- Formula 3 does not use corpus frequencies at all, which removes the
-- reproducibility hazard formula 2 introduced: a score no longer moves
-- because unrelated postings were ingested. The constraint therefore
-- applies to formula 2 specifically rather than to "2 or later".
alter table job_scores drop constraint fit_v2_requires_corpus_statistics;
alter table job_scores add constraint fit_v2_requires_corpus_statistics
  check (fit_formula_version <> 2 or corpus_statistics_id is not null);

comment on column job_scores.fit_formula_version is
  'The shape of the Fit computation, separate from the weights. 2: information-weighted smoothed coverage. 3: baseline-aware weighting with evidence-gated priors, and no corpus dependence.';
