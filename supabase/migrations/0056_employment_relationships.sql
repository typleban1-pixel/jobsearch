-- What the record knows, and what the resume says, kept apart.
--
-- The granular employment records are right: Genius One appears twice,
-- 2019 to 2022 and 2024 to present, because those are the periods the
-- evidence was gathered for. Rendered literally, they say something
-- false. A recruiter reads two separate engagements with a two-year
-- break, when the relationship never stopped: the workload changed, and
-- during 2022 to 2024 it ran alongside a full-time job at Holley.
--
-- The wrong fix is to edit the records. They are the truth, they carry
-- the evidence, and rewriting history to improve a resume is the thing
-- this system exists to prevent. The right fix is a second, explicit
-- layer that says: these periods are one continuous relationship, and
-- here is who confirmed that.
--
-- Continuity is therefore never derived. Not from matching employer
-- names, not from matching titles, not from periods sitting close
-- together, and above all not from the fact that joining them would
-- remove a gap. It exists only where a person stated it, and the
-- statement is stored with the span it authorizes.

do $$ begin
  create type workload_pattern as enum (
    -- Intensity varied over the relationship, in ways not recorded per
    -- period. Says nothing about hours, because nothing established them.
    'VARIABLE',
    'CONSISTENT_PART_TIME',
    'CONSISTENT_FULL_TIME',
    'UNKNOWN'
  );
exception when duplicate_object then null; end $$;

create table if not exists employment_relationships (
  id uuid primary key default uuid_generate_v4(),
  employer text not null,

  -- What the resume shows for the whole relationship. One title, chosen
  -- deliberately, rather than whichever stint happened to be rendered.
  display_title text not null,
  location text,

  -- The short, conventional label that makes the shape of the
  -- relationship legible: 'Contract', 'Part-Time Contract'. Null for
  -- ordinary full-time employment, which needs no explanation and looks
  -- defensive when it gets one.
  employer_facing_qualifier text
    check (employer_facing_qualifier is null
        or employer_facing_qualifier in ('Contract', 'Part-Time Contract', 'Freelance', 'Seasonal')),

  -- The span the resume may show. Constrained by trigger to the outer
  -- bounds of the records it consolidates: a relationship may bridge a
  -- gap BETWEEN verified periods, and may never reach past them.
  relationship_start date not null,
  relationship_end date,
  start_precision date_precision not null default 'YEAR',
  end_precision date_precision not null default 'YEAR',

  employment_type employment_type not null,
  -- Duration and intensity are different facts and are modelled apart.
  -- Nothing here records hours per week or an FTE percentage, because
  -- nothing established them and a resume must not imply either.
  workload workload_pattern not null default 'UNKNOWN',

  -- The granular records this consolidates. They are not modified, not
  -- merged and not deleted; this names them.
  covered_record_ids uuid[] not null check (array_length(covered_record_ids, 1) >= 1),

  -- Provenance for the continuity claim itself, which is the whole
  -- reason this table can exist without weakening anything.
  continuity_basis text not null check (length(btrim(continuity_basis)) > 20),
  confirmed_by text not null check (confirmed_by like 'user:%'),
  confirmed_at timestamptz not null default now(),

  created_at timestamptz not null default now(),

  constraint relationship_end_after_start
    check (relationship_end is null or relationship_end >= relationship_start),
  -- One authoritative relationship per employer. A second would make
  -- "which span is authorized" a question with two answers.
  constraint relationship_one_per_employer unique (employer)
);

comment on table employment_relationships is
  'An explicitly confirmed continuous relationship with one organization, authorizing a single employer-facing span across several granular employment records. Continuity is never inferred: matching employer names, matching titles, adjacent periods, a later return to the same company, and the fact that joining periods would close a gap are all insufficient on their own and in combination.';
comment on column employment_relationships.covered_record_ids is
  'The employment_records this consolidates for display. Those rows are untouched: they remain the granular truth, keep their own evidence and provenance, and are what every claim still cites.';
comment on column employment_relationships.workload is
  'Intensity, modelled separately from duration. VARIABLE means it changed over time and nothing more; it never implies hours per week, an FTE percentage, or which periods were which.';
comment on column employment_relationships.employer_facing_qualifier is
  'The short label shown beside the title. Null for conventional full-time employment, which reads as normal without explanation. Never a sentence: the resume states the shape of the relationship and does not defend it.';
comment on column employment_relationships.continuity_basis is
  'Why continuity is believed, in words, naming who said so. This is the authorization for a consolidated span, and without it the granular records render separately.';

-- ============================================================
-- The span cannot exceed what the records verify
-- ============================================================

