-- Canonical openings.
--
-- The bug this closes: applications_one_active_per_opening was unique on
-- jobs.id, which assumed one row per opening. That assumption is false.
-- Greenhouse publishes ONE requisition as SEVERAL job posts, one per
-- location, each with its own id. Brex's "Manager, CX AI Strategy" is one
-- requisition published to New York, San Francisco, Seattle, Salt Lake
-- City and Vancouver. Under the old index all five were independently
-- applyable, so the system could submit five applications to one job.
--
-- The identity evidence, and its limits
-- -------------------------------------
-- Greenhouse exposes two ids and only one of them is identity:
--
--   id               the JOB POST, one per published listing
--   internal_job_id  the underlying REQUISITION. Several posts sharing one
--                    is the provider stating they are the same opening.
--
-- requisition_id is free text the company fills in however it likes: 573
-- rows in this corpus carry the literal string "See Opening ID". It is
-- never used here.
--
-- Lever's public postings API exposes no requisition id at all. Its
-- "opening" field is description prose. 1,430 rows therefore have no
-- provider identity and can never be merged on source evidence.
--
-- What may and may not merge
-- --------------------------
-- Only the provider's own opening id merges anything. Title similarity,
-- description hash and location similarity never do, in any combination.
--
-- Measured on this corpus, that distinction is not academic:
--   * Flexport's "Senior Ocean Operations Associate" is three rows with
--     identical titles, three different requisitions, in Tokyo, Qingdao
--     and Shanghai. Three real jobs.
--   * Stripe's "Communities Partner Development Manager" is two rows
--     identical in title, department, location, content hash AND
--     description hash, published five minutes apart, with DIFFERENT
--     internal_job_ids. Two real requisitions. Identical content does not
--     override the provider's explicit statement that they differ.
--
-- A company-plus-title rule would have wrongly merged 382 groups covering
-- 1,171 rows.

create type opening_identity_method as enum (
  -- The provider told us. The only method that merges anything.
  'PROVIDER_OPENING_ID',
  -- No provider identity available, or available and distinct. The row is
  -- its own opening. This is the safe default, not a failure.
  'SINGLETON'
);

create table openings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  -- text, mirroring jobs.source rather than introducing an enum that
  -- would then have to be kept in step with it.
  source text not null,

  identity_method opening_identity_method not null,
  -- The provider's opening id, when there is one. Null for singletons.
  provider_opening_key text,

  -- Carried for reading and debugging. Identity never depends on these.
  representative_title text not null,
  representative_job_id uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A provider opening id means the same opening within one company and
  -- one provider, and nothing across them. Two employers can hold the same
  -- integer and they are not related.
  constraint provider_key_present_iff_provider_method check (
    (identity_method = 'PROVIDER_OPENING_ID' and provider_opening_key is not null)
    or (identity_method = 'SINGLETON' and provider_opening_key is null)
  )
);

create unique index openings_provider_identity
  on openings(company_id, source, provider_opening_key)
  where provider_opening_key is not null;

comment on table openings is
  'One real hiring opening. Several jobs rows may point at one of these when the ATS says they are the same requisition published to several locations. Never inferred from title, description or location.';
comment on column openings.provider_opening_key is
  'Greenhouse internal_job_id. NOT requisition_id, which is free text: 573 rows in this corpus carry the literal "See Opening ID".';

-- Every job gets an opening, including the ones that are alone in theirs.
--
-- Nullable would have made the application guard partial, and a guard that
-- silently does not apply to some rows is the shape of the bug being
-- fixed. NOT NULL is enforced after the backfill below.
alter table jobs add column canonical_opening_id uuid references openings(id) on delete restrict;
create index jobs_canonical_opening_idx on jobs(canonical_opening_id);

comment on column jobs.canonical_opening_id is
  'The opening this row is a published variant of. Every job has one. A multi-location requisition has several jobs rows pointing at the same opening, and each row stays a distinct variant so location eligibility can still be evaluated per variant.';

-- ============================================================
-- Ambiguity, surfaced rather than guessed
-- ============================================================
--
-- Rows identical in content and location that the provider either calls
-- different requisitions, or says nothing about. These are NOT merged and
-- duplicate protection does NOT span them. They are recorded so a person
-- can decide, and so the decision is durable when they do.

create type opening_review_status as enum ('PENDING', 'SAME_OPENING', 'DIFFERENT_OPENINGS');

create table opening_duplicate_reviews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  -- Stable key for the cluster, so re-running detection updates rather
  -- than duplicates a review.
  cluster_key text not null unique,
  job_ids uuid[] not null,
  reason text not null,
  status opening_review_status not null default 'PENDING',
  resolved_at timestamptz,
  resolved_note text,
  created_at timestamptz not null default now()
);

comment on table opening_duplicate_reviews is
  'Clusters that look identical but that the source does not confirm are one opening. Pending clusters get no duplicate protection: the rows stay independently applyable until a person says otherwise.';

-- ============================================================
-- Application-level protection
-- ============================================================

-- The variant actually applied through. A multi-location opening is one
-- application, and which location it went to is a fact worth keeping.
alter table applications add column canonical_opening_id uuid references openings(id) on delete restrict;

comment on column applications.canonical_opening_id is
  'Denormalized from jobs at write time so the uniqueness index can be a plain unique index rather than a subquery. job_id remains the exact variant applied through.';

-- Fail closed.
--
-- If a job somehow has no canonical opening, this raises rather than
-- letting the application through unprotected. An error is recoverable; a
-- second application to an opening already applied to is not.
create or replace function set_application_canonical_opening() returns trigger as $$
declare
  v_opening uuid;
