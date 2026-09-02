-- Compensation the employer stated, wherever they stated it.
--
-- Flexport's Global Operations Specialist published no salary in the
-- posting. Its application form carried a required field labelled
-- "The hourly rate for this role is $27.69/hour." That is $57,595 a year
-- and definitively below the $85,000 floor, but the rate lived only in a
-- form-field label inside a frozen form snapshot. Nothing read it, so
-- job_versions.salary_* stayed null, compareToFloor returned
-- INDETERMINATE, the job stayed ELIGIBLE, and it was prepared. The user
-- caught it by reading the question.
--
-- The same class of failure had already happened once, from the other
-- direction: a posting that published a range in its body which was
-- never extracted. Two entry points, one gap.
--
-- WHY A TABLE AND NOT A COLUMN ON job_versions
--
-- A job version is an observation of a posting at a moment. 786 of
-- 10,831 jobs already have more than one, so anything written onto the
-- current version is lost the next time ingest observes a new one. What
-- was learned about pay must outlive that, so it is keyed to the
-- OPENING, which is the durable identity a job row and an application
-- both point at.
--
-- EMPLOYER-STATED ONLY
--
-- Every row here is a figure the employer themselves put in writing, in
-- one of exactly three places. That is the whole scope. This table is
-- what can trigger a hard compensation floor and end a candidacy, so an
-- estimate by a salary aggregator, a recruiter's guess or anything this
-- system inferred does not belong in it and has no source value to be
-- filed under. There is deliberately no "is this really from the
-- employer" flag: a boolean defaulting to true is not a safeguard, it is
-- an invitation to write something that is not employer-stated and then
-- rely on a column nobody checks. If third-party estimates are ever
-- wanted, they need their own table and their own rules, because they
-- must never gate eligibility.
--
-- WHAT IS STORED, AND WHAT IS NOT
--
-- The employer's own numbers and their own period, exactly as stated. A
-- rate of 27.69 per hour is stored as 27.69 with period HOUR. It is
-- never multiplied out and stored as 57,595 a year, because the employer
-- did not publish an annual salary and the record must not claim they
-- did. Annualization is a derivation and stays in lib/scoring/salary.ts,
-- which is unchanged by this migration.