-- A relationship may bridge a gap between two verified periods, because
-- that is exactly the fact being confirmed. It may not begin earlier
-- than the earliest period, end later than the latest, claim to be
-- ongoing when no covered period is, or state a precision the records do
-- not have. Those would be inventing employment rather than describing
-- a relationship across employment already recorded.
create or replace function relationship_within_verified_span() returns trigger as $$
declare
  v_min_start date;
  v_max_end   date;
  v_any_current boolean;
  v_count int;
  v_bad_employer int;
  v_start_prec date_precision;
  v_end_prec date_precision;
begin
  select count(*), min(start_month), max(end_month), bool_or(is_current),
         count(*) filter (where employer is distinct from new.employer)
    into v_count, v_min_start, v_max_end, v_any_current, v_bad_employer
    from employment_records
   where id = any (new.covered_record_ids)
     and status = 'VERIFIED';

  if v_count <> coalesce(array_length(new.covered_record_ids, 1), 0) then
    raise exception 'a relationship may only consolidate VERIFIED employment records that exist';
  end if;
  if v_bad_employer > 0 then
    raise exception 'a relationship consolidates records for one employer; % of them name a different one', v_bad_employer;
  end if;

  if new.relationship_start <> v_min_start then
    raise exception 'the relationship starts % but the earliest verified record starts %; a relationship never begins before the employment it consolidates',
      new.relationship_start, v_min_start;
  end if;

  if v_any_current then
    if new.relationship_end is not null then
      raise exception 'a covered record is current, so the relationship is ongoing and cannot state an end date';
    end if;
  else
    if new.relationship_end is null then
      raise exception 'no covered record is current, so the relationship is not ongoing and needs its verified end date';
    end if;
    if new.relationship_end <> v_max_end then
      raise exception 'the relationship ends % but the latest verified record ends %; dates are never extended',
        new.relationship_end, v_max_end;
    end if;
  end if;

  -- Precision is a claim about what is known. A relationship inherits it
  -- and cannot sharpen it.
  select start_precision into v_start_prec from employment_records
   where id = any (new.covered_record_ids) order by start_month limit 1;
  select end_precision into v_end_prec from employment_records
   where id = any (new.covered_record_ids) order by start_month desc limit 1;

  if new.start_precision <> v_start_prec or (v_end_prec is not null and new.end_precision <> v_end_prec) then
    raise exception 'the relationship states % / % precision but the records state % / %; precision is never upgraded',
      new.start_precision, new.end_precision, v_start_prec, v_end_prec;
  end if;

  return new;
end $$ language plpgsql;

drop trigger if exists relationships_within_verified_span on employment_relationships;
create trigger relationships_within_verified_span
  before insert or update on employment_relationships
  for each row execute function relationship_within_verified_span();

-- ============================================================
-- Frozen with everything else
-- ============================================================

-- A relationship is part of the truth profile, so it is snapshotted into
-- profile versions alongside the records it consolidates. Without this a
-- prepared resume would read relationships that no version records.
create or replace function bump_profile_version(p_reason text)
returns integer as $$
declare v integer;
begin
  -- Next version comes from the registry, never from the column being
  -- written. If the counter were ever moved by hand, incrementing it
  -- would silently reuse a version number that already has a different
  -- truth set frozen under it.
  select coalesce(max(version), 0) + 1 into v from profile_versions;

  update profile set profile_version = v, updated_at = now() where singleton;

  if not found then
    raise exception 'bump_profile_version: no profile row exists yet';
  end if;

  -- Gathered first, so the version row can be written with its hash and
  -- count already final. profile_versions is append-only under the
  -- guards in 0007, which means there is no second pass to fill them in.
  drop table if exists _pv_rows;
  create temp table _pv_rows (source_table text, row_id uuid, row_data jsonb)
    on commit drop;

  insert into _pv_rows select 'profile', id, to_jsonb(r) from profile r;
  insert into _pv_rows select 'location_preferences', id, to_jsonb(r) from location_preferences r;
  insert into _pv_rows select 'work_preferences', id, to_jsonb(r) from work_preferences r;
  insert into _pv_rows select 'evidence', id, to_jsonb(r) from evidence r;
  insert into _pv_rows select 'employment_records', id, to_jsonb(r) from employment_records r
    where r.status = 'VERIFIED';
  -- Added by 0056. A relationship authorizes an employer-facing span, so
  -- it belongs to the frozen truth exactly as the records it consolidates
  -- do. Everything else in this function is unchanged from 0001,
  -- deliberately: the row set and the hash define what a version MEANS,
  -- and rewriting them here would silently redefine every future version.
  insert into _pv_rows select 'employment_relationships', id, to_jsonb(r) from employment_relationships r;
  insert into _pv_rows select 'projects', id, to_jsonb(r) from projects r
    where r.status = 'VERIFIED';
  insert into _pv_rows select 'education', id, to_jsonb(r) from education r
    where r.status = 'VERIFIED';
  insert into _pv_rows select 'skills', id, to_jsonb(r) from skills r
    where r.status = 'VERIFIED';
  -- skill_evidence has a composite key and no id column, so the frozen
  -- row_id is derived from both halves. Keying on skill_id alone would
  -- collide for any skill backed by more than one piece of evidence.
  insert into _pv_rows select 'skill_evidence',
      md5(r.skill_id::text || r.evidence_id::text)::uuid, to_jsonb(r)
    from skill_evidence r
    where r.skill_id in (select id from skills where status = 'VERIFIED');
  -- Only approved metrics. An unapproved metric was never usable, so it
  -- was never part of the truth that produced a score.
  insert into _pv_rows select 'metrics', id, to_jsonb(r) from metrics r
    where r.approved_for_use;
  insert into _pv_rows select 'question_bank', id, to_jsonb(r) from question_bank r
    where r.approved_answer is not null;

  insert into profile_versions (version, reason, row_count, truth_hash)
  select v, p_reason, count(*),
         md5(coalesce(string_agg(row_data::text, '|' order by source_table, row_id), ''))
  from _pv_rows;

  insert into profile_version_rows (profile_version, source_table, row_id, row_data)
  select v, source_table, row_id, row_data from _pv_rows;

  drop table _pv_rows;
  return v;
