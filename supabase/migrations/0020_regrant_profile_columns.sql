-- Re-grant column-level UPDATE on profile after adding columns.
--
-- 0007 deliberately removed table-level UPDATE on profile and replaced it
-- with a column list built by exclusion, so that profile_version could
-- not be written by anything but bump_profile_version(). That worked, and
-- it has a consequence nobody hits until months later: a column added by
-- a later migration has no grant at all, and the write fails with
-- "permission denied for table profile".
--
-- 0019 added four columns and hit exactly that. Failing closed is the
-- right behaviour, but silently is not, so this makes the re-grant a
-- named function that any future migration touching profile can call.
create or replace function regrant_profile_columns() returns void as $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'profile'
     and column_name not in ('id', 'singleton', 'profile_version');

  execute format('grant update (%s) on public.profile to authenticated', cols);
  revoke update on public.profile from service_role;
  execute format('grant update (%s) on public.profile to service_role', cols);
end $$ language plpgsql;

comment on function regrant_profile_columns() is
  'Call after ANY migration that adds a column to profile. The exclusion list is the point: id, singleton and profile_version stay ungranted, so bump_profile_version() remains the only path to a version change.';

select regrant_profile_columns();
