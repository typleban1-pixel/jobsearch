# Architectural invariants

Enforced in the schema wherever a constraint can carry them, because a
rule that lives only in a prompt is a rule an LLM can reason around.

## 1. Scoring purity

All Fit, Opportunity, Generalist Fit and Specialist Risk scores are
**deterministic functions of versioned profile data, versioned job data,
stored extracted features, and versioned scoring weights.**

LLMs produce and update structured features. The score never depends on a
live LLM call.

Three separate requirements collapse into this one rule, and none of them
work without it:

- rescoring the corpus when the profile changes
- reproducing the score as it stood at a decision
- counterfactuals ("if SQL moved to CAPABLE, what improves?")

A counterfactual is therefore free: swap one feature, recompute, no model
involved.

## 2. Resolved values and source observations are separate concepts

`source_observations` preserves what each source said, including
disagreement. A resolved value on the entity is the system's current best
operational answer, kept for fast queries.

A resolved value always carries its own confidence and provenance, and
never erases the observations behind it. Two sources disagreeing about
company size is data, not a problem to be tidied away.

## 3. Unknown stays unknown

The system must not fill a null to make scoring easier. Absence of
evidence is not evidence of absence.

Where a field materially affects a score and is unknown, scoring handles
the uncertainty explicitly: it widens a range, lowers confidence, or
surfaces the gap. It never substitutes a default and proceeds as if the
value were known.

This is why `job_requirements.is_hard_requirement` is three-valued and
why missing evidence scores neutral rather than negative.

## 4. Reframe evidence, never create evidence

The AI may select, reorder, summarize, emphasize, de-emphasize and use
accurate terminology. It may not invent experience, skills,
accomplishments, metrics, credentials, dates or years, convert exposure
into proficiency, convert proficiency into expertise, or convert a
personal project into employment.

## 5. Contextual biography suggests; it never verifies

Narrative background can propose profile facts. It cannot create verified
ones. Anything derived from prose enters as `SUGGESTED` and is promoted
only by an explicit human act, one item at a time.

## 6. Immutable snapshots embed, never reference

A decision snapshot freezes a copy of the scores, features and reasons it
was made from. It does not hold foreign keys to rows that later change,
because a snapshot pointing at mutable data is not a snapshot.

## 7. Submission and outreach gates are deterministic

No LLM decides whether to submit an application or send a message. There
is no automated send path for outreach at all: a draft records
`sent_manually_at`, set by a human after they sent it themselves.

## 8. Analytics declare their sample size

| Applications | What may be shown |
|---|---|
| under 10 | raw counts only, no pattern claim |
| 10–19 | labeled "very low confidence" |
| 20–49 | labeled "provisional" |
| 50+ | descriptive comparison permitted |

Never implies causation. Never silently changes ranking weights; it
proposes, and a human approves.

## 9. History is append-only, and rewriting it takes a person

`source_observations`, `job_score_snapshots`, `job_versions`, `job_changes`,
`job_raw_payloads`, `source_fetches`, `job_extractions`, `application_events`,
`truth_change_log`, `profile_versions`, `profile_version_rows`, `llm_calls`,
`scoring_weight_changes`, `question_occurrences` and `ingest_run_companies`
reject UPDATE and DELETE at the database level.

Corrections are made by adding a newer row, never by editing the older one.
A small set of columns is exempt where supersession genuinely requires it:
`source_observations.is_resolved_value`, `job_versions.is_current`,
`job_extractions.superseded_by`, and the retention bookkeeping on the two
payload tables. Payload columns may be nulled by the pruner; they may never
be rewritten with different content.

Enforcement is by trigger rather than by RLS, because Supabase's
`service_role` carries `BYPASSRLS` and the worker runs as `service_role`.
RLS cannot constrain the process that does the writing; a trigger can.

The escape is `set local app.allow_history_mutation = 'on'`, which is
transaction-scoped and unreachable through PostgREST. Rewriting history
requires a direct database session, which means a person decided to.

## 10. Anything history points at cannot be deleted

Every foreign key from an append-only table is `ON DELETE RESTRICT`, with no
exceptions. A `CASCADE` or `SET NULL` into a frozen row would surface as an
immutability error from a statement that never mentioned the frozen table.
Refusing the parent deletion instead makes the reason legible.

The practical consequence: a job that has ever been versioned cannot be
deleted, only archived. A company with an ingest history cannot be deleted.
An application cannot be deleted, only withdrawn or abandoned.

## 11. A profile version is a row set, not an integer

`profile.profile_version` is only meaningful because `bump_profile_version()`
freezes the verified truth set into `profile_version_rows` in the same
transaction that increments it. Reconstructing what version 7 contained is a
single query, not a replay.

`profile_versions.truth_hash` lets a reconstruction be verified rather than
assumed intact, and `job_score_snapshots.profile_truth_hash` carries that
hash forward into the decision record.

Nothing may increment `profile_version` by direct UPDATE. An integer with no
frozen row set behind it is exactly the false assurance this invariant exists
to prevent.

## 12. Three artifacts, three suspects

For every job version the system keeps what the source returned
(`job_raw_payloads.raw_fragment`), what the parser produced
(`job_raw_payloads.normalized`, with `normalizer_version`), and what the model
concluded (`job_extractions.output`, with `extraction_version` and tier).

Without all three, a source error, a parser error and an extraction error are
indistinguishable after the fact, and the system cannot tell whether it was
lied to or whether it misread.

## 13. No credentials in the database

There is no credentials table and there is not meant to be one. API keys, ATS
passwords and browser session state live in the worker's environment and the
OS keychain. `llm_calls` records tier, purpose, tokens and cost, and has no
prompt or response column, so no future logging change can begin writing
profile data into an analytics table.

Columns that must never reach a prompt, a log, a frontend payload or an audit
trail are registered in `data_classifications`. The LLM boundary reads that
table before building a prompt.
