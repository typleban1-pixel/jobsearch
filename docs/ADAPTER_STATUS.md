# ATS adapter status

What each application adapter can do, and where it deliberately stops.

A handoff in the "intentional" column is not a gap. The system is built so
that the boundary between what it will do and what a person must do is
explicit, and every row below that says HANDOFF is a place where guessing
was the alternative.

| Provider | Ingest | Application automation |
| --- | --- | --- |
| Greenhouse | production | **production, frozen** |
| Lever | production | assisted (fill + readback; a person clicks submit past hCaptcha) |
| Ashby | production | **production candidate** — rehearsed on seven live forms 2026-09-07; proving on real submissions |

---

## Greenhouse — frozen

Frozen as of the Stripe submission (application `aca9a368`, confirmed by the
live board and recorded from its confirmation, not from the click). No
further hardening without a real application exposing a real defect.

### Form resolution

The application form is the embed route,
`job-boards.greenhouse.io/embed/job_app?for={token}&token={id}`. The board
route `/{token}/jobs/{id}` 302s to the employer's own careers page, which is
a job description and not a form; a 200 and a matching title are not
evidence that a URL is a form, and treating them as such once put 2,401
wrong URLs into the corpus.

The board token comes from ingest, never inferred from a hostname. The
derived URL is verified to resolve to the same employer and job id before
use, and resolution fails closed: no fallback to clicking an "Apply" link on
an employer page.

### Supported

- **Exact artifact binding.** The approved résumé bytes are hashed and
  compared to `approved_artifact_sha256` before anything opens. The document
  approved is the document uploaded, or the run stops.
- **Deterministic upload identity.** `input#resume` and `input#cover_letter`
  by DOM identity, never by visible "Attach" text or field order. The
  activator is resolved before `setInputFiles`, because resolving it after
  can race a re-render.
- **Snapshot v2** covering text, selects, react-select comboboxes, the
  location control, repeatable education, file inputs, and the EEO block.
  The stored hash is compared to the live form; a required field that
  differs is `FORM_CHANGED`.
- **Async typed-filter comboboxes.** School and similar controls are typed
  into, the filtered listbox is read scoped to that control, and only an
  exact normalized match to the reviewed answer is selected. Never the first
  result, never substring, never nearest.
- **Location as geography, not text.** The city is the search term; the
  committed option must match componentwise after expanding `OH` to Ohio and
  `US` to United States. "City of Cleveland", "Cleveland Heights", "East
  Cleveland" and "Cleveland, Tennessee" are all refused.
- **Repeatable education** with the degree vocabulary read from the board's
  own API.
- **Dynamic conditional fields.** Up to four rescans keyed on controls that
  are still empty, not on controls not yet seen, because a field can be seen
  early and only become answerable later.
- **Confidence states.** VERIFIED / DERIVED / HUMAN_CONFIRMED / BLOCKED,
  resolved from provenance. Storage is not evidence: a `USER_RESPONSE`
  self-declaration resolves HUMAN_CONFIRMED and can never reach VERIFIED.
- **SubmitGuard**, four independent layers, armed for the whole fill and
  released only at HANDOFF.
- **Submission with genuine confirmation.** The submit control is resolved
  structurally inside the form and must be exactly one element. After the
  click, the live page has to say it received the application, and say
  nothing contradicting that, before `SUBMITTED` is written. A click is not
  a submission and a 200 is not a confirmation.
- **Ordinary email OTP**, via Gmail, only after a submitted form asks for a
  code and only when the form's own wording is verifying an address or an
  account. See `lib/gmail/verification.ts`.

### Intentional handoffs

| Situation | Outcome |
| --- | --- |
| Page says it is confirming a human | `SUBMIT_BLOCKED_HUMAN_VERIFICATION` |
| Page asks for a code without saying what it verifies | `SUBMIT_BLOCKED_VERIFICATION_UNRESOLVED` |
| Visible CAPTCHA challenge | `CAPTCHA` |
| An option cannot be matched exactly from the live choices | HANDOFF, options shown |
| A school the board does not offer | left unrecorded, never substituted |
| Required field with no confident answer | `REQUIRED_FIELD_BLOCKED` |
| Submit control resolves to zero or several elements | `SELECTOR_AMBIGUOUS` |
| Duplicate, login, or validation text introduced by the click | not marked submitted |
| Zero, several, or ambiguous OTP messages or codes | HANDOFF |
| Read-back does not match what was typed | `READBACK_MISMATCH` |

