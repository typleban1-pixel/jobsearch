-- Corrects job_provenance.
--
-- The original view joined raw payloads on job_version_id. That silently
-- breaks for the case Phase 2 proved is common: a version created because
-- OUR PARSER changed, not because the source did.
--
-- job_raw_payloads is unique on (job_id, raw_fragment_hash), so identical
-- source bytes are stored once. When a normalizer bump produces version 2
-- from the same fragment, no payload row carries version 2's id, and the
-- view reported source_said as null for exactly the versions most likely
-- to be under investigation.
--
-- Observed in the first real run: 3,841 raw payloads against 3,879
-- versions, the 38 extra versions all coming from normalizer v1 -> v3.
--
-- The fix keys on time instead of identity: the payload in force for a
-- version is the most recent one fetched at or before that version was
-- observed. That is true whether the version came from a source change or
-- a parser change.

create or replace view job_provenance as
select
  j.id                      as job_id,
  j.title                   as current_title,
  jv.id                     as job_version_id,
  jv.version_number,
  jv.observed_at,
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

alter view job_provenance set (security_invoker = on);

comment on view job_provenance is
  'source_said vs parser_produced vs llm_produced for every version. Comparing version_normalizer_version against payload_normalizer_version separates "the board changed" from "we changed how we read the board": equal values mean the source moved, differing values mean our parser did.';
