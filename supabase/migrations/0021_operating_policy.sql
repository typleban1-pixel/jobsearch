-- How the system should behave. Configuration, never truth-profile
-- evidence, and never an input to scoring.

-- A presentation state, deliberately separate from eligibility.
--
-- A stretch role is not ineligible. Suppressing attractive openings
-- because the candidate looks underqualified on paper is how a search
-- quietly narrows to what it already believes, and he asked specifically
-- to see them and decide for himself.
create type recommendation_state as enum (
  'STRONG_MATCH',    -- clears the bar for automatic application
  'WORTH_REVIEW',    -- surfaced for a human decision
  'STRETCH',         -- attractive, probably not competitive on paper
  'NOT_RECOMMENDED'  -- surfaced but ranked away
);

alter table job_scores add column recommendation recommendation_state;
alter table job_scores add column recommendation_reason text;

comment on column job_scores.recommendation is
  'Presentation state, not eligibility. STRETCH means surfaced and flagged, never suppressed and never auto-submitted unless it independently clears the strong-match standard.';

create table operating_policy (
  id uuid primary key default gen_random_uuid(),
  singleton boolean not null default true unique check (singleton),

  -- No quota in either direction. Volume is an OUTPUT of the market and
  -- the standard, never an input. If a week holds 60 genuinely strong
  -- openings the system must not stop at 10; if it holds 8 it must not
  -- lower the bar to manufacture more.
  weekly_application_target integer,
  weekly_application_cap integer,

  -- Broad on purpose. A good opening with an unusual title, or one
  -- sitting outside an obvious career path, is exactly what this system
  -- exists to find, so recall beats precision at the discovery stage.
  discovery_breadth text not null default 'BROAD',

  -- Off, and turning it on is an explicit operating-mode change after
  -- reliability testing rather than a default that drifts into being
  -- true. His eventual goal is not permission to start now.
  auto_submit_enabled boolean not null default false,
  auto_submit_note text,

  -- Deliberately NOT a coverage percentage. Reducing the decision to
  -- "70% of requirements matched" would ignore evidence quality,
  -- credential gating and the direct-versus-transferable distinction the
  -- scoring architecture exists to express.
  strong_match_definition text,

  surface_stretch boolean not null default true,
  human_review_policy text,
  priority_employers text[] not null default '{}',
  notes text,
  updated_at timestamptz not null default now()
);

insert into operating_policy (
  weekly_application_target, weekly_application_cap, discovery_breadth,
  auto_submit_enabled, auto_submit_note, strong_match_definition,
  surface_stretch, human_review_policy, priority_employers, notes
) values (
  null, null, 'BROAD',
  false,
  'Confirmed 30 Aug 2026: automatic submission stays OFF while the application system is being tested and validated. The user expects more human oversight initially. Enabling it later is a deliberate operating-mode change made after the system has demonstrated reliability, not something to switch on because it is the eventual goal.',
  'A clearly strong match judged on the scoring architecture and evidence quality, NOT on a fixed percentage of requirements matched. Hard eligibility applies independently. Where there is meaningful uncertainty about whether a job clears the bar, surface it rather than submitting.',
  true,
  'Review is required on low confidence, ambiguity, missing material information, or any condition where the truthful answer cannot be determined with sufficient confidence. Standing rule: DO NOT GUESS. STOP. PRESERVE THE APPLICATION. SAY WHAT NEEDS RESOLUTION. High confidence does not mean probably correct: every employer-facing claim still comes entirely from verified evidence and still passes the claim guards.',
  '{}',
  'No company-specific priority list. Opportunity quality, fit and the established preferences determine priority rather than employer brand. Fit and Opportunity weights must NEVER be tuned to manufacture a desired application volume.'
);

comment on table operating_policy is
  'Behavioral configuration. Never evidence, never an input to a score. A good week is broad discovery, correct identification, stretch surfaced separately, and every clearly strong application prepared or sent. Five one week and forty the next are both fine.';
