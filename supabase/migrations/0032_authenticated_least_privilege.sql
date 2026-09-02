-- authenticated gets only what it uses.
--
-- 0007 says "No DELETE is granted to the portal on any table" and creates
-- no DELETE policy anywhere, which is true as far as RLS goes: a command
-- with no permissive policy is denied. But the GRANTS told a different
-- story. Supabase's default privileges had already given authenticated
-- INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER on 51 tables,
-- and 0007's "grant select" added to that rather than replacing it.
--
-- Two layers disagreeing is a bug even when the stricter one is winning.
-- The grants are brought into line with the policies here, so that
-- removing or mis-writing a policy later cannot silently uncover a
-- privilege nobody meant to hand out.
--
-- Driven by pg_policies rather than a hand-written list, so it says the
-- same thing as the policies by construction.

do $$
declare
  t text;
  can_insert boolean;
  can_update boolean;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    -- Strip everything, then hand back only what a policy backs.
    execute format('revoke all on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);

    select exists (select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = t and p.cmd = 'INSERT')
      into can_insert;
    select exists (select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = t and p.cmd = 'UPDATE')
      into can_update;

    if can_insert then execute format('grant insert on public.%I to authenticated', t); end if;
    if can_update then execute format('grant update on public.%I to authenticated', t); end if;
  end loop;
end $$;

-- companies is the one column-level case: the portal re-prioritizes a
-- company but must never edit its observed facts. The loop above granted
-- table-wide UPDATE because an UPDATE policy exists, so narrow it again.
revoke update on public.companies from authenticated;
grant update (watchlist, priority_score, priority_reason, notes) on public.companies to authenticated;

-- SELECT is granted table-wide everywhere on purpose: every table has RLS
-- on and an owner_read policy gated by is_app_owner(), so the grant is
-- the outer door and the policy is the lock. A table that should not be
-- readable at all simply has no read policy.

comment on function is_app_owner() is
  'The authorization boundary. Every owner_read, owner_write and owner_update policy calls it, so a valid session for any other Supabase user sees and touches nothing.';
