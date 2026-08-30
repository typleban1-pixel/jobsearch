-- Legal identity, availability, and duplicate-application protection.

-- A middle name is not a display name. Applications distinguish a legal
-- identity field from a preferred or display name, and the middle name
-- belongs only in the first kind. Storing it in legal_first_name or
-- appending it to preferred_name would guarantee it leaks onto a resume.
alter table profile add column legal_middle_name text;

comment on column profile.legal_middle_name is
  'Used ONLY where a form requires the full legal name or legal identity genuinely matters, such as background-check and onboarding fields. Never on resumes, cover letters, recruiter messages or ordinary professional materials.';

-- Two weeks even without a full-time role, because winding down existing
-- commitments properly still takes time. "Available immediately" would be
-- convenient and untrue.
alter table profile add column notice_period_weeks integer;
alter table profile add column relocation_status text;
alter table profile add column relocation_assistance_required boolean;

comment on column profile.relocation_status is
  'Free text. The move is definite and independent of any job offer, but no date has been established, so employer-facing text may say relocating to the Chicago area and must not state a month.';

-- Duplicate-application protection at the OPENING level, not the company
-- level.
--
-- The distinction is the whole point: applying twice to the same posting
-- is an embarrassment, while applying to a different role at a company
-- that rejected you before is completely normal and must stay possible.
-- A company-level rule would quietly remove employers from the search
-- forever after one rejection.
create unique index applications_one_active_per_opening
  on applications(job_id)
  where status not in ('WITHDRAWN', 'ABANDONED', 'REJECTED');

comment on index applications_one_active_per_opening is
  'Prevents a second live application to the same opening. Deliberately scoped to job_id: a different opening at the same employer is unaffected, and a withdrawn or rejected application does not block a later reapplication to that same posting.';