create table if not exists opening_compensation (
  id uuid primary key default uuid_generate_v4(),

  -- The durable identity. Several job rows may share one opening, and
  -- what the employer pays is a fact about the opening, not about the
  -- row that happened to reveal it.
  --
  -- RESTRICT, matching jobs.canonical_opening_id and
  -- applications.canonical_opening_id, which are the two tables this one
  -- is most like. Canonical openings are not physically deleted in
  -- normal operation: the only delete path in the system is the orphan
  -- sweep in migration 0035, which removes openings that NO job and NO
  -- application references. An opening holding compensation evidence can
  -- never be such an orphan, because the evidence only ever arrives
  -- through a job's posting or an application's form.
  --
  -- This was CASCADE in an earlier draft, which was both unnecessary and
  -- actively harmful: a cascade issues a DELETE against this table,
  -- which the append-only trigger below would reject, so the cascade
  -- would abort the parent delete anyway. RESTRICT states the real
  -- invariant, and the foreign key refuses the parent delete before any
  -- child DELETE is attempted, so the two rules never collide.
  canonical_opening_id uuid not null references openings(id) on delete restrict,

  -- Where it was actually seen, kept for traceability. Nullable because
  -- an opening can outlive the job row it was discovered on.
  job_id uuid references jobs(id) on delete set null,

  -- As the employer stated it. A single rate sets both bounds to the
  -- same number: that is a definite figure, not an open-ended range, and
  -- the floor comparison is entitled to treat it as a maximum.
  amount_min numeric,
  amount_max numeric,
  currency text not null default 'USD',

  -- Constrained to what annualize() understands. A period it cannot read
  -- would produce a null annualization and silently stop excluding
  -- anything, which is the failure this table exists to prevent.
  period text not null check (period in ('HOUR', 'MONTH', 'YEAR')),

  -- The three places an employer states pay. Ranked in code, not here,
  -- because the ranking is a judgement that may change and the record
  -- should not have to be rewritten when it does.
  source text not null check (source in (
    'POSTING_BODY',
    'APPLICATION_FORM',
    'EMPLOYER_DIRECT'
  )),

  -- WHERE THE FIGURE WAS SEEN
  --
  -- Precisely enough to recognise the same evidence again. source_ref is
  -- the container, by content where possible: a form snapshot hash, a
  -- job version id. source_locator is the place inside it, such as a
  -- form field key. source_text is the employer's exact words.
  --
  -- Together with the parsed figures these form the fingerprint below,
  -- which is what distinguishes re-reading old evidence from an employer
  -- saying the same thing again in a new place.
  source_ref text not null,
  source_locator text not null,
  source_text text not null,

  -- Anything else worth keeping that is not part of the identity.
  source_detail jsonb not null default '{}',

  -- The identity of this observation, computed by
  -- lib/scoring/openingCompensation.ts observationFingerprint().
  --
  -- Hashed over WHERE it was seen and WHAT it said. Both halves are
  -- needed: location alone collides when an employer edits a rate in
  -- place, and value alone refuses a genuine later restatement of the
  -- same pay, which is exactly the mistake this replaced.
  evidence_fingerprint text not null,

  -- When the evidence was OBSERVED, not when a parser last read it. A
  -- frozen snapshot was captured once; re-reading it later does not make
  -- the sighting newer, and stamping "now" would let a rerun outrank a
  -- genuinely newer posting purely by running last.
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- At least one bound, or the row says nothing.
  constraint opening_compensation_has_a_number
    check (amount_min is not null or amount_max is not null),

  -- Pay is never negative. Stated separately from the fingerprint work
  -- because it guards the arithmetic downstream, not the identity.
  constraint opening_compensation_amounts_nonnegative
    check (coalesce(amount_min, 0) >= 0 and coalesce(amount_max, 0) >= 0),

  -- A range runs upwards. Only checked when both bounds are present.
  constraint opening_compensation_range_is_ordered
    check (amount_min is null or amount_max is null or amount_min <= amount_max)
);

create index if not exists opening_compensation_by_opening
  on opening_compensation (canonical_opening_id, observed_at desc);

-- ============================================================
-- Replaying the same evidence is not a new observation
-- ============================================================
--
-- The recorder re-reads frozen form snapshots, so running it twice meets
-- the same sentence twice. Inserting it again would produce a row with a
-- later observed_at that then outranks the first purely because a script
-- ran again, silently changing which evidence governs.
--
-- Uniqueness is on the EVIDENCE, not on the money. An earlier draft of
-- this migration keyed on (opening, source, period, currency, amounts),
-- which had the effect of making a genuine later restatement of the same
-- rate permanently unrecordable: if Flexport reposted $27.69 on a new
-- form next year, that real second sighting would have been rejected as
-- a duplicate. Fingerprinting the evidence fixes that and removes the
-- need for sentinel values in the key.
--
--   re-parsing the same frozen snapshot   -> identical fingerprint, refused
--   same amount seen in a NEW snapshot    -> different source_ref, recorded
--   changed amount, or changed period     -> different fingerprint, recorded
--   same figure from a different source   -> different source, recorded
create unique index if not exists opening_compensation_one_per_evidence
  on opening_compensation (evidence_fingerprint);

