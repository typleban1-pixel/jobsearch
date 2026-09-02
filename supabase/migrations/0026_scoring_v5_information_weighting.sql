-- Scoring model revision: information-weighted, smoothed coverage.
--
-- Three changes, one release, measured together before being committed.
--
-- 1. Information weighting. Every HARD concept previously carried weight
--    3 whatever it was, so "high school diploma" and "8+ years leading
--    enterprise implementations" contributed identically. Weight is now
--    hardness x info(concept), where info comes from how many postings in
--    the corpus demand the concept. No requirement is named anywhere; the
--    corpus decides.
--
-- 2. Smoothed coverage. coverage = achieved / (achievable + k), k = 6.
--    A ratio over four evaluable concepts was worth as much as one over
--    nineteen, which made one match worth a median of 23.3 points in a
--    sparse posting and 5.7 in a dense one. Additive smoothing toward a
--    prior of zero makes a posting accumulate evidence before its ratio
--    speaks for it.
--
-- 3. The additive transferable bonus is removed. TRANSFERABLE was
--    reaching Fit through two channels, its 0.5 coverage credit AND a
--    separate +2 per concept, while DIRECT reached it through one. They
--    are now symmetric: credit is the only channel.
--
-- Deliberately NOT in this change: no requirement, employer, title or
-- occupation is special-cased. The Gopuff barista case stays unsolved and
-- documented, because "high school diploma or GED" appears in 13 of 488
-- postings, so information weighting reads it as rare and weights it UP.
-- Nothing measurable in the current data separates a trivially satisfied
-- requirement from a rare valuable one, since resolution is deterministic
-- given the profile: of 55 concepts ever satisfied, 49 are satisfied on
-- every posting that names them. That needs requirement semantics, not a
-- statistical weight, and it is a larger design question.

-- ============================================================
-- Reproducibility
-- ============================================================
--
-- Information weighting makes a score depend on the CORPUS, not only on
-- the job and the profile. The same job legitimately scores differently
-- once more postings are ingested. That is correct behaviour and a
-- reproducibility hazard: without the frequencies, a historical score
-- cannot be recomputed or defended.
--
-- So the frequencies are frozen per run, exactly as profile versions are.

create table corpus_statistics (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  -- Concept -> number of jobs in the scored corpus demanding it.
  document_frequencies jsonb not null,
  job_count integer not null,
  concept_count integer not null,
  -- Hash over the frequencies, so a reconstruction can be checked rather
  -- than assumed intact.
  statistics_hash text not null,
  computed_at timestamptz not null default now()
);

create index corpus_statistics_computed_idx on corpus_statistics(computed_at desc);

comment on table corpus_statistics is
  'Frozen document frequencies for one scoring run. Information weighting makes scores corpus-dependent, so the corpus has to be recorded or the score cannot be reproduced once more jobs are ingested.';
comment on column corpus_statistics.document_frequencies is
  'Concept to job count, over the eligible corpus that was scored. Never recomputed in place: a new run writes a new row.';

-- Historical scores must not silently acquire new frequencies.
create or replace function corpus_statistics_immutable() returns trigger as $$
begin
  raise exception 'corpus_statistics rows are immutable; write a new snapshot instead'
    using hint = 'A historical score cites its snapshot. Editing one would rewrite the past.';
end $$ language plpgsql;

create trigger corpus_statistics_no_update before update on corpus_statistics
  for each row execute function corpus_statistics_immutable();
create trigger corpus_statistics_no_delete before delete on corpus_statistics
  for each row execute function corpus_statistics_immutable();

-- ============================================================
-- Score provenance
-- ============================================================

alter table job_scores add column fit_formula_version integer not null default 1;
alter table job_scores add column corpus_statistics_id uuid references corpus_statistics(id) on delete restrict;

comment on column job_scores.fit_formula_version is
  'The shape of the Fit computation, separate from the weights. Version 2 is information-weighted smoothed coverage with no additive transferable term. Changing a coefficient bumps weights_version; changing the formula bumps this.';
comment on column job_scores.corpus_statistics_id is
  'The frozen document frequencies this score was computed against. Null only for formula version 1 scores, which did not depend on the corpus.';

-- A score is comparable to another only when all five agree.
alter table job_scores drop constraint job_scores_job_id_profile_version_weights_version_extractio_key;
alter table job_scores add constraint job_scores_reproducibility_key
  unique (job_id, profile_version, weights_version, extraction_version, fit_formula_version, corpus_statistics_id);

-- Information weighting without its snapshot is a number nobody can check.
alter table job_scores add constraint fit_v2_requires_corpus_statistics
  check (fit_formula_version < 2 or corpus_statistics_id is not null);

-- ============================================================
-- Weights v5
-- ============================================================
--
-- coverage_scale is unchanged at 70. Smoothing lowers every coverage
-- ratio, so the scale would need raising to keep the old spread, and
-- raising it is exactly the tuning that was not authorised here.

insert into scoring_weights (version, label, weights, is_active, notes)
select 5,
  'Information-weighted smoothed coverage',
  jsonb_build_object(
    'fit', jsonb_build_object(
      'coverage_scale', 70,
      'coverage_smoothing_k', 6,
      'info_weight_floor', 0.25,
      'seniority_match', 8,
      'seniority_mismatch', -6,
      'title_family_match', 6,
      'education_gate_unmet', -4,
      'gating_credential_unmet', -15
    ),
    'opportunity', w.weights -> 'opportunity',
    'generalist',  w.weights -> 'generalist',
    'specialist',  w.weights -> 'specialist',
    'uncertainty', w.weights -> 'uncertainty'
  ),
  false,
  'Option C at k=6. transferable_skill removed: TRANSFERABLE contributes only through its 0.5 coverage credit, as DIRECT does through 1.0.'
from scoring_weights w where w.version = 4;

update scoring_weights set is_active = false where version = 4;
update scoring_weights set is_active = true where version = 5;