Stripe's form is the worked example: it asks for an eight character code
"to confirm you're a human", so it classifies HUMAN_PRESENCE and stops.
That is the general rule firing on the employer's own words, not a
special case, and it is asserted by test.

### Known limits, not defects

- The Stripe posting's salary is not in the board payload; documented in
  `TECH_DEBT.md` and out of scope for the adapter.
- `job_versions` still holds original salary nulls for 81 renormalized jobs.
- `capability_durations` is recorded but not yet wired into Fit or candidacy.

---

## Lever — not started

Ingest is production (1,465 jobs). Application automation is not
implemented. `apply_url` already points at the real form
(`jobs.lever.co/{token}/{id}/apply`), so no URL derivation is needed.

## Ashby — production candidate

Ingest is production. Application automation shares the Greenhouse engine
(`lib/browser/fill.ts`, `scripts/submit-application.ts`); the Ashby-specific
parts live in `lib/browser/ashbyForm.ts` and `lib/browser/submitGuard.ts`.

### What was actually wrong

Four live submit attempts on 2026-09-05 were rejected by Ashby with
"Missing entry for required field: Name" while every field was visibly
filled and read back as committed. Ashby autosaves each field change to a
server-side draft (`ApiSetFormValue` on `/api/non-user-graphql`) and
validates the submission against THAT draft. SubmitGuard's request layer
blocked those autosaves as "benign when blocked", so the draft was empty.

### Form model

Every question is one `_fieldEntry_` container: a `_label_` node (class
`_required_` marks required), an optional `_description_`, and controls:

| Control | Rendered as | Discovered as |
| --- | --- | --- |
| text / textarea / file | a named input | the generic field |
| single-select | radios named `{qid}_{optid}`, one name per option | `radio-group` keyed by the question |
| system EEO | radios sharing one name `…__systemfield_eeoc_*` | `radio-group` keyed by that name |
| pick-many | checkboxes NAMED BY OPTION TEXT ("Other" recurs) | `checkbox-group` keyed by the question |
| Yes / No | two `button[aria-pressed]` + a hidden backing checkbox | `ashby-button-group` |
| location, self-ID | one anonymous react-select `[role=combobox]` | `ashby-combobox` |

`normalizeAshbyFields` builds one field per entry and drops the generic
duplicates; preparation and the fill both use it, so the form reviewed is
the form filled.

### Supported

- **Guard by operation name.** `classifyAshbyOp` allow-lists the form's
  known non-submitting operations (autosave, geo and school lookups, the
  resume autofill parse, consent) and blocks every `ApiSubmit*` mutation
  while armed. An operation not on the list is blocked and counts as a
  possible submission attempt. The two upload ops stay gated to the
  approved-artifact upload window.
- **Hydration and commit proof.** Fills wait for the React form to mount;
  text is committed through the framework and verified against the
  field's own store, a render tick later.
- **Upload first, then wait for the autofill parse to settle.**
- **Location pickers** are matched as geography: the city is tried, then
  the profile's state, then its country (employers configure pickers that
  offer only one kind of place); the committed value is read from Ashby's
  field state. A coarse prepared answer ("United States") fills a city
  picker with the profile's own city.
- **Pick-many** answers may name several options ("A; B"); exact option
  text only, country-name equivalence as the fallback.
- **Self-identification.** Confirmed answers are entered, with standard
  synonyms and the federal "(Not Hispanic or Latino)" qualifier
  tolerated. An optional self-ID question nobody answered takes the form's
  own decline option. An unanswered system EEO field is left blank.
- **Rehearsal.** `scripts/fill-application.ts <app> --validate` runs the
  whole fill without approval and never clicks; the run output's
  `submission guards:` line must read "nothing attempted".

### Intentional handoffs

| Situation | Outcome |
| --- | --- |
| Multi-step form (Next with no Submit) | `AMBIGUOUS_NAVIGATION` |
| A required question with no confident answer | `REQUIRED_FIELD_BLOCKED` |
| A picker that offers nothing equal to the answer | `READBACK_MISMATCH` |
| An option without a unique selector | `SELECTOR_AMBIGUOUS` |
| A video or recording upload | blocked; not automatable |
| Visible CAPTCHA | `CAPTCHA` |

### Proof

Rehearsed to HANDOFF on 2026-09-07 with no guard hits: Fieldguide (location
picker, pick-many, three EEO groups, radio group), Modern Treasury,
Roboflow, Verse Medical (pronoun radio group, three button groups), Ashby's
own form (textareas, city picker, self-ID). The acceptance bar set by the
user: five applications submitted by the program.
