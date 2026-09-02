-- Locations as a set, underneath the job variant.
--
-- The shape is three levels, and they are independent dimensions:
--
--   canonical opening  ->  published job variants  ->  normalized locations
--
-- An opening may have several variants because the ATS published one
-- requisition several times. A single variant may still name several
-- places in its own location field. Neither implies the other.
--
-- What this does not do: it does not turn a multi-location posting into
-- several jobs rows. A jobs row is the published variant, and a variant
-- listing four cities is one thing the board published.
--
-- Why it exists: the singular city/state/metro columns hold whatever the
-- FIRST place in the string parsed to. Of 186 open postings naming
-- Chicago, 61 carried no Chicagoland metro because Chicago was listed
-- second or later. "Chicago, New York, San Francisco" was read as a city
-- in a state and lost the metro entirely.

create type location_provenance as enum (
  -- The ATS location field. The only source used today.
  'PROVIDER_LOCATION_FIELD',
  -- A structured provider field such as Lever's workplaceType.
  'PROVIDER_STRUCTURED',
  -- Read from description prose. Recorded separately because a city name
  -- in a paragraph is not a work location, and must never create
  -- eligibility on its own.
  'DESCRIPTION_TEXT'
);

create type location_confidence as enum ('EXACT', 'PARSED', 'AMBIGUOUS');

create table job_locations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  -- Order within the source string, so "listed first" stays recoverable
  -- without it meaning "the location".
  position integer not null,

  city text,
  state text,
  -- Province or region for non-US places. Kept out of state so that
  -- "Ontario" can never be read as a US state code.
  region text,
  country text,
  -- Only when deterministically known from city plus state. Never guessed.
  metro text,

  is_remote boolean not null default false,
  -- For remote entries: the country or region the remote role is scoped
  -- to. "US-Remote" and "Canada-Remote" are not the same offer.
  remote_scope text,

  provenance location_provenance not null,
  confidence location_confidence not null,
  -- The exact slice of the source string this came from, so any parse can
  -- be argued with against its input.
  raw_segment text not null,
  parser_version integer not null,
  created_at timestamptz not null default now(),

  constraint job_locations_position_unique unique (job_id, position)
);

create index job_locations_job_idx on job_locations(job_id);
create index job_locations_metro_idx on job_locations(metro) where metro is not null;
create index job_locations_remote_idx on job_locations(job_id) where is_remote;

comment on table job_locations is
  'Every place a job variant names, in source order. The authoritative location model. jobs.city/state/metro remain only for readers not yet migrated.';
comment on column job_locations.provenance is
  'Where the location came from. DESCRIPTION_TEXT exists so that a location read from prose can never be mistaken for one the employer stated in its location field.';
comment on column job_locations.remote_scope is
  'The geography a remote offer is scoped to. Null means the posting said remote without saying where, which is unresolved rather than US-remote.';

-- location_raw is now load-bearing: it is the input every normalized row
-- is derived from, and the only way to re-derive them if the parser
-- changes.
comment on column jobs.location_raw is
  'The provider location field, exactly as received. Never rewritten. job_locations rows are derived from it and can be rebuilt from it.';

comment on column jobs.city is
  'LEGACY. The first place the old single-location parser resolved, which is not the same as the location. job_locations is authoritative. Retained until every reader is migrated.';
comment on column jobs.metro is
  'LEGACY. Null on multi-location postings whose target metro was not listed first. Use job_locations.metro.';