-- ============================================================
-- Append only, enforced
-- ============================================================
--
-- Note how this interacts with the foreign key above. Because
-- canonical_opening_id is RESTRICT rather than CASCADE, deleting an
-- opening that carries compensation is refused by the foreign key
-- itself and never reaches this trigger. The retraction flag therefore
-- stays what it is meant to be, a narrow escape hatch for a misread
-- observation, and does not become a way to delete evidence in bulk by
-- deleting its parent.
--
-- "Append only" was the design; this makes it true rather than a note in
-- a comment. Compensation evidence is a record of what was observed at a
-- moment. Editing it in place would rewrite history, and the reader
-- already picks which observation governs, so nothing legitimate needs
-- UPDATE.
--
-- DELETE has exactly one legitimate use: retracting an observation that
-- should never have been recorded, such as a parser misreading a
-- sentence. That is rare, deliberate, and worth making visible, so it
-- runs behind a transaction-local flag in the same idiom migration 0074
-- uses for manual submissions. Ordinary code cannot delete by accident.
--
--   set local app.compensation_retraction = 'on';
--   delete from opening_compensation where id = '...';
create or replace function opening_compensation_is_append_only() returns trigger as $$
declare v_reason text;
begin
  if tg_op = 'UPDATE' then
    raise exception 'opening_compensation is append only: record a new observation instead of editing %', old.id
      using hint = 'The reader picks which observation governs, so a correction is a new row, not an edit.';
  end if;

  if tg_op = 'DELETE' then
    if coalesce(current_setting('app.compensation_retraction', true), '') <> 'on' then
      raise exception 'opening_compensation rows are not deleted in normal operation (%)', old.id
        using hint = 'Use retract_opening_compensation(ids, reason) to remove a misread observation.';
    end if;

    -- The reason travels with the flag, so a retraction cannot be
    -- performed anonymously even by setting the flag by hand in the SQL
    -- editor. Both are required, and the audit row below is written in
    -- THIS transaction, before the delete proceeds: there is no ordering
    -- in which a row disappears without its reason surviving.
    v_reason := coalesce(current_setting('app.compensation_retraction_reason', true), '');
    if length(btrim(v_reason)) < 10 then
      raise exception 'a retraction needs a reason saying why the observation should not have been recorded'
        using hint = 'Set app.compensation_retraction_reason, or call retract_opening_compensation(ids, reason).';
    end if;

    -- truth_change_log is the existing append-only record of who changed
    -- what. old_data keeps a faithful copy of the whole row, including
    -- the evidence fingerprint, the opening and the employer's exact
    -- wording, so what was removed stays identifiable after the row is
    -- gone. The reason goes in new_data, which is otherwise meaningless
    -- for a delete.
    insert into truth_change_log (
      source_table, row_id, operation, changed_fields, old_data, new_data,
      profile_version_at_time, actor
    ) values (
      'opening_compensation',
      old.id,
      'RETRACT',
      array['retracted'],
      to_jsonb(old),
      jsonb_build_object('retraction_reason', btrim(v_reason)),
      (select profile_version from profile where singleton),
      coalesce(current_setting('app.actor', true), 'unknown')
    );
  end if;

  return old;
end $$ language plpgsql security definer set search_path = public;

drop trigger if exists opening_compensation_append_only on opening_compensation;
create trigger opening_compensation_append_only
  before update or delete on opening_compensation
  for each row
  execute function opening_compensation_is_append_only();

-- ============================================================
-- The retraction path, made reachable
-- ============================================================
--
-- The trigger above expects a transaction-local flag, and nothing in
-- this system can set one: the workers reach the database through
-- PostgREST, which offers no way to issue "set local". Without this
-- function the escape hatch would be documented but unusable, so a
-- misread observation could never be removed by any code we run, only
-- by hand in the SQL editor.
--
-- So the hatch is a function instead. It is narrow on purpose: it takes
-- explicit ids, it demands a reason in words, and it is not granted to
-- the portal role, which must never be able to delete evidence.
create or replace function retract_opening_compensation(p_ids uuid[], p_reason text)
returns integer as $$
declare removed integer;
begin
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception 'a retraction needs a reason saying why the observation should not have been recorded';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;

  -- Both scoped to this function's transaction, so the guard is back in
  -- force the moment it returns. The reason is passed the same way
  -- because the trigger, not this function, is what writes the audit row,
  -- which is how a hand-run delete is audited too.
  set local app.compensation_retraction = 'on';
  perform set_config('app.compensation_retraction_reason', p_reason, true);

  delete from opening_compensation where id = any(p_ids);
  get diagnostics removed = row_count;
  return removed;
