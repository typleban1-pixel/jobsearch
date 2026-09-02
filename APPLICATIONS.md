# Application phase: architecture

Built, 30 Aug 2026. Stages 1 to 3 complete. Sections below describe what exists.

Much of this already exists. `applications`, `application_answers`,
`application_events`, `question_bank`, `question_occurrences`, `resumes`
and `resume_claims` were designed in migrations 0001 and 0004, along with
the `question_category` A-E scale, the `AI_DRAFT_FROM_VERIFIED_EVIDENCE`
provenance kind, and a `data_classification` value for credentials whose
comment already reads "Never stored here". This fills those in rather
than adding a parallel set.

---

## 1. The confidence policy

**Submission confidence is categorically stricter than fit confidence.**

Fit is probabilistic and comparative: it ranks jobs against each other and
is allowed to be wrong, because being wrong costs a wasted read. An
application answer is a factual assertion sent to an employer under the
user's name. A Fit of 27 says nothing about whether he has a security
clearance, and **no Fit score, coverage ratio or match confidence may ever
be cited as grounds for filling a field.** The two systems share no
threshold, no scale and no vocabulary.

Every field on a submitted application ends in exactly one state:

| state | meaning | source |
|---|---|---|
| `VERIFIED` | directly supported by an approved profile row or an approved question-bank answer | frozen `profile_version_rows`, `question_bank.approved_answer` |
| `DERIVED` | deterministic transformation of verified evidence | pure function, no model, reversible and explainable |
| `HUMAN_CONFIRMED` | supplied or explicitly approved by the user for this application | review queue |
| `BLOCKED` | material uncertainty remains | nothing may proceed |

`DERIVED` is deliberately narrow. It covers things like formatting a
verified phone number, computing "yes" for work authorization from
`profile.work_authorization = "US citizen"`, or selecting a start-date
option from the verified two-week notice period. It does **not** cover a
model's judgement. If a transformation cannot be written as a pure
function whose reasoning fits in a sentence, it is not `DERIVED`; it is
`BLOCKED`.

    all_fields_confident = every REQUIRED field is VERIFIED, DERIVED or
                           HUMAN_CONFIRMED, and zero fields are BLOCKED

This is computed, never set. A database trigger recalculates it from
`application_answers` on every write, so no code path can assert it.

The existing constraint stands unchanged:

    status not in ('SUBMITTED', ...) or (human_approved and
                                         all_fields_confident and
                                         submitted_at is not null)

Two independent gates: the machine says every field is accounted for, and
the human says go. Neither implies the other.

---

## 2. State machine

`application_status` already has the twelve values. What is missing is
which transitions are legal, which is currently a convention.

    DRAFT ──▶ PREPARING ──▶ BLOCKED_NEEDS_INPUT ⇄ AWAITING_REVIEW
                                │                      │
                                └──────────▶ READY_TO_SUBMIT
                                                       │
                                                       ▼
                                                  SUBMITTED
                                                       │
                        ┌──────────────┬───────────────┼──────────────┐
                        ▼              ▼               ▼              ▼
                  ACKNOWLEDGED    REJECTED        WITHDRAWN      ABANDONED
                        │
                        ▼
                   IN_PROCESS ──▶ INTERVIEWING ──▶ OFFER

Rules worth stating because they are enforceable:

- `READY_TO_SUBMIT` requires `all_fields_confident`. A BLOCKED field
  drops the application back to `BLOCKED_NEEDS_INPUT` automatically.
- `SUBMITTED` requires `human_approved` **and** a submitted_at, and is
  reachable only from `READY_TO_SUBMIT`.
- Nothing leaves `SUBMITTED` except into the outcome states. An
  application is never deleted, only withdrawn or abandoned.
- Every transition writes an `application_events` row. The trigger
  writes it, not the caller, so a transition cannot happen unlogged.

`PREPARING` is the one new value: it distinguishes "being assembled" from
"drafted and idle", which matters when a preparation run fails halfway.

---

## 3. Resume provenance, with rewriting

