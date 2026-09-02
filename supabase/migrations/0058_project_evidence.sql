-- Which evidence belongs to which project, and which of it may be shown.
--
-- Employment bullets reach a resume because the composer knows which
-- frozen rows each sentence rests on. Projects had no equivalent: the
-- RentPup line was one hard-coded sentence citing three rows chosen in
-- source, so seventeen verified RentPup statements added at v10 could
-- not be selected however relevant they were. They were not judged
-- irrelevant; they were unreachable.
--
-- The link has to be DATA rather than prose. Matching evidence to a
-- project by name was measured and fails badly: "Genius Academy" appears
-- in the detail of twenty-five rows, most of them Genius One employment
-- evidence that merely mentions the offering. A join table is also the
-- pattern this schema already uses for exactly this problem -- see
-- skill_evidence in 0001.
--
-- Two separate facts, deliberately two columns:
--
--   the link       this evidence is ABOUT this project
--   employer_facing  and it may appear on a resume
--
-- They are not the same. "RentPup has no paying customers and no
-- revenue" is unambiguously about RentPup and must never be printed; it
-- is a guardrail, and losing the link to keep it off the page would lose
-- the reason it exists.

create table if not exists project_evidence (
  project_id uuid not null references projects(id) on delete cascade,
  evidence_id uuid not null references evidence(id) on delete cascade,
  -- Opt IN. A row that nobody has judged is not printable, so forgetting
  -- to set this keeps evidence off the resume rather than onto it.
  employer_facing boolean not null default false,
  -- Why this row is or is not employer-facing, in a sentence. Read by a
  -- person reviewing the profile, never by the composer.
  note text,
  primary key (project_id, evidence_id)
);

comment on table project_evidence is
  'Which verified evidence belongs to which project. The link is a fact about the evidence; employer_facing is a separate decision about whether it may be shown. Selection still decides whether a linked, showable row is relevant enough to earn space.';
comment on column project_evidence.employer_facing is
  'False by default and on purpose: unreviewed evidence stays off the resume. True means the statement may be offered to relevance selection, never that it will appear.';

alter table project_evidence enable row level security;
drop policy if exists project_evidence_owner_read on project_evidence;
create policy project_evidence_owner_read on project_evidence
  for select to authenticated using (is_app_owner());
grant select on project_evidence to authenticated;

-- ============================================================
-- The snapshot has to carry it
-- ============================================================
--
-- A link that is not frozen is not truth: the composer would read the
-- live table while every claim cites a frozen row, and the two could
-- disagree without anything noticing. Only links whose project is
-- VERIFIED are frozen, matching how skill_evidence is filtered on
-- VERIFIED skills.
--
-- The rest of this function is byte-identical to the definition in
-- 0056. It is repeated in full because create or replace needs the whole
-- body, not because anything else changed.
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
  -- Added by 0058, and the only change from the 0056 definition. Same
  -- composite-key treatment as skill_evidence directly above: keying on
  -- evidence_id alone would collide the moment one statement is linked
  -- to two projects.
  insert into _pv_rows select 'project_evidence',
      md5(r.project_id::text || r.evidence_id::text)::uuid, to_jsonb(r)
    from project_evidence r
    where r.project_id in (select id from projects where status = 'VERIFIED');
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
  'The only supported way to advance profile_version. Bumps and freezes atomically, so an integer never exists without the truth set behind it. Includes employment_relationships as of 0056 and project_evidence as of 0058.';


-- ============================================================
-- Two facts about the person, not about the product
-- ============================================================
--
-- Every existing RentPup row states what the SYSTEM does. None states
-- what the user understands about it, and the authorship boundary
-- existed only as a clause inside other rows, so nothing could cite it
-- and nothing enumerated it.
--
-- Three facts, kept apart on the user's instruction: how it was built
-- (AI-assisted, already recorded), what he understands (row A), and what
-- he does not claim (row B). Merging any two of them is the failure this
-- pair exists to prevent.
--
-- Both are linked to RentPup and both are employer_facing = false. Row B
-- is a guardrail and can never print. Row A is interview and
-- question-bank material: as a resume bullet it would be a self-assessed
-- claim about comprehension sitting under a project, which reads as
-- compensating for something.

