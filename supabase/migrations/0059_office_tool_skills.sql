-- Four tools the profile never recorded.
--
-- The Candidate #6 screening read "Expertise in using Excel/Google
-- Sheets/Google Docs/PowerPoint" as ABSENT. That was correct about the
-- profile and wrong about the person: Ty confirmed he is proficient in
-- all four. The profile held no row for any of them, so the scorer had
-- nothing to match and the resume had nothing to say.
--
-- Worth noting what was already there: term_aliases carried
-- "ms excel" -> "excel", "microsoft excel" -> "excel" and
-- "google sheets" -> "sheets". Those aliases pointed at canonical terms
-- with no skill behind them, so they had never resolved anything. The
-- aliases were written in anticipation of skills nobody added.
--
-- 238 requirements across the corpus name these tools.
--
-- Level EXPERIENCED, matching the taxonomy's top band and how Adobe
-- Photoshop is recorded. Nothing else is claimed: no years, no
-- certification, no employer-specific usage, and no suite-level claim.
-- "Microsoft Office" and "Google Workspace" are deliberately NOT added
-- and deliberately not listed as related terms -- those suites include
-- Word, Outlook, Access and more, and the confirmation covered four
-- named applications.

insert into skills (name, category, status, level, interest, importance,
                    related_terms, evidence_confidence, verified_at, notes)
values
  ('Microsoft Excel', 'operations', 'VERIFIED', 'EXPERIENCED', 'NEUTRAL', 'SUPPORTING',
   array['excel', 'ms excel', 'spreadsheets', 'spreadsheet'], 'SELF_REPORTED', now(),
   'HUMAN_CONFIRMED 2026-08-31: Ty states he is very proficient. No certification, no years of experience and no employer-specific usage are claimed.'),
  ('Google Sheets', 'operations', 'VERIFIED', 'EXPERIENCED', 'NEUTRAL', 'SUPPORTING',
   array['sheets', 'gsheets', 'google spreadsheet'], 'SELF_REPORTED', now(),
   'HUMAN_CONFIRMED 2026-08-31: Ty states he is very proficient. No certification, no years of experience and no employer-specific usage are claimed.'),
  ('Google Docs', 'operations', 'VERIFIED', 'EXPERIENCED', 'NEUTRAL', 'SUPPORTING',
   array['docs', 'gdocs', 'google document'], 'SELF_REPORTED', now(),
   'HUMAN_CONFIRMED 2026-08-31: Ty states he is very proficient. No certification, no years of experience and no employer-specific usage are claimed.'),
  ('Microsoft PowerPoint', 'operations', 'VERIFIED', 'EXPERIENCED', 'NEUTRAL', 'SUPPORTING',
   array['powerpoint', 'ms powerpoint', 'ppt', 'slide deck', 'slide decks', 'presentation software'],
   'SELF_REPORTED', now(),
   'HUMAN_CONFIRMED 2026-08-31: Ty states he is very proficient. No certification, no years of experience and no employer-specific usage are claimed.')
on conflict (name) do nothing;

-- The aliases that were already pointing nowhere now resolve, plus the
-- variants postings actually use. Canonical terms are the skill names.
insert into term_aliases (alias, canonical_term, note, origin)
values
  ('excel', 'Microsoft Excel', 'the bare product name as postings write it', 'CURATED'),
  ('ms excel', 'Microsoft Excel', null, 'CURATED'),
  ('microsoft excel', 'Microsoft Excel', null, 'CURATED'),
  ('sheets', 'Google Sheets', null, 'CURATED'),
  ('google sheets', 'Google Sheets', null, 'CURATED'),
  ('docs', 'Google Docs', null, 'CURATED'),
  ('google docs', 'Google Docs', null, 'CURATED'),
  ('powerpoint', 'Microsoft PowerPoint', null, 'CURATED'),
  ('ms powerpoint', 'Microsoft PowerPoint', null, 'CURATED'),
  ('microsoft powerpoint', 'Microsoft PowerPoint', null, 'CURATED')
on conflict (alias) do update
  set canonical_term = excluded.canonical_term,
      note = coalesce(excluded.note, term_aliases.note),
      origin = excluded.origin;

insert into truth_change_log (source_table, row_id, operation, changed_fields, new_data, profile_version_at_time, actor)
select 'skills', s.id, 'INSERT',
       array['name', 'status', 'level'],
       jsonb_build_object('name', s.name, 'level', s.level, 'status', s.status,
         'basis', 'HUMAN_CONFIRMED 2026-08-31: proficiency stated by the user after the Candidate #6 screening read the requirement as absent.'),
       p.profile_version, 'user:human_confirmed'
  from skills s, profile p
 where s.name in ('Microsoft Excel', 'Google Sheets', 'Google Docs', 'Microsoft PowerPoint')
   and p.singleton = true;