The master resume composes static lines from frozen rows. Tailoring needs
more than selection, because reframing evidence for a specific posting is
one of the system's purposes. The constraint is not "do not rewrite". It
is **reframe evidence, never create evidence.**

### The grounding contract

Every tailored line carries:

    claim_text        what will be sent
    evidence_ids[]    frozen profile_version_rows it is derived from
    source_text       the exact text of those rows, stored alongside
    metric_id         when an approved metric is used
    generation        SELECTED | REORDERED | REFRAMED
    grounding_checks  which checks ran and what they found

A `REFRAMED` line must pass all of the following before it can be stored.
Each is a deterministic check, not a judgement:

1. **Every claim cites at least one frozen row.** No citation, no line.
2. **No new numbers.** Every numeral in the claim must appear in the
   cited evidence or in an approved metric. This is what stops "grew the
   team" becoming "grew the team by 40%".
3. **Approved metrics appear verbatim.** A metric's `approved_wording`
   was negotiated once. Tailoring may choose whether to include it and
   where; it may not re-word it.
4. **No new proper nouns.** Every capitalised entity must appear in the
   cited evidence, the employment record, or the profile. This stops a
   tailored resume inventing a client, tool or employer.
5. **No scope escalation.** A verb ladder is checked against the
   evidence's own verbs: `contributed to` may not become `led`,
   `supported` may not become `owned`, `worked on` may not become
   `founded`. The specific retracted LCCC claim is already guarded, but
   the ladder is general.
6. **All 15 claim guards pass**, per line and on the whole document.
7. **American English passes**, including the em-dash rule.

A line failing any check is not silently dropped: it is recorded with the
failure so the tailoring can be argued with.

### Where the text comes from

Reframing is model-assisted, and the model is given **only** the cited
evidence rows, never the full profile and never the job description's
phrasing to echo. It rewrites within the evidence it is handed. The seven
checks above then run on the output. The model proposes; the checks
dispose.

### Storage

`resumes` already has `tailored_for_job_id`, `tailored_for_job_version_id`
and `derived_from`. `resume_claims` gains the columns above. Every
tailored resume can be diffed against the master it derived from, which
is the review artefact.

---

## 4. Question and answer provenance

`question_bank` keys on `intent_key`, not wording, because "Are you
legally authorized to work in the US?" and "Do you have the right to work
in the United States?" are the same question. `question_occurrences`
records each employer's phrasing against the intent, with
`matched_confidence` and `matched_by`.

Answering a field runs in this order and stops at the first hit:

1. **Exact intent match** with an `approved_answer` and `reuse_allowed`
   → `VERIFIED`.
2. **Deterministic derivation** from a frozen profile row → `DERIVED`.
3. **Category C** (open-ended, job-specific: "why this company") →
   drafted from verified evidence, then subject to the same seven
   grounding checks as a resume line, then queued for approval as
   `HUMAN_CONFIRMED`. Never auto-approved.
4. **Category D** (sensitive: demographics, disability, veteran status,
   salary expectations, criminal history) → **never inferred**. Either an
   explicit stored preference exists, or `BLOCKED`.
5. **Anything else** → `BLOCKED`.

An intent matched below a high similarity threshold is `BLOCKED`, not
guessed. A near-match on wording is exactly where a wrong answer to a
legal question comes from.

### Answers become reusable only by explicit approval

When the user answers a blocked question, the answer is stored on **that
application**. `promote_to_bank` is a nullable boolean that starts null.
The queue offers "reuse this answer in future applications" as a separate,
unchecked action. Nothing is promoted automatically, and
`question_bank.reuse_allowed` already defaults false.

---

## 5. Blocked-question review queue

The primary mechanism, inside the portal. No email, no text.

Each row shows:

- company and job title, linking to the job card
- the **exact question as the employer worded it**, not the normalized
  intent
- why it could not be answered, in a sentence
- whether it is `UNKNOWN` (nothing in the profile speaks to this) or
  `AMBIGUOUS` (something does, but more than one reading is defensible) —
  a stored enum, because the two need different thinking from the reader
- **relevant verified evidence** that might help: the profile rows the
  matcher considered and rejected, with why. This is the difference
  between "answer this" and "answer this, and here is what you already
  said that is nearby."
