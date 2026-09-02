-- The opening-assignment trigger leaked a row on every upsert.
--
-- 0024 put opening assignment in a BEFORE INSERT trigger so no write path
-- could forget it. That reasoning still holds, but BEFORE INSERT fires
-- for INSERT ... ON CONFLICT DO UPDATE even when the conflict path is
-- taken and no row is inserted. scripts/eligibility.ts writes verdicts
-- with exactly that shape, so each run minted one opening per job and
-- then discarded the row that would have pointed at it.
--
-- Two runs left 9,742 orphans against 3,262 real openings. Nothing was
-- mis-assigned: every job still points at the correct opening, and
-- duplicate-application protection was never affected. But the table grew
-- without bound and its row count stopped meaning anything.
--
-- The fix is for the trigger to recognise the row it is about to be
-- handed: a job is identified by (source, external_id), so if one already
-- exists, its opening is the answer and no new one is needed.

create or replace function assign_canonical_opening() returns trigger as $$
declare
  v_opening uuid;
begin
  if new.canonical_opening_id is not null then
    return new;
  end if;

  -- Upsert conflict path. The trigger fires before the conflict is
  -- detected, so this is the only place the existing row can be found.
  select canonical_opening_id into v_opening
    from jobs
   where source = new.source and external_id = new.external_id
   limit 1;
  if v_opening is not null then
    new.canonical_opening_id := v_opening;
    return new;
  end if;

  if new.provider_opening_key is not null then
    select id into v_opening from openings
     where company_id = new.company_id and source = new.source
       and provider_opening_key = new.provider_opening_key;

    if v_opening is null then
      insert into openings (company_id, source, identity_method, provider_opening_key,
                            representative_title, representative_job_id)
      values (new.company_id, new.source, 'PROVIDER_OPENING_ID', new.provider_opening_key,
              new.title, new.id)
      on conflict (company_id, source, provider_opening_key)
        where provider_opening_key is not null
        do update set updated_at = now()
      returning id into v_opening;
    end if;
  else
    insert into openings (company_id, source, identity_method, provider_opening_key,
                          representative_title, representative_job_id)
    values (new.company_id, new.source, 'SINGLETON', null, new.title, new.id)
    returning id into v_opening;
  end if;

  new.canonical_opening_id := v_opening;
  return new;
end $$ language plpgsql;

comment on function assign_canonical_opening() is
  'Derives canonical_opening_id on insert. Reuses the opening of an existing (source, external_id) first, because BEFORE INSERT also fires for the update branch of an upsert and would otherwise mint an orphan every time.';

-- Remove the orphans. Safe: an opening no job references cannot be cited
-- by an application either, since applications derive their opening from
-- a job.
delete from openings o
 where not exists (select 1 from jobs j where j.canonical_opening_id = o.id)
   and not exists (select 1 from applications a where a.canonical_opening_id = o.id);

-- And make the condition impossible to reach silently again.
create or replace function openings_must_be_reachable() returns trigger as $$
declare orphans integer;
begin
  select count(*) into orphans
    from openings o
   where not exists (select 1 from jobs j where j.canonical_opening_id = o.id)
     and not exists (select 1 from applications a where a.canonical_opening_id = o.id)
     and o.created_at < now() - interval '1 minute';
  if orphans > 100 then
    raise warning 'openings has % rows no job points at; a write path is minting them', orphans;
  end if;
  return null;
end $$ language plpgsql;

comment on function openings_must_be_reachable() is
  'Diagnostic. Not wired to a trigger: called by scripts/verify-openings.ts, which is where a slow leak should be caught rather than in the write path it would slow down.';
