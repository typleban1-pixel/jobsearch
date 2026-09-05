-- A read-only helper so application code can ask the live database which values
-- an enum actually accepts, WITHOUT a direct SQL connection. The extraction
-- batch uses it as a preflight: before spending a cent on the model it verifies
-- that every requirement kind it can emit is already accepted by the DB enum,
-- so a code-vs-schema drift (exactly the RESPONSIBILITY incident) fails fast and
-- free instead of after the paid call, at persistence.
--
-- Returns the enum's labels in definition order. SECURITY INVOKER; only reads
-- catalog metadata; safe to expose to the anon/auth roles.
create or replace function enum_values(enum_type text)
returns setof text
language sql
stable
as $$
  select e.enumlabel
  from pg_enum e
  join pg_type t on t.oid = e.enumtypid
  where t.typname = enum_type
  order by e.enumsortorder;
$$;

comment on function enum_values(text) is
  'Labels accepted by an enum type, in definition order. Used as a pre-flight so paid batch work can verify code/schema compatibility before spending.';