- an input for the answer
- a separate, unchecked "make reusable" control

Answering sets `HUMAN_CONFIRMED` and re-evaluates
`all_fields_confident`. Clearing the last block moves the application to
`AWAITING_REVIEW`.

---

## 6. Assisted filling

**Local only.** The portal is on Vercel and holds no privileged
credential; browser automation runs on the Mac, in a browser session the
user is already signed into. The deployed app never drives a browser.

Sequence:

1. **Snapshot** the ATS form at prepare time: every field's selector,
   label, type, required flag, and options. Stored as
   `application_form_snapshot`.
2. **Map** each field to an answer. Unmapped required field → `BLOCKED`.
3. **Review** in the portal, against the snapshot.
4. **Fill**, locally, only fields whose answer is VERIFIED, DERIVED or
   HUMAN_CONFIRMED.
5. **Stop.** The browser is left on the completed form with the submit
   button untouched. The user reads and clicks it.

**Never filled, under any circumstance:** passwords, SSN or any
government identifier, payment details, date of birth. These are not
"blocked pending an answer"; they are outside what this system does.
Demographic and EEO fields are filled only from an explicit stored
preference, never inferred, and "decline to answer" is a legitimate
stored preference.

### Error recovery

- **Form changed since snapshot.** Fill compares the live form against
  the snapshot hash. Any difference in required fields aborts the fill
  and returns the application to `PREPARING` for re-mapping. Stale values
  are never typed into a changed form.
- **Browser fails mid-fill.** Filling is idempotent and re-runnable: each
  field is set from stored state, so a re-run converges. A partial fill
  cannot submit, because submission is a human action.
- **Field will not accept the value.** That field becomes `BLOCKED` and
  the application drops out of `READY_TO_SUBMIT`.
- **Posting changed.** `job_version_id` is frozen at DRAFT. If the live
  posting has a newer version, the review screen says so and offers
  re-preparation rather than silently applying to different text.

---

## 7. What is and is not stored

**Stored:** answers given, their provenance and evidence ids, the form
snapshot's structure, the tailored resume and its grounding checks, every
state transition, the exact employer wording of each question.

**Never stored:** passwords, API keys, session cookies, SSN, government
ID numbers, payment details, date of birth. `data_classification` already
has `CREDENTIAL_SECRET` with the comment "Never stored here", and that
stays true.

**Stored but classified `SENSITIVE`:** home address and phone, which
applications legitimately need. Already the case.

**Stored only as an explicit preference:** demographic and EEO answers,
as `D_SENSITIVE` question-bank rows the user created deliberately.

---

## 8. Migrations needed

    0039  field_confidence enum (VERIFIED, DERIVED, HUMAN_CONFIRMED, BLOCKED)
          application_answers: + field_key, field_label, is_required,
            confidence_state, blocked_reason, block_kind (UNKNOWN|AMBIGUOUS),
            evidence_ids, resolved_at, promote_to_bank
          drop is_confident in favour of confidence_state

    0040  applications: + PREPARING status, form_snapshot jsonb,
            form_snapshot_hash, prepared_at
          trigger: recompute all_fields_confident from answers
          trigger: enforce legal status transitions, write application_events

    0041  resume_claims: + source_text, generation, grounding_checks jsonb
          resumes: + tailoring_strategy, grounding_version

Duplicate protection needs nothing new: `applications_one_active_per_canonical_opening`
already prevents a second live application to the same requisition across
all its published variants, and `applications_one_active_per_job_post`
covers the individual posting.

---

## 9. Portal pages

- **Job card** gains "Prepare application", visible only when no live
  application exists for that canonical opening.
- **`/applications`** — list by state, with the queue count prominent.
- **`/applications/[id]`** — the review screen: tailored resume diffed
  against the master, every answer with its state and evidence, the form
  snapshot, and the approve control.
- **`/applications/queue`** — blocked questions across all applications,
  which is where the user will actually live.
- **`/applications/[id]/events`** — the audit trail.

