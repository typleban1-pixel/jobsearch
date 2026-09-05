-- Low-stakes recruiting/attribution survey answers.
--
-- "How did you hear about us?" is mandatory on many forms and has no
-- bearing on qualifications, eligibility, legal status, compensation,
-- identity, background, work authorization, conflicts, demographics or
-- employment history. It must not halt an otherwise valid application.
--
-- Such an answer is deliberately NOT evidence about the person: it cites
-- no profile row, so it cannot use VERIFIED/DERIVED (which the
-- grounded_states_cite_evidence check requires to carry evidence), and it
-- is not HUMAN_CONFIRMED because no human supplied it. It gets its own
-- confidence, category and provenance so the engine records the category
-- rather than disguising a generic answer as something grounded.
--
-- Additive only. Existing rows and code paths are untouched; the new
-- values are produced only by the low-stakes survey resolver.
alter type field_confidence add value if not exists 'LOW_STAKES_SURVEY';
alter type question_category add value if not exists 'F_LOW_STAKES_SURVEY';
alter type provenance_kind add value if not exists 'GENERIC_SURVEY';
