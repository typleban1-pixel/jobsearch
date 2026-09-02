-- A readable answer to "what can each role actually do".
--
-- 0007 enabled RLS and created policies by looping over pg_tables at the
-- time it ran. Every table added since then, and there are five, was
-- created outside that loop. Whether they are protected is a question the
-- system should be able to answer rather than a thing to assume, so it
-- is a function rather than a comment.

create or replace function security_audit()
returns table (
  table_name text,
  rls_enabled boolean,
  policy_count integer,
  anon_privileges text,
  authenticated_privileges text
) as $$
  select
    c.relname::text,
    c.relrowsecurity,
    (select count(*)::integer from pg_policies p
      where p.schemaname = 'public' and p.tablename = c.relname),
    coalesce((select string_agg(distinct g.privilege_type, ',' order by g.privilege_type)
       from information_schema.role_table_grants g
      where g.table_schema = 'public' and g.table_name = c.relname and g.grantee = 'anon'), 'none'),
    coalesce((select string_agg(distinct g.privilege_type, ',' order by g.privilege_type)
       from information_schema.role_table_grants g
      where g.table_schema = 'public' and g.table_name = c.relname and g.grantee = 'authenticated'), 'none')
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by c.relname;
$$ language sql stable security definer set search_path = public, information_schema, pg_catalog;

comment on function security_audit() is
  'Reports RLS state, policy count and per-role grants for every public table. Read-only and exposes no data, only the shape of access.';

revoke all on function security_audit() from public, anon;
grant execute on function security_audit() to authenticated, service_role;
