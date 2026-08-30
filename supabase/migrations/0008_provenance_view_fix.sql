-- Corrects job_provenance.
--
-- WHAT WAS WRONG WITH THE VIEW
--
-- 0006 joined raw payloads on job_version_id. That silently breaks for
-- the case Phase 2 proved is common: a version created because OUR
-- PARSER changed, not because the source did.
--
-- job_raw_payloads is unique on (job_id, raw_fragment_hash), so identical
-- source bytes are stored once. When a normalizer bump produces version 2
-- from the same fragment, no payload row carries version 2's id, and the
-- view reported source_said as null for exactly the versions most likely
-- to be under investigation.
--
-- Observed in the first real ingest: 3,841 raw payloads against 3,879
-- versions, the 38 extra versions all coming from normalizer v1 -> v3.
--
-- The fix keys on time instead of identity: the payload in force for a
-- version is the most recent one fetched at or before that version was
-- observed. True whether the version came from a source change or a
-- parser change.
--
-- WHY THIS DROPS THE VIEW INSTEAD OF REPLACING IT
--
-- The first attempt used CREATE OR REPLACE VIEW and was rejected:
--
--   42P16: cannot change name of view column "endpoint_url"
--          to "version_normalizer_version"
--
-- CREATE OR REPLACE VIEW may only APPEND columns to the end of the
-- existing output list. It cannot insert, reorder or rename. This change
-- does all three: two new columns land mid-list, and normalizer_version
-- becomes payload_normalizer_version because there are now two normalizer
-- versions in the row and an unqualified name would be a trap.
--
-- Appending the new columns to the end would satisfy Postgres but leave
-- normalizer_version ambiguous, which is the specific confusion this
-- migration exists to remove. So the view is dropped and rebuilt.
--
-- DROP is deliberately NOT cascading. Nothing is known to depend on this
-- view, but "known" is not "verified", and a non-cascading drop makes the
-- database itself the authority: if any dependent object exists, this
-- statement fails with its name instead of quietly destroying it.
--
-- A view carries no data, so rebuilding one costs nothing. If the CREATE
-- below were to fail, re-running this entire file is safe: the drop is
-- guarded by IF EXISTS.
--
-- No transaction control here on purpose. The CLI wraps each migration in
-- its own transaction, and a nested BEGIN/COMMIT would commit the outer
-- one early.

drop view if exists job_provenance;

create view job_provenance as
select
  j.id                      as job_id,
  j.title                   as current_title,
  jv.id                     as job_version_id,
  jv.version_number,
  jv.observed_at,
  -- The two normalizer versions are the point of this view. When they
  -- disagree, the version was produced by a parser change rather than a
  -- board change, and the raw fragment beside it is the older one that
  -- is still in force.
  jv.normalizer_version     as version_normalizer_version,
  sf.endpoint_url,
  sf.http_status,
  sf.fetched_at             as fetch_time,
  sf.raw_body_retained,
  rp.source_job_id,
  rp.raw_fragment           as source_said,
  rp.raw_fragment_hash,
  rp.raw_fragment_pruned_at,
  rp.normalized             as parser_produced,
  rp.normalizer_version     as payload_normalizer_version,
  rp.normalization_warnings,
  ex.output                 as llm_produced,
  ex.extraction_version,
  ex.llm_tier,
  ex.succeeded              as extraction_succeeded
from jobs j
join job_versions jv on jv.job_id = j.id
left join lateral (
  select p.*
  from job_raw_payloads p
  where p.job_id = j.id
    and p.fetched_at <= jv.observed_at
  order by p.fetched_at desc
  limit 1
) rp on true
left join source_fetches sf on sf.id = rp.source_fetch_id
left join lateral (
  select e.*
  from job_extractions e
  where e.job_version_id = jv.id
    and e.superseded_by is null
  order by e.created_at desc
  limit 1
) ex on true;

-- Re-applied because DROP discarded it. Without this the view runs with
-- its owner's rights and reads straight past RLS.
alter view job_provenance set (security_invoker = on);

comment on view job_provenance is
  'source_said vs parser_produced vs llm_produced for every job version. Comparing version_normalizer_version against payload_normalizer_version separates "the board changed" from "we changed how we read the board": equal values mean the source moved, differing values mean our parser did.';
