-- Relocation, as separate facts rather than one paragraph.
--
-- relocation_status held a prose blob that mixed five different things:
-- where he lives, where he is going, whether he is willing to go,
-- whether he needs help going, and when. Prose cannot answer an
-- application question, and a field that answers five questions
-- eventually answers one of them wrongly.
--
-- These are VERIFIED facts, confirmed by the user, not inferred
-- preferences. In particular the relocation is definite: he is moving,
-- not merely open to moving, and the two are different claims to an
-- employer. The date is genuinely unknown and stays null; nothing may
-- invent one.

alter table profile add column if not exists relocation_destination_city text;
alter table profile add column if not exists relocation_destination_state text;
alter table profile add column if not exists relocation_destination_metro text;
alter table profile add column if not exists relocation_is_definite boolean;
alter table profile add column if not exists relocation_date date;

-- Five new columns means five ungranted columns: 0007 replaced table-level
-- UPDATE on profile with a column list, so anything added later has no
-- grant until this is called. 0020 exists for exactly this.
select regrant_profile_columns();

alter table profile drop constraint if exists relocation_state_is_usps;
alter table profile add constraint relocation_state_is_usps
  check (relocation_destination_state is null or relocation_destination_state ~ '^[A-Z]{2}$');

-- A definite relocation has to say where to. "Definitely moving
-- somewhere" is not a fact an employer can use.
alter table profile drop constraint if exists definite_relocation_names_a_destination;
alter table profile add constraint definite_relocation_names_a_destination
  check (relocation_is_definite is not true or relocation_destination_city is not null);

comment on column profile.relocation_destination_city is
  'Where he is moving TO. Never answers a current-residence question: city/state remain where he lives now.';
comment on column profile.relocation_is_definite is
  'True when the move is planned and not contingent on an offer. Employer-facing text may then say he is relocating; it must not be softened to "open to relocation", which is a weaker and different claim.';
comment on column profile.relocation_date is
  'Null means genuinely unknown. No month, quarter or season may be inferred from anything else, and a question asking when he relocates is BLOCKED until this is set.';
comment on column profile.relocation_status is
  'Narrative background only, superseded by the structured columns above. No code reads it, and none may: an employer-facing answer comes from the field that holds that specific fact.';
comment on column profile.relocation_assistance_required is
  'False means he does not REQUIRE assistance. It is not a statement that he would decline assistance if offered, and must never be reported as one.';

update profile
   set relocation_destination_city = 'Chicago',
       relocation_destination_state = 'IL',
       relocation_destination_metro = 'Chicagoland',
       relocation_is_definite = true,
       relocation_assistance_required = false,
       relocation_date = null
 where singleton = true;

-- Recorded as a change to the truth profile, with the actor named.
insert into truth_change_log (source_table, row_id, operation, changed_fields, new_data, profile_version_at_time, actor)
select 'profile', p.id, 'UPDATE',
       array['relocation_destination_city', 'relocation_destination_state',
             'relocation_destination_metro', 'relocation_is_definite', 'relocation_assistance_required'],
       jsonb_build_object(
         'destination', 'Chicago, IL (Chicagoland)',
         'definite', true,
         'assistance_required', false,
         'relocation_date', 'UNKNOWN: not provided, must not be inferred',
         'basis', 'HUMAN_CONFIRMED: user stated current location Cleveland OH, relocating to Chicago IL, assistance not required'),
       p.profile_version, 'user:human_confirmed'
  from profile p
 where p.singleton = true;
