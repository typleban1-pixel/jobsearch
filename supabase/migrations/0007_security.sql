-- Append-only enforcement, RLS, and role separation.
--
-- Runs last because it grants and guards across every table.
--
-- Why three layers rather than one:
--
--   GRANTS decide what a role may attempt. They are the cheapest and
--   coarsest control, and they are what keeps the browser away from
--   tables it has no business touching at all.
--
--   RLS decides which rows a role may see. Useful here mainly as a
--   default-deny backstop, since this is a single-user system.
--
--   TRIGGERS decide what may be changed, and they are the only layer
--   that binds the worker. Supabase's service_role carries BYPASSRLS,
--   so RLS alone cannot make anything append-only for the process that
--   does the writing. A trigger fires regardless of role.
--
-- The tradeoff of triggers is that they also bind legitimate
-- maintenance: a backfill, a correction, a genuine deletion. Rather than
-- leave a silent superuser hole, there is one explicit escape:
--
--   set local app.allow_history_mutation = 'on';
--
-- LOCAL, so it dies with the transaction. It cannot be set from
-- PostgREST, so no portal or worker request can turn it on: it takes a
-- direct database session, which means a person. History being hard to
-- rewrite, not impossible, is the honest goal. Impossible would just
-- mean the escape hatch lives somewhere undocumented.

-- ============================================================
-- Guards
-- ============================================================

create or replace function history_guard() returns trigger as $$
declare
  allowed    text[] := coalesce(tg_argv[0]::text[], '{}');
  null_only  text[] := coalesce(tg_argv[1]::text[], '{}');
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  k text;
begin
  if coalesce(current_setting('app.allow_history_mutation', true), 'off') = 'on' then
    return new;
  end if;

  for k in select jsonb_object_keys(o) loop
    if (o -> k) is distinct from (n -> k) then
      if k = any(allowed) then
        continue;
      elsif k = any(null_only) then
        -- Pruning a large payload is allowed. Replacing it is not.
        if jsonb_typeof(n -> k) <> 'null' then
          raise exception '%.% may only be cleared, never rewritten', tg_table_name, k
            using hint = 'Pruning sets the column to null and stamps the pruned_at column.';
        end if;
        continue;
      end if;
      raise exception '%.% is immutable history (attempted change to "%")',
        tg_table_schema, tg_table_name, k
        using hint = 'Insert a corrective row instead. Deliberate maintenance requires: set local app.allow_history_mutation = ''on'';';
    end if;
  end loop;
  return new;
end $$ language plpgsql;

create or replace function history_no_delete() returns trigger as $$
begin
  if coalesce(current_setting('app.allow_history_mutation', true), 'off') = 'on' then
    return old;
  end if;
  raise exception 'rows in % are historical record and cannot be deleted', tg_table_name
    using hint = 'Supersede it with a newer row. Deliberate maintenance requires: set local app.allow_history_mutation = ''on'';';
end $$ language plpgsql;

comment on function history_guard() is
  'Argument 0: columns that may change. Argument 1: columns that may only be set to null (payload pruning). Everything else is frozen.';

-- Fully immutable: nothing about these rows may change, ever.
do $$
declare t text;
begin
  foreach t in array array[
    'job_score_snapshots','job_changes','application_events','truth_change_log',
    'profile_version_rows','profile_versions','llm_calls','scoring_weight_changes',
    'ingest_run_companies'
  ] loop
    execute format(
      'create trigger %I before update on %I for each row execute function history_guard(''{}'', ''{}'')',
      t || '_immutable', t);
    execute format(
      'create trigger %I before delete on %I for each row execute function history_no_delete()',
      t || '_no_delete', t);
  end loop;
end $$;

-- Supersede-only: the record of what was observed is frozen, but the
-- flag saying whether it is still the operative row may move.
create trigger source_observations_immutable before update on source_observations
  for each row execute function history_guard(
    '{is_resolved_value,superseded_at,resolution_note}', '{}');