insert into evidence (id, polarity, summary, detail, confidence, origin, classification)
values
  ('a7f1c3e2-5b64-4d09-9c17-2e8b4f6a1d30', 'POSITIVE',
   'The user understands RentPup''s system architecture at a practical level and can explain how its major components fit together: the database, data ingestion and synchronization, property records, monitoring and change detection, application logic, scheduled jobs, APIs and integrations, notifications, and the relationship between the frontend and backend. He can trace a workflow through the system, say why a component exists, and reason about or troubleshoot it with AI assistance.',
   'CURRENT. HUMAN_CONFIRMED 2026-08-31. Three facts are recorded separately here on the user''s instruction and must never be merged into one another. IMPLEMENTATION METHOD: RentPup was built with substantial implementation assistance from Claude Code; this is AI-assisted development. ARCHITECTURE UNDERSTANDING: the understanding stated above is practical and working, sufficient to explain the system, trace a workflow through it, say why a component exists, and reason about or troubleshoot it. AUTHORSHIP BOUNDARY: the user did not personally hand-code every component, and this row must NEVER be converted into software-engineering expertise, advanced coding proficiency, independent manual implementation, or a claim of having authored the underlying code. The qualifier "with AI assistance" is part of the claim and may not be dropped. SCOPE: as with every other RentPup row, this must NOT be read as professional software engineering, engineering scale, a team, data completeness or accuracy, a number of integrated sources, unique-recipient identification, customers, revenue, traction or conversion performance.',
   'SELF_REPORTED', 'USER_RESPONSE', 'NORMAL_PERSONAL'),
  ('b3d90a15-7c42-4e8b-a561-9f0c7d2e4b88', 'VERIFIED_ABSENCE',
   'The user does not claim to have personally hand-coded RentPup''s full implementation and does not claim traditional backend or software-engineering expertise. RentPup was built through AI-assisted development, and this boundary must not be interpreted as evidence of missing product, systems, implementation, troubleshooting, or architecture-understanding capability.',
   'Confirmed 2026-08-31 as a HUMAN_CONFIRMED boundary, worded by the user. It exists so the limit is a fact in its own right rather than only a clause inside other rows: no generated text may describe the user as a backend engineer, a software engineer, or the author of RentPup''s code, and no claim may imply independent manual implementation. SCOPE: this is a restriction on what may be CLAIMED, not evidence of missing capability. It must never reduce Fit, and it must never be read as a weakness in what the build itself demonstrates.',
   'SELF_REPORTED', 'USER_RESPONSE', 'NORMAL_PERSONAL')
on conflict (id) do nothing;

insert into truth_change_log (source_table, row_id, operation, changed_fields, new_data, profile_version_at_time, actor)
select 'evidence', r.id, 'INSERT',
       array['summary', 'detail', 'polarity'],
       jsonb_build_object(
         'summary', r.summary,
         'polarity', r.polarity,
         'basis', 'HUMAN_CONFIRMED 2026-08-31: implementation method, architecture understanding and authorship boundary recorded as three separate facts.'),
       p.profile_version, 'user:human_confirmed'
  from evidence r, profile p
 where r.id in ('a7f1c3e2-5b64-4d09-9c17-2e8b4f6a1d30', 'b3d90a15-7c42-4e8b-a561-9f0c7d2e4b88')
   and p.singleton = true;