end $$ language plpgsql security definer set search_path = public;

comment on function bump_profile_version(text) is
  'The only supported way to advance profile_version. Bumps and freezes atomically, so an integer never exists without the truth set behind it. Includes employment_relationships as of 0056.';

-- ============================================================
-- The confirmed relationships
-- ============================================================

-- Genius One: continuous since 2019, contract throughout, workload
-- varying from roughly full-time to very part-time, and running
-- alongside other employment for part of it. The two granular records
-- stay exactly as they are.
insert into employment_relationships
  (employer, display_title, location, employer_facing_qualifier,
   relationship_start, relationship_end, employment_type, workload,
   covered_record_ids, continuity_basis, confirmed_by)
select
  'Genius One, Inc.',
  'Digital Marketing, Product & Operations Specialist',
  'Highland Heights, OH',
  'Contract',
  min(start_month), null, 'CONTRACT', 'VARIABLE',
  array_agg(id order by start_month),
  'HUMAN_CONFIRMED: the user stated the working relationship with Genius One has been continuous from 2019 to present, contract throughout, with workload varying from approximately full-time to extremely part-time, and continuing during periods of other employment.',
  'user:human_confirmed'
  from employment_records
 where employer = 'Genius One, Inc.' and status = 'VERIFIED'
on conflict (employer) do nothing;

-- Anytime Picture: continuous 2019 to 2025, part-time contract
-- throughout, also running alongside other employment.
insert into employment_relationships
  (employer, display_title, location, employer_facing_qualifier,
   relationship_start, relationship_end, employment_type, workload,
   covered_record_ids, continuity_basis, confirmed_by)
select
  'Anytime Picture LLC',
  'Video Production & Client Solutions Specialist',
  'Cleveland, OH',
  'Part-Time Contract',
  min(start_month), max(end_month), 'CONTRACT', 'CONSISTENT_PART_TIME',
  array_agg(id order by start_month),
  'HUMAN_CONFIRMED: the user stated the working relationship with Anytime Picture was continuous from 2019 to 2025, part-time contract throughout, and continued during periods of other employment.',
  'user:human_confirmed'
  from employment_records
 where employer = 'Anytime Picture LLC' and status = 'VERIFIED'
on conflict (employer) do nothing;

-- Holley is deliberately absent. It is one period of conventional
-- full-time employment with nothing to consolidate and nothing to
-- explain, and giving it a qualifier would make ordinary employment look
-- like it needed defending.

insert into truth_change_log (source_table, row_id, operation, changed_fields, new_data, profile_version_at_time, actor)
select 'employment_relationships', r.id, 'INSERT',
       array['employer', 'relationship_start', 'relationship_end', 'employment_type', 'workload'],
       jsonb_build_object(
         'employer', r.employer,
         'span', concat(to_char(r.relationship_start, 'YYYY'), ' to ',
                        coalesce(to_char(r.relationship_end, 'YYYY'), 'present')),
         'qualifier', r.employer_facing_qualifier,
         'workload', r.workload,
         'basis', r.continuity_basis,
         'granular_records_unchanged', array_length(r.covered_record_ids, 1)),
       p.profile_version, 'user:human_confirmed'
  from employment_relationships r, profile p
 where p.singleton = true;
