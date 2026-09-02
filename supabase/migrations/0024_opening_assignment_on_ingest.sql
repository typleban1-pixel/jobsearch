-- Keeps canonical_opening_id true for jobs that do not exist yet.
--
-- 0022 backfilled every existing row and made the column NOT NULL, which
-- left the next ingest run unable to insert anything. The obvious fix is
-- for the ingest writer to resolve openings before inserting jobs, and
-- the obvious fix is wrong: it puts an invariant in one code path, where
-- the next write path added does not know about it.
--
-- So the job row carries the raw evidence, provider_opening_key, and the
-- database derives identity from it. Any writer that inserts a job gets a
-- correct opening whether or not its author knew openings existed.

alter table jobs add column provider_opening_key text;

comment on column jobs.provider_opening_key is
  'Greenhouse internal_job_id, as given by the provider. Null for Lever and anything else without a requisition id. Evidence, not identity: canonical_opening_id is derived from it.';

-- Backfill from the retained fragments, same source 0022 used.
update jobs j
   set provider_opening_key = sub.key
  from (
    select distinct on (p.job_id) p.job_id,
           case when j2.source = 'GREENHOUSE' and p.raw_fragment ? 'internal_job_id'
                then p.raw_fragment ->> 'internal_job_id' else null end as key
      from job_raw_payloads p
      join jobs j2 on j2.id = p.job_id
     order by p.job_id, p.fetched_at desc
  ) sub
 where j.id = sub.job_id and sub.key is not null;

create index jobs_provider_opening_key_idx on jobs(company_id, source, provider_opening_key)
  where provider_opening_key is not null;

create or replace function assign_canonical_opening() returns trigger as $$
declare
  v_opening uuid;
begin
  -- An explicit assignment is honoured. Backfills and repairs need it,
  -- and refusing would make this trigger the thing to work around.
  if new.canonical_opening_id is not null then
    return new;
  end if;

  if new.provider_opening_key is not null then
    -- The provider named the requisition, so join the others that share it.
    select id into v_opening from openings
     where company_id = new.company_id and source = new.source
       and provider_opening_key = new.provider_opening_key;

    if v_opening is null then
      insert into openings (company_id, source, identity_method, provider_opening_key,
                            representative_title, representative_job_id)
      values (new.company_id, new.source, 'PROVIDER_OPENING_ID', new.provider_opening_key,
              new.title, new.id)
      -- Two rows of one requisition arriving in the same batch race here.
      -- The unique index settles it and both end up on the same opening.
      on conflict (company_id, source, provider_opening_key)
        where provider_opening_key is not null
        do update set updated_at = now()
      returning id into v_opening;
    end if;
  else
    -- No provider identity. Its own opening, which is the honest answer
    -- and not a degraded one.
    insert into openings (company_id, source, identity_method, provider_opening_key,
                          representative_title, representative_job_id)
    values (new.company_id, new.source, 'SINGLETON', null, new.title, new.id)
    returning id into v_opening;
  end if;

  new.canonical_opening_id := v_opening;
  return new;
end $$ language plpgsql;

create trigger jobs_assign_canonical_opening
  before insert on jobs
  for each row execute function assign_canonical_opening();

comment on function assign_canonical_opening() is
  'Derives canonical_opening_id from provider_opening_key on insert. Lives in the database so no write path can forget it.';

-- A job may not move between openings once applications may cite it.
create or replace function jobs_opening_is_stable() returns trigger as $$
begin
  if new.canonical_opening_id is distinct from old.canonical_opening_id then
    raise exception 'canonical_opening_id is immutable (job %, % -> %)',
      old.id, old.canonical_opening_id, new.canonical_opening_id
      using hint = 'Applications cite openings. Reassigning one would silently move an application to a different job.';
  end if;
  return new;
end $$ language plpgsql;

create trigger jobs_opening_stable
  before update of canonical_opening_id on jobs
  for each row execute function jobs_opening_is_stable();
