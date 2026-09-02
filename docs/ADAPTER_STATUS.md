# ATS adapter status

What each application adapter can do, and where it deliberately stops.

A handoff in the "intentional" column is not a gap. The system is built so
that the boundary between what it will do and what a person must do is
explicit, and every row below that says HANDOFF is a place where guessing
was the alternative.

| Provider | Ingest | Application automation |
| --- | --- | --- |
| Greenhouse | production | **production, frozen** |
| Lever | production | not started |
| Ashby | production | not started |

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

## Ashby — not started

Ingest is production (407 jobs). Application automation is not implemented,
and is not next.
