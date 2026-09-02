-- The calling country of the verified phone number.
--
-- Added because a Greenhouse application form carries a required control
-- labelled simply "Country" whose options read "Poland +48", "United
-- States +1". A behavioural probe settled what it is: selecting an
-- option changes the phone widget's country. It is the phone's calling
-- country, not a residence field, despite the label.
--
-- The profile could not answer it. `country` is where he LIVES, and
-- `phone` is "210-577-4548" with no international prefix. Answering a
-- calling-country control from a residence country is a guess that
-- happens to be right for this person and would be silently wrong for
-- anyone who has moved, kept a foreign number, or carries two.
--
-- So this is its own field, and it is confirmed rather than derived.
-- There is deliberately no rule anywhere that residence implies calling
-- country, and none that reads a calling country out of an unprefixed
-- national number.

alter table profile add column if not exists phone_country text;
alter table profile add column if not exists phone_e164 text;

alter table profile drop constraint if exists phone_country_is_iso3166;
alter table profile add constraint phone_country_is_iso3166
  check (phone_country is null or phone_country ~ '^[A-Z]{2}$');

-- E.164: a plus, a non-zero country code, up to fifteen digits total.
alter table profile drop constraint if exists phone_e164_is_canonical;
alter table profile add constraint phone_e164_is_canonical
  check (phone_e164 is null or phone_e164 ~ '^\+[1-9]\d{6,14}$');

comment on column profile.phone_country is
  'ISO 3166-1 alpha-2 calling country of the verified phone number. Set ONLY from user-confirmed information. Never inferred from the residence country, never read out of an unprefixed national number, and never defaulted. Null means nobody has confirmed it, which is a blocked field rather than a guess.';
comment on column profile.phone_e164 is
  'The verified phone number in canonical E.164 form, composed from the confirmed calling country and the verified national number. The display number in profile.phone is kept as-is, because some forms want the national format.';

-- Confirmed by the user, 31 Aug 2026: the calling country of the
-- verified number is the United States. phone_e164 follows
-- deterministically from that confirmation plus the already-verified
-- national number; it is a transcription, not a second claim.
update profile
   set phone_country = 'US',
       phone_e164 = '+1' || regexp_replace(phone, '\D', '', 'g')
 where singleton = true
   and phone is not null
   and phone_country is null;

-- Recorded as a change to the truth profile, with the actor named, so
-- the provenance of a field that may end up on an employer's form is
-- inspectable rather than folklore.
insert into truth_change_log (source_table, row_id, operation, changed_fields, new_data, profile_version_at_time, actor)
select 'profile', p.id, 'UPDATE', array['phone_country', 'phone_e164'],
       jsonb_build_object('phone_country', p.phone_country, 'phone_e164', p.phone_e164,
                          'basis', 'HUMAN_CONFIRMED: user stated the calling country is US'),
       p.profile_version, 'user:human_confirmed'
  from profile p
 where p.singleton = true and p.phone_country is not null;