begin
  select canonical_opening_id into v_opening from jobs where id = new.job_id;

  if v_opening is null then
    raise exception 'job % has no canonical opening; refusing to write an application that duplicate protection cannot cover', new.job_id
      using hint = 'Run scripts/canonicalize-openings.ts. Every job must have an opening before it can be applied to.';
  end if;

  if new.canonical_opening_id is not null and new.canonical_opening_id <> v_opening then
    raise exception 'application names opening % but job % belongs to opening %',
      new.canonical_opening_id, new.job_id, v_opening
      using hint = 'Leave canonical_opening_id unset and let it be derived from the job.';
  end if;

  new.canonical_opening_id := v_opening;
  return new;
end $$ language plpgsql;

create trigger applications_set_canonical_opening
  before insert or update of job_id, canonical_opening_id on applications
  for each row execute function set_application_canonical_opening();

comment on function set_application_canonical_opening() is
  'Derives the opening from the job and refuses the write if there is none. Fails closed on purpose: an error beats a duplicate application.';

-- The guard itself moves from the post to the opening.
--
-- Still excludes WITHDRAWN, ABANDONED and REJECTED, so a later
-- reapplication stays possible, and still says nothing about other
-- openings at the same employer.
drop index applications_one_active_per_opening;

create unique index applications_one_active_per_canonical_opening
  on applications(canonical_opening_id)
  where status not in ('WITHDRAWN', 'ABANDONED', 'REJECTED');

comment on index applications_one_active_per_canonical_opening is
  'One live application per real opening, not per published post. Applying through the New York variant of a five-city requisition blocks the other four. A different requisition at the same employer, even with an identical title, is unaffected.';

-- job_id keeps its own guard: the same post twice is also wrong, and this
-- catches it even if opening assignment were ever incomplete.
create unique index applications_one_active_per_job_post
  on applications(job_id)
  where status not in ('WITHDRAWN', 'ABANDONED', 'REJECTED');

-- ============================================================
-- Backfill, in this transaction so NOT NULL can be asserted at the end
-- ============================================================

-- The provider opening id lives in the retained raw fragment. Latest
-- fragment per job, since a job accumulates one per version.
create temp table _job_opening_key on commit drop as
select distinct on (p.job_id)
       p.job_id,
       j.company_id,
       j.source,
       j.title,
       case
         -- Greenhouse only. Lever exposes no requisition id, and reading
         -- one from another provider's payload would be inventing identity.
         when j.source = 'GREENHOUSE'
          and p.raw_fragment ? 'internal_job_id'
          and p.raw_fragment ->> 'internal_job_id' is not null
         then p.raw_fragment ->> 'internal_job_id'
         else null
       end as provider_key
  from job_raw_payloads p
  join jobs j on j.id = p.job_id
 order by p.job_id, p.fetched_at desc;

-- Jobs with no retained fragment at all still need an opening.
insert into _job_opening_key (job_id, company_id, source, title, provider_key)
select j.id, j.company_id, j.source, j.title, null
  from jobs j
 where not exists (select 1 from _job_opening_key k where k.job_id = j.id);

-- 1. One opening per distinct provider opening id.
insert into openings (company_id, source, identity_method, provider_opening_key,
                      representative_title, representative_job_id)
select k.company_id, k.source, 'PROVIDER_OPENING_ID', k.provider_key,
       -- min() has no uuid form; take the first by a deterministic order.
       min(k.title), (array_agg(k.job_id order by k.job_id))[1]
  from _job_opening_key k
 where k.provider_key is not null
 group by k.company_id, k.source, k.provider_key;

update jobs j
   set canonical_opening_id = o.id
  from _job_opening_key k
  join openings o
    on o.company_id = k.company_id
   and o.source = k.source
   and o.provider_opening_key = k.provider_key
 where j.id = k.job_id
   and k.provider_key is not null;

-- 2. Everything else is its own opening. Not a fallback for failure: a
--    posting nobody has told us is shared genuinely is one opening.
with singles as (
  insert into openings (company_id, source, identity_method, provider_opening_key,
                        representative_title, representative_job_id)
  select k.company_id, k.source, 'SINGLETON', null, k.title, k.job_id
    from _job_opening_key k
   where k.provider_key is null
  returning id, representative_job_id
)
update jobs j set canonical_opening_id = s.id
  from singles s where j.id = s.representative_job_id;

alter table jobs alter column canonical_opening_id set not null;

-- 3. Ambiguity: identical content AND identical raw location, that the
--    provider does not confirm are one opening. Recorded, never merged.
insert into opening_duplicate_reviews (company_id, cluster_key, job_ids, reason)
select company_id,
       company_id::text || '|' || description_hash || '|' || coalesce(location_raw, ''),
       array_agg(id order by id),
       case
         when count(distinct canonical_opening_id) = count(*)
           then 'Identical description and location, but the provider gives each row a different opening id. Separate requisitions unless a person confirms otherwise.'
         else 'Identical description and location, and the provider gives no opening id for these rows. Identity cannot be established from the source.'
       end
  from jobs
 where status = 'OPEN' and description_hash is not null
 group by company_id, description_hash, coalesce(location_raw, '')
having count(*) > 1
   and count(distinct canonical_opening_id) > 1;

comment on column jobs.canonical_opening_id is
  'The opening this row is a published variant of. NOT NULL: a job with no opening would be a job the application guard cannot protect.';