create trigger source_observations_no_delete before delete on source_observations
  for each row execute function history_no_delete();

-- The wording a source used is frozen; which intent it maps to is not.
-- Re-mapping an occurrence to a better intent is a legitimate correction,
-- and question_bank's ON DELETE SET NULL needs the same room.
create trigger question_occurrences_immutable before update on question_occurrences
  for each row execute function history_guard(
    '{question_bank_id,matched_confidence,matched_by}', '{}');
create trigger question_occurrences_no_delete before delete on question_occurrences
  for each row execute function history_no_delete();

create trigger job_versions_immutable before update on job_versions
  for each row execute function history_guard('{is_current}', '{}');
create trigger job_versions_no_delete before delete on job_versions
  for each row execute function history_no_delete();

create trigger job_extractions_immutable before update on job_extractions
  for each row execute function history_guard('{superseded_by}', '{}');
create trigger job_extractions_no_delete before delete on job_extractions
  for each row execute function history_no_delete();

-- Payload tables: retention bookkeeping may change and the payload
-- itself may be dropped, but nothing may be rewritten in place.
create trigger job_raw_payloads_immutable before update on job_raw_payloads
  for each row execute function history_guard(
    '{raw_fragment_pruned_at,retain_until,retention_reason,job_version_id}', '{raw_fragment}');
create trigger job_raw_payloads_no_delete before delete on job_raw_payloads
  for each row execute function history_no_delete();

create trigger source_fetches_immutable before update on source_fetches
  for each row execute function history_guard(
    '{raw_body_retained,raw_body_pruned_at,retain_until,retention_reason}', '{raw_body}');
create trigger source_fetches_no_delete before delete on source_fetches
  for each row execute function history_no_delete();

comment on trigger job_raw_payloads_immutable on job_raw_payloads is
  'job_version_id is writable because it is backfilled moments after insert, once the version row it describes exists. Everything the source actually said is frozen.';

-- ============================================================
-- Who this system belongs to
-- ============================================================

-- Single user, so the tenancy model is one row, not a tenant column on
-- forty-three tables. This is the whole of the multi-tenancy design and
-- is meant to stay that way.
create table app_owner (
  user_id uuid primary key,
  email text not null,
  added_at timestamptz not null default now()
);

-- SECURITY DEFINER matters here: app_owner is itself under RLS, and a
-- policy that had to call a function that read the table through that
-- same policy would never resolve. The function runs as the table owner,
-- which is not subject to RLS, so the check terminates.
comment on table app_owner is
  'Authenticated requests are checked against this table. Empty until the single account is created, and an empty table means the portal can read nothing, which is the correct default for a system holding one person''s employment history.';

create or replace function is_app_owner() returns boolean as $$
  select exists (select 1 from app_owner where user_id = auth.uid());
$$ language sql stable security definer set search_path = public;

-- ============================================================
-- RLS
-- ============================================================

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Read: the owner sees everything. Nothing here is public, and there is
-- no anonymous path to any row.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format(
      'create policy owner_read on public.%I for select to authenticated using (is_app_owner())', t);
  end loop;
end $$;

-- Write: only the tables a person actually edits from a browser. Every
-- other table is written by the worker, which does not use RLS.
do $$
declare t text;
begin
  foreach t in array array[
    'profile','location_preferences','work_preferences','evidence',
    'employment_records','metrics','projects','education','skills',
    'skill_evidence','suggested_skills','question_bank','resumes',
    'resume_claims','applications','application_answers','scoring_weights',
    'company_sources','app_owner'
  ] loop
    execute format(
      'create policy owner_write on public.%I for insert to authenticated with check (is_app_owner())', t);
    execute format(
      'create policy owner_update on public.%I for update to authenticated using (is_app_owner()) with check (is_app_owner())', t);
  end loop;
end $$;

create policy owner_update_companies on public.companies
  for update to authenticated using (is_app_owner()) with check (is_app_owner());

