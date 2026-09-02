-- The concept-level detail behind a Fit score.
--
-- score_reasons carries the POINTS, which is enough to explain a total
-- but not enough to explain a rank: it holds no record of how many
-- concepts a posting demanded, how many were judged, or which resolved
-- DIRECT rather than TRANSFERABLE. A portal that wanted to show that had
-- only two options, recompute the score itself or go without, and a
-- portal recomputing scores can disagree with the number stored beside
-- it.
--
-- So the breakdown is persisted with the score it belongs to.

alter table job_scores add column fit_breakdown jsonb;

comment on column job_scores.fit_breakdown is
  'Concept-level detail for one score: coverage, achievable weight, counts of evaluable and credited concepts, and the DIRECT / TRANSFERABLE / ABSENT concept names. Presentation and audit only; nothing reads it back into scoring.';