-- ============================================================
-- The RentPup links
-- ============================================================
--
-- Every RentPup statement in the profile, linked. Seventeen are
-- employer-facing; six are linked and permanently unprintable, and the
-- note on each says why. Nothing here decides that a statement WILL
-- appear: relevance selection still has to want it, and on a posting
-- with thin themes most of these score zero and are dropped.
insert into project_evidence (project_id, evidence_id, employer_facing, note) values
  ((select id from projects where name = 'RentPup'), '02527049-c006-4c13-9dc5-99eb04f75843', true,
   'CURRENT. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), '11b14acb-6bdb-4963-8c8d-4dfb2751a59f', true,
   'CURRENT. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), '16065bd0-0951-4852-8185-0f20d20867a4', true,
   'CURRENT. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), '2144e9ee-d587-4671-8df0-0608dd65e0e5', true,
   'CURRENT. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), '37bda77e-a98b-4006-89c3-849c6d6bbe76', true,
   'BUILT_BUT_PAUSED. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), '38893886-5108-4cc7-b1f4-e4fb9fcc5c27', true,
   'CURRENT. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), '3db030b5-a353-41e9-8f97-d52c51178725', true,
   'CURRENT. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), '50961399-16b0-47c5-8f5c-a363f3263ab6', true,
   'CURRENT. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), '510b9d43-6115-49a3-a684-d3afdbcf8b4e', true,
   'PARTIAL. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), '5b9870b5-4f44-4d20-b08d-3333dc6f5b74', true,
   'CURRENT. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), '61ad6f2a-e19e-4af2-b71f-d9d77cd6120c', true,
   'CURRENT. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), '8d2632b7-8b8f-4ca7-b778-916da77846f0', true,
   'CURRENT. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), '8daaeff6-f5f8-438a-ae38-be68f10bd5c3', true,
   'CURRENT. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), 'ab00441b-4f0c-4745-b592-5410ece0308d', true,
   'CURRENT. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), 'c2c7a21c-d06e-479e-914e-7fcaf6932f96', true,
   'CURRENT. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), 'c6a7bc65-6e1a-4c47-9010-86f775955e08', true,
   'CURRENT. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), 'd2ead871-961f-4e99-a08b-77e4f5e19389', true,
   'CONDITIONAL. Added at v10 from the repository and database audit.'),
  ((select id from projects where name = 'RentPup'), 'd66fd8cd-207d-4525-8578-fa93e4184c93', false,
   'True, and not printable as written. The summary reads "a direct-mail measurement and attribution system FOR RentPup", which the RentPup-employment claim guard refuses because it reads as having been employed by RentPup. Left unshowable rather than reworded: the statement is evidence and evidence does not get edited to fit a resume. If this work should appear, it needs its own approved employer-facing wording.'),
  ((select id from projects where name = 'RentPup'), '6ce1d8db-bdc7-4a82-becd-a221e8cd76b4', false,
   'Not employer-facing because the project''s own description line is composed from it. Offering it again would restate the paragraph directly above it.'),
  ((select id from projects where name = 'RentPup'), '0aa19e95-0fc6-4796-b1aa-f1348480b648', false,
   'A guardrail, not an accomplishment. Linked so the constraint stays attached to the project; never printable.'),
  ((select id from projects where name = 'RentPup'), '0b27a612-e080-4db1-b4f8-cc8924114404', false,
   'States what the project is evidence OF. A claim about the evidence rather than about the work, so it is not a resume sentence.')
,
  ((select id from projects where name = 'RentPup'), 'a7f1c3e2-5b64-4d09-9c17-2e8b4f6a1d30', false,
   'Architecture understanding. Available to question answering and interview reasoning, deliberately not employer-facing: as a resume bullet it would be a self-assessed claim about comprehension, and it must never read as software-engineering proficiency.'),
  ((select id from projects where name = 'RentPup'), 'b3d90a15-7c42-4e8b-a561-9f0c7d2e4b88', false,
   'Authorship boundary. A restriction on what may be claimed, never printable, and never a reduction in Fit. Linked so the limit stays attached to the project it bounds.')
on conflict (project_id, evidence_id) do nothing;

-- 23 links: 17 employer-facing, 6 linked but never printable