end $$ language plpgsql security definer set search_path = public;

revoke all on function retract_opening_compensation(uuid[], text) from public;
grant execute on function retract_opening_compensation(uuid[], text) to service_role;

comment on function retract_opening_compensation(uuid[], text) is
  'The only reachable way to remove compensation evidence. For a misread observation, never for ordinary correction: a corrected figure is a new observation. Requires explicit ids and a stated reason, and is deliberately not granted to the portal role.';

comment on table opening_compensation is
  'Compensation an employer stated for an opening, in the posting body, on their application form, or directly. Employer-stated figures ONLY: this is what can trigger a hard compensation floor, so estimates from any other party do not belong here and have no source value to be filed under. Append only, enforced by trigger: a correction is a new observation, never an edit.';
comment on column opening_compensation.period is
  'The employer''s own period. An hourly rate is stored hourly and never multiplied into an annual figure here; annualization is derived in lib/scoring/salary.ts.';
comment on column opening_compensation.source is
  'The three places an employer states pay. Every value denotes the employer as the author; there is no value for a third-party estimate, by design.';
comment on column opening_compensation.evidence_fingerprint is
  'Identity of one observation, hashed over where it was seen (opening, source, container, locator, exact wording) and what it said (period, currency, amounts). Unique. Re-reading the same frozen evidence reproduces it and is refused; the same amount seen in new evidence produces a different value and is recorded.';
comment on column opening_compensation.observed_at is
  'When the evidence was observed, not when a parser last read it. For a form snapshot this is when the snapshot was captured, so re-running the recorder cannot make an old sighting outrank a newer one.';
comment on column opening_compensation.source_text is
  'The employer''s exact words, part of the evidence identity. Never a summary.';
comment on column opening_compensation.source_detail is
  'The exact wording the figure came from, including the form field key and label where applicable, so a number can always be traced to its sentence.';

-- Read-only to the portal, like every other worker-written table.
-- ============================================================
-- An opening holding evidence is not an orphan
-- ============================================================
--
-- Migration 0035 swept away openings that no job and no application
-- referenced. That sweep was a one-time statement and has already run,
-- and the diagnostic it left behind, openings_must_be_reachable(), still
-- defines reachability as jobs-or-applications only.
--
-- job_id here is ON DELETE SET NULL, so compensation deliberately
-- outlives the job row it was discovered on. That makes a state
-- describable in which an opening has no job, no application, and
-- retained employer-stated pay. It cannot arise today: production has no
-- job-purge path, and applications are only removed by
-- purge_test_application, which refuses non-test rows. But the schema
-- permits it, so the definition is corrected rather than left resting on
-- that assumption.
--
-- Such an opening is not an orphan. It carries authoritative evidence
-- that can still exclude a role, and the RESTRICT foreign key above will
-- refuse to delete it. Teaching the diagnostic the same rule keeps the
-- two from disagreeing.
create or replace function openings_must_be_reachable() returns trigger as $$
declare orphans integer;
begin
  select count(*) into orphans
    from openings o
   where not exists (select 1 from jobs j where j.canonical_opening_id = o.id)
     and not exists (select 1 from applications a where a.canonical_opening_id = o.id)
     and not exists (select 1 from opening_compensation c where c.canonical_opening_id = o.id)
     and o.created_at < now() - interval '1 minute';
  if orphans > 100 then
    raise warning 'openings has % rows nothing points at; a write path is minting them', orphans;
  end if;
  return null;
end $$ language plpgsql;

comment on function openings_must_be_reachable() is
  'Diagnostic. Not wired to a trigger. An opening is reachable if a job, an application, or retained employer-stated compensation points at it: evidence that can still exclude a role keeps its opening alive, and the RESTRICT foreign key on opening_compensation enforces the same rule.';

alter table opening_compensation enable row level security;
drop policy if exists owner_read on public.opening_compensation;
create policy owner_read on public.opening_compensation for select using (is_app_owner());
revoke all on public.opening_compensation from authenticated;
grant select on public.opening_compensation to authenticated;
