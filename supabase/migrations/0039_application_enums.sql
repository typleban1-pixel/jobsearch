-- Enum values for the application phase.
--
-- Separate migration: ALTER TYPE ... ADD VALUE may not be used in the
-- same transaction that adds it, and the tables below reference these.

-- How a single application field came to hold its value.
--
-- Deliberately not a number. A probability invites "0.83 is probably fine
-- to submit", and an application answer is a factual assertion sent under
-- the user's name, not a ranking. Fit is allowed to be wrong; this is not.
create type field_confidence as enum (
  'VERIFIED',        -- an approved profile row or approved question-bank answer says so
  'DERIVED',         -- pure deterministic transformation of verified evidence
  'HUMAN_CONFIRMED', -- the user supplied or approved it for this application
  'BLOCKED'          -- material uncertainty remains; nothing proceeds
);

-- Why a field is blocked. The two need different thinking from the reader:
-- UNKNOWN means look outside the profile, AMBIGUOUS means choose between
-- readings the profile already supports.
create type block_kind as enum ('UNKNOWN', 'AMBIGUOUS');

-- How a resume line came to exist.
create type claim_generation as enum ('SELECTED', 'REORDERED', 'REFRAMED');

-- Assembling an application is a state, distinct from a draft sitting
-- idle, which matters when a preparation run dies halfway.
alter type application_status add value if not exists 'PREPARING' before 'AWAITING_REVIEW';
