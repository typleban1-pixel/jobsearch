-- How long the user has done a specific thing, when he has said so.
--
-- Duration has never been recordable. skills has no year columns, all
-- 161 evidence rows carry null occurred_start and occurred_end, and
-- skill_evidence is empty, so the only dates in the profile belong to
-- employment records. A posting asking for "5+ years of experience
-- creating and executing search engine optimization strategies" could
-- therefore never be answered, and the system correctly refused to
-- answer it: EXPERIENCED is a level, not a length, and reading years out
-- of an employment span assumes every year of a job was spent on the one
-- capability the posting cares about.
--
-- This is the missing fact, and its provenance is the whole point. The
-- user is the source. He is authoritative about his own history, which
-- makes this HUMAN_CONFIRMED and USER_RESPONSE, and it is not evidence
-- of the kind a resume line cites. Nothing here is dated, because
-- putting invented dates on his work to make a number computable would
-- be fabricating the record rather than recording what he said.
--
-- Deliberately its own table rather than a row in evidence. An evidence
-- row is eligible for resume selection, and "six years of SEO" appearing
-- on a resume because it was stored somewhere convenient is exactly the
-- kind of silent claim this project exists to prevent. A duration lives
-- here, is read when a requirement asks for years, and can never be
-- selected into an employer-facing document.

create table if not exists capability_durations (
  id uuid primary key default uuid_generate_v4(),

  -- The capability this is about, named exactly. capability_relations
  -- already keys on skill names, and this follows it.
  capability text not null,
  skill_id uuid references skills(id) on delete restrict,

  years numeric not null check (years > 0 and years <= 60),

  -- Always these two values. A duration the user states is confirmed by
  -- him and sourced from him; there is no other way for a row to get
  -- here, and the constraints say so rather than trusting the writer.
  confidence text not null default 'HUMAN_CONFIRMED'
    check (confidence = 'HUMAN_CONFIRMED'),
  provenance provenance_kind not null default 'USER_RESPONSE'
    check (provenance = 'USER_RESPONSE'),

  -- What the number covers, in the user's own framing, so a later reader
  -- can tell whether a requirement is genuinely about this capability.
  scope_note text not null,
  -- Capabilities this duration must NOT be read as covering. Adjacency
  -- is not equivalence: six years of SEO is not six years of paid
  -- search, and a system that treats neighbouring disciplines as the
  -- same one will overstate him on exactly the postings that check.
  excludes text[] not null default '{}',

  stated_on date not null,
  created_at timestamptz not null default now(),

  -- One standing duration per capability. A revised figure replaces the
  -- old one rather than accumulating, and the history of what he said
  -- when lives in truth_change_log.
  constraint capability_durations_one_per_capability unique (capability)
);

comment on table capability_durations is
  'How long the user has practised a named capability, as he stated it. HUMAN_CONFIRMED and USER_RESPONSE by construction: he is the source and there is no evidence row behind it. Read when a requirement asks for years; never selectable into an employer-facing document, which is why it is not stored as evidence.';
comment on column capability_durations.years is
  'Years of experience with this capability and nothing adjacent to it. Satisfies a requirement asking for this many years or fewer, and only where the requirement is genuinely about this capability.';
comment on column capability_durations.excludes is
  'Capabilities this figure may never be read as covering. Stated explicitly because the failure mode is silent: an SEO duration quietly answering a paid-search or AEO requirement overstates him where it matters most.';
comment on column capability_durations.scope_note is
  'What the user meant by the figure, in his framing. A requirement whose occupational object falls outside this note is not satisfied by this row.';

alter table capability_durations enable row level security;
drop policy if exists capability_durations_owner_read on capability_durations;
create policy capability_durations_owner_read on capability_durations
  for select to authenticated using (is_app_owner());
grant select on capability_durations to authenticated;

-- Included in the frozen profile, so a resume or a candidacy verdict can
-- always say which stated durations it was computed against.
-- (profile_version_rows is populated by bump_profile_version; adding the
-- table to its source list is a code change, not a schema one.)
