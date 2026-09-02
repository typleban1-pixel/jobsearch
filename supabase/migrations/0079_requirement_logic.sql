-- Employer-authored logical relationships between requirements.
--
-- SpotHero asked for "3+ years of legal operations experience or 5+
-- years of operations experience and an interest in the legal field".
-- Extraction split it into two rows, marked both HARD, and recorded the
-- alternation only in prose:
--
--   "The 'or' clause provides an alternative path but both are
--    presented as required."
--   "Alternative requirement in the same sentence as the 3+ years legal
--    operations requirement."
--
-- The model understood the sentence. This table had no column to hold
-- what it understood, so the alternation went into a free-text field
-- nothing reads, two alternative paths became two independently
-- mandatory requirements, and failing both counted as two core gaps.
-- That is how one satisfiable requirement produced a rejection.
--
-- THE INVARIANT
--
--   An employer-authored alternative must never become several
--   independently mandatory requirements.
--
-- WHY TWO COLUMNS AND NOT AN EXPRESSION TREE
--
-- Every shape found in the corpus is covered by grouping alone:
--
--   A AND B          no group, or two different groups
--   A OR B           one group, two conjunct keys
--   A OR (B AND C)   one group; A alone, B and C sharing a key
--
-- A general boolean tree would carry more than the postings contain and
-- would need its own parser, its own validation and its own failure
-- modes. Two nullable columns are enough, and a row that sets neither
-- behaves exactly as it does today, which is what makes this safe to
-- add to 36,702 existing rows.
--
-- WHAT THIS DOES NOT TOUCH
--
-- raw_text is the employer's own words and is never rewritten. Nothing
-- here changes an existing requirement's meaning, hardness, concept or
-- text; it only records how the employer joined them.

alter table job_requirements
  -- Requirements sharing this value are ALTERNATIVES. Satisfying any one
  -- of them satisfies the group. Null means "not part of an
  -- alternation", which is the overwhelming majority and the behaviour
  -- that exists today.
  add column if not exists alternative_group text,

  -- Within one group, requirements sharing this value are ANDed with
  -- each other and ORed against the other keys. Null means the row
  -- stands alone inside its group.
  add column if not exists conjunct_key text,

  -- How the grouping was established, so a verdict can always be traced
  -- to whether a machine or a person decided these were alternatives.
  -- Deliberately not defaulted: a row with a group and no method is a
  -- defect, and the constraint below says so.
  add column if not exists alternative_source text
    check (alternative_source in ('DETERMINISTIC_TEXT', 'EXTRACTION', 'HUMAN_CONFIRMED'));

-- A group without a recorded source cannot be audited, and a source
-- without a group describes nothing.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'requirement_group_has_a_source') then
    alter table job_requirements
      add constraint requirement_group_has_a_source
      check ((alternative_group is null) = (alternative_source is null));
  end if;
end $$;

-- A conjunct key only means something inside a group.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'conjunct_requires_a_group') then
    alter table job_requirements
      add constraint conjunct_requires_a_group
      check (conjunct_key is null or alternative_group is not null);
  end if;
end $$;

create index if not exists job_requirements_by_alternative_group
  on job_requirements (job_id, alternative_group)
  where alternative_group is not null;

comment on column job_requirements.alternative_group is
  'Requirements sharing this value are alternatives the employer wrote with "or". Satisfying any one satisfies the group, so failing one is not a gap when another holds. Null, the normal case, means the requirement stands on its own and behaves exactly as it did before this column existed.';
comment on column job_requirements.conjunct_key is
  'Within one alternative group, rows sharing this key are ANDed and different keys are ORed. Expresses "A or (B and C)" without a general expression tree.';
comment on column job_requirements.alternative_source is
  'How the grouping was established: DETERMINISTIC_TEXT from quoted-span analysis with no model involved, EXTRACTION from the model that read the posting, HUMAN_CONFIRMED from a person. A grouping that changes a verdict must be traceable to one of these.';