Approval is a POST to a route handler, as with save and dismiss. The
authenticated portal role would need INSERT and UPDATE on `applications`
and `application_answers` — granted deliberately as part of building this,
per the least-privilege rule established in migration 0034, and nothing
wider.

---

## 10. What this does not do

- No automated submission. `submission_mode` stays `ASSISTED`.
- No credential entry, ever.
- No cover letters unless a posting makes one mandatory, per the standing
  preference.
- No application-volume target. Volume remains an output.


---

## 11. Application-specific portfolio attribution (designed, not built)

Every tailored resume will eventually carry a portfolio link unique to
the application that produced it. Stage 3 added exactly one thing for
it: `applications.attribution_token`, nullable and unique when present.
No endpoint, no analytics, no redirect, no public route.

Two things forced a decision now rather than later. The column would
otherwise have to be added to a table already holding real applications,
and the resume renderer would have hard-coded a literal portfolio URL.
`ResumeDoc.links` is now `ResumeLink[]` with `text` and `href` separate,
so the visible text can stay `tylerpleban.com` while the destination
varies per application. Today they are equal.

### The token

Generated by `lib/applications/attribution.ts`: 160 bits from a CSPRNG,
base64url. It encodes nothing. Not the employer, company, job title, job
id, application id, recruiter, personal detail or any sequence number.
Two tokens side by side reveal no relationship and neither helps guess a
third. `scripts/attribution-selftest.ts` asserts these as properties over
20,000 samples: uniform length, no constant character position, no shared
prefix pattern between consecutive tokens, and a generator that takes no
arguments, because a generator that accepts application data is one
refactor away from encoding it.

The database constrains shape only: 16 to 64 characters, `[A-Za-z0-9_-]`.
Randomness is the generator's job and is tested there.

### The eventual flow

    application -> opaque token -> tailored resume -> ATS website field
                -> public portfolio -> visit attribution -> private dashboard

Source attribution (resume PDF versus ATS website field) will be a
SEPARATE mechanism, and application attribution must never depend on it.
If a mail gateway, an ATS or a reader strips the source marker, the token
alone still identifies the application and the source is simply unknown.
That is the honest answer; a defaulted guess is not.

### What it is not

Application-level attribution, never individual-level. The defensible
claim is "someone used the link associated with this application". A
resume gets forwarded to a hiring manager, parsed by an ATS, opened by a
corporate link scanner and read by several people, and the design has to
preserve that uncertainty rather than resolve it. No fingerprinting, no
attempt to identify a person, and no labelling a visit as human when that
cannot be known.

The public portfolio must never expose which employer a token belongs to,
the job title, the application status, answers, notes, internal ids or
any scoring. A visitor with an attributed URL sees the ordinary public
portfolio. The portfolio stays broad and stable; career claims do not
change per employer. The tailored resume may emphasize different verified
evidence, which is a different presentation of the same truth.

---

## 12. What Stage 3 actually built

- `lib/applications/intents.ts` — intent catalog. Refusals (SSN,
  government ID, date of birth, payment details, passwords) are matched
  first and win outright. Matching is rule-based, not similarity-based:
  the failure mode of a threshold is a confident wrong answer to a legal
  question.
- `lib/applications/answer.ts` — the five-step resolver and the four
  states. Option fitting means a correct answer still blocks when the
  control does not offer it. Region names and abbreviations are treated
  as one value, because "OH" versus "Ohio" is a naming difference rather
  than an uncertainty.
- `lib/applications/formSnapshot.ts` — Greenhouse publishes its form,
  including demographic and compliance sections. Ashby does not without
  an employer key, and Lever is not implemented, so those refuse
  explicitly rather than guessing a field list.
- `lib/applications/prepare.ts` — freezes the posting version, tailors
  the resume through the existing guards, maps every field, writes the
  answers with their provenance.
- `lib/applications/attribution.ts` — token generation only.
- Portal: `/applications`, `/applications/[id]`, `/applications/queue`,
  `/applications/[id]/events`, plus prepare, answer and approve routes.
- `scripts/prepare-queue.ts` — the worker. The portal creates a DRAFT and
  stops, because preparation needs the model key and the deployed portal
  deliberately has none. That split is a credential boundary.