-- ============================================================
-- Grants
-- ============================================================

-- anon: nothing. Not a public product, and there is no page that should
-- render without a session.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
revoke usage on schema public from anon;

-- authenticated: the portal, running in a browser with the publishable
-- key. Reads widely, writes narrowly, deletes nothing anywhere.
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'location_preferences','work_preferences','evidence',
    'employment_records','metrics','projects','education','skills',
    'skill_evidence','suggested_skills','question_bank','resumes',
    'resume_claims','applications','application_answers','scoring_weights',
    'company_sources','app_owner'
  ] loop
    execute format('grant insert, update on public.%I to authenticated', t);
  end loop;
end $$;

grant insert on public.profile to authenticated;

-- Column-level, because the portal legitimately re-prioritizes a company
-- but must never edit a company's observed facts.
grant update (watchlist, priority_score, priority_reason, notes) on companies to authenticated;

-- No DELETE is granted to the portal on any table. Records are
-- deactivated (record_status), archived (job_status) or superseded.
-- A person retiring a fact should not be able to erase that it was ever
-- believed.

-- service_role: the worker, server side only. Carries BYPASSRLS, so the
-- append-only triggers above are the real constraint on it.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Both roles inherit the guards; neither can turn them off, because
-- app.allow_history_mutation is not settable through PostgREST.
grant execute on function bump_profile_version(text) to authenticated, service_role;
revoke all on function assert_profile_version_snapshot() from public, anon, authenticated;
grant execute on function is_app_owner() to authenticated, service_role;

revoke all on function history_guard() from public, anon, authenticated;
revoke all on function history_no_delete() from public, anon, authenticated;
revoke all on function log_truth_change() from public, anon, authenticated;

alter default privileges in schema public grant select on tables to authenticated;
alter default privileges in schema public grant all on tables to service_role;

-- ============================================================
-- profile.profile_version is not writable by anyone but the function
-- ============================================================

-- Deliberately the LAST grant in this file. An earlier position would be
-- undone by the blanket service_role grant above, which is exactly the
-- kind of silent restoration that makes a column look protected when it
-- is not.
--
-- Column-level grants must be the ONLY update grant on profile. A
-- table-level GRANT UPDATE cannot be narrowed afterwards: Postgres will
-- warn and leave the broad privilege in place, which is a quiet way to
-- believe a column is protected when it is not. So the column list is
-- built by exclusion and granted directly, and service_role's blanket
-- grant is revoked before its column grant is issued.
--
-- id and singleton are excluded for the same reason as profile_version:
-- they are identity, not data.
do $$
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
end $$;

-- The portal and the worker now cannot name profile_version in an UPDATE
-- at all: PostgREST is refused before a row is touched. bump_profile_version
-- is SECURITY DEFINER and owned by the table owner, so it is unaffected.
-- A direct psql session as the owner still can, and is then caught at
-- commit by profile_version_requires_snapshot, which no role can bypass.

-- job_provenance would otherwise run with its owner's rights and read
-- straight past RLS. Invoker rights keep the view honest.
alter view job_provenance set (security_invoker = on);

-- ============================================================
-- Secrets
-- ============================================================

-- There is no credentials table in this schema and there is not meant to
-- be one. API keys, ATS passwords and browser session cookies live in the
-- worker's environment and in the OS keychain, never in Postgres, because
-- anything in Postgres is one bad SELECT grant away from a browser.
--
-- The columns that must never enter a prompt, a log, a frontend payload
-- or an audit trail are registered in data_classifications. The LLM
-- boundary reads that table before building any prompt; it is not a
-- convention held in someone's head.
--
-- llm_calls stores tier, purpose, token counts and cost. It deliberately
-- has no prompt or response column, so no future logging change can start
-- writing profile data into an analytics table.

comment on schema public is
  'Single-user job search system. No credentials are stored in this database. anon has no access. authenticated is the portal and cannot delete. service_role is the worker and is bound by triggers, not by RLS.';
