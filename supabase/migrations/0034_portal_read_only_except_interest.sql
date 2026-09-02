-- The portal writes one table.
--
-- 0007 granted the browser role write access to the truth profile,
-- applications and scoring weights in anticipation of editing surfaces
-- that were never built. Nineteen tables carried INSERT and UPDATE for a
-- UI that writes exactly one of them.
--
-- Least privilege is a statement about what the software does today, not
-- about what it might do. A grant held for a year against a feature that
-- may never ship is a standing risk with no corresponding benefit, and
-- "we will need it later" is how a portal ends up able to rewrite an
-- employment history it never displays an edit form for.
--
-- When a profile-editing or application-management surface is built, the
-- policy and the grant are part of building it. That is one migration
-- written alongside the feature, reviewed with the feature, and scoped to
-- what the feature actually touches.
--
-- Unaffected: service_role. Ingestion, extraction, scoring, eligibility
-- and profile maintenance run as trusted scripts on a trusted machine and
-- keep the path they have always had, bound by the append-only triggers
-- rather than by RLS.

-- ============================================================
-- 1. Remove the write policies nothing uses
-- ============================================================

do $$
declare p record;
begin
  for p in
    select tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and cmd in ('INSERT', 'UPDATE')
       and tablename <> 'job_interest'
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
    raise notice 'dropped % on %', p.policyname, p.tablename;
  end loop;
end $$;

-- ============================================================
-- 2. Bring grants back into line with the policies
-- ============================================================
--
-- Same loop as 0032, rerun so the two layers keep saying the same thing.
-- SELECT stays granted table-wide everywhere because every table has RLS
-- on and an owner_read policy gated by is_app_owner(): the grant is the
-- outer door, the policy is the lock.

do $$
declare
  t text;
  can_insert boolean;
  can_update boolean;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('revoke all on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);

    select exists (select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = t and p.cmd = 'INSERT') into can_insert;
    select exists (select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = t and p.cmd = 'UPDATE') into can_update;

    if can_insert then execute format('grant insert on public.%I to authenticated', t); end if;
    if can_update then execute format('grant update on public.%I to authenticated', t); end if;
  end loop;
end $$;

-- ============================================================
-- 3. Functions the browser role no longer needs
-- ============================================================
--
-- bump_profile_version cuts a profile version and freezes a truth
-- snapshot. It was granted to authenticated for the same unbuilt editing
-- surface. Only the worker cuts versions.

revoke all on function bump_profile_version(text) from authenticated;

comment on function is_app_owner() is
  'The authorization boundary. Every remaining policy calls it. The browser role reads through it and writes only job_interest.';
