-- The reason text on ambiguous clusters was wrong, in the direction that
-- misleads a reviewer.
--
-- 0022 decided between the two reasons with
--   count(distinct canonical_opening_id) = count(*)
-- and read that as "the provider gave each row a different opening id".
-- It does not mean that. Singleton openings are also distinct from one
-- another, so every Lever cluster satisfied it and was labelled as
-- separate requisitions confirmed by the provider. Lever supplies no
-- opening id at all, so the provider confirmed nothing.
--
-- 65 of 66 clusters carried the wrong reason. The clustering, the
-- canonical openings and the absence of duplicate protection across these
-- rows were all correct; only the explanation shown to a reviewer was
-- wrong, and that explanation is the entire value of the row.
--
-- The real test is the identity METHOD of the openings involved.

update opening_duplicate_reviews r
   set reason = case
     when not exists (
       select 1
         from unnest(r.job_ids) as jid
         join jobs j on j.id = jid
         join openings o on o.id = j.canonical_opening_id
        where o.identity_method <> 'PROVIDER_OPENING_ID'
     )
     then 'Identical description and location, and the provider gives each row a DIFFERENT opening id. Separate requisitions on the provider''s own evidence. Merge only if a person confirms the employer is really advertising one job twice.'
     else 'Identical description and location, and at least one row has NO provider opening id (Lever exposes none). Identity cannot be established from the source either way.'
   end
 where r.status = 'PENDING';
