# Browser-assisted filling: architecture

Proposal. Nothing here is built.

The operating rule is unchanged and shapes every decision below:
**prepare automatically, fill only supported answers, stop on
uncertainty, you submit.** There is no automated submission and no code
path that produces one.

---

## 1. Where it runs, and why that is the whole design

Filling runs **locally, on the Mac, in a real Chrome profile you are
already signed into.** It is a script you start, not a service.

This is forced rather than chosen. The portal is on Vercel with a
publishable Supabase key and nothing else: no service role, no model key,
and no employer credentials anywhere. A hosted filler would need a
browser, a session, and secrets, which is three boundaries crossed to
save one command. The same split already exists for preparation
(`scripts/prepare-queue.ts`), and filling extends it rather than
inventing a second pattern.

    portal (Vercel)        decide to apply, review, answer, approve
    worker (local)         snapshot, tailor, map, FILL
    you                    read the filled form, click submit

### Technology

**Playwright, driving a persistent Chrome profile** via
`launchPersistentContext` against a dedicated user-data directory.

- A persistent profile means you sign in once per ATS, by hand, and the
  session survives. No credential is stored by this system, ever.
- Playwright over Puppeteer for its auto-waiting and locator model, which
  matters when a field only appears after another is answered.
- **Headed, always.** A headless fill of a form a human must then submit
  is a form nobody read. You watch it happen.
- Not the Chrome extension already connected to this session: that is an
  interactive tool for me, and filling must be a reproducible script that
  runs the same way every time and leaves an audit trail.

---

## 2. Provider handling

Three providers, three different amounts of help.

| | form discovery | notes |
|---|---|---|
| **Greenhouse** | already solved | `?questions=true` publishes the real form: labels, types, required flags, options, demographic and compliance sections. Preparation already uses it. The DOM is a predictable `job-boards.greenhouse.io` embed; field `name` attributes match the API's `fields[].name`, which is the join key. |
| **Lever** | live DOM only | No public form API. Fields are stable `name="cards[...]"` / `name="urls[...]"` patterns. Snapshot by reading the DOM. |
| **Ashby** | live DOM only | Posting API returns 401 for the form. A React app with generated ids, so **label text is the only durable anchor** and positional selectors must never be used. |

Two of three therefore need a **live DOM snapshot**, which is the same
`FormSnapshot` shape `lib/applications/formSnapshot.ts` already produces.
That is deliberate: one shape, two sources.

    snapshotForm(source, token, externalId)   API, where published
    snapshotLive(page)                        DOM, everywhere else

A live snapshot walks every labelled control, resolving its label from
`<label for>`, `aria-label`, `aria-labelledby`, or the nearest preceding
legend, and records `{ key, label, type, required, options }` plus a
**selector strategy** (see §4). An unlabelled required control is a stop
condition, not a guess.

---

## 3. Discovering the form live

1. Open `applications.job_id`'s apply URL in the persistent context.
2. Wait for network idle plus a settled DOM (Ashby renders in stages).
3. If the page is a login wall, an SSO redirect, or a CAPTCHA, **stop**
   (§9).
4. Walk the form, build the snapshot, hash it (`hashSnapshot`, already
   written: structure only, sorted options, no timestamps).
5. Compare with `applications.form_snapshot_hash`.

For Greenhouse the API snapshot is authoritative for *semantics* and the
DOM snapshot is authoritative for *selectors*; they are joined on field
name, and a field present in one but not the other is a stop condition.

---

## 4. Mapping prepared answers to live controls

Answers are already resolved and stored per field with their provenance.
Filling adds only the last mile: which control receives which answer.

**Selector strategy, in order, first that resolves uniquely:**

1. `name` attribute (Greenhouse, Lever)
2. `id` attribute, if not obviously generated
3. Accessible label text, exact match
4. `data-*` test attribute, where the ATS provides one

**Never** an nth-child path, an index, or coordinates. If no strategy
resolves to exactly one control, that field is not filled.

Type handling is per control, and each verifies what it wrote:

- text / textarea → fill, read back, compare
- select → choose by exact option text, using the same
  region-name-and-abbreviation equivalence the resolver already applies
- radio / checkbox → click the option whose label matches exactly
- multi-select → only when every intended value maps to an option
- combobox (Ashby) → type, wait, click the exact match, verify

A value that does not read back identically is a failure for that field,
not a retry with something looser.

**Only VERIFIED, DERIVED and HUMAN_CONFIRMED are typed.** BLOCKED is
never filled and never skipped silently: it is left empty and named in
the run report. Refused fields (SSN, government ID, date of birth,
payment details, passwords) are not filled under any circumstance, which
is already enforced upstream in `intents.ts`.

---

## 5. File upload, and parser interference

The resume is a real file, so filling needs one. The worker renders the
tailored resume to PDF locally and sets `setInputFiles` on the file
control. The filename is professional and stable, `Ty Pleban -
Resume.pdf`: never the company name, never an id. After upload the worker
waits for the ATS to acknowledge; no acknowledgement is a stop condition.

Cover letters are uploaded only when the posting makes one mandatory.

### Ordering is per provider, and evidence-based

Some ATS platforms parse an uploaded resume and populate fields from it,
overwriting whatever is already there. **Greenhouse is known to do this.**
Ashby and Lever are not known either way, and assuming they behave the
same would be inventing a fact about someone else's software.

Two separate things are recorded per provider, and conflating them is
how an assumption becomes a finding.

    parser_mode       what the parser has been OBSERVED to do
                      PARSER_OVERWRITES | PARSER_INERT | UNKNOWN

    upload_ordering   what the worker CHOOSES to do
                      UPLOAD_FIRST | UPLOAD_LAST

**All three providers start at `UNKNOWN`, including Greenhouse.** It is
documented as parsing uploaded resumes, but across three live board forms
the upload was acknowledged and not one field was populated.
Documentation is not an observation.

**Greenhouse still uploads first.** That is a safety choice held
independently of the evidence: reconciling a parse that never happens
costs nothing, while filling before a parse that does happen loses the
answers. Ashby and Lever upload last and measure.

Evidence moves the mode asymmetrically, because the two directions are
not equally conclusive. One run seeing a field move proves the parser
overwrites. Runs seeing nothing move prove only that nothing moved on
those forms, so they accumulate, and `PARSER_INERT` is not recorded until
ten runs agree. Until then the mode stays `UNKNOWN`, which is the honest
answer. An observation never changes the ordering: what we do is a
decision, not a side effect of measuring.

### Reconciliation, when the parser does populate fields

For an upload-first provider the sequence is upload, then **re-read
the live form**, then compare field by field against the prepared
answers:

| what the parser did | what happens |
|---|---|
| filled a field, matching our prepared answer | left alone, recorded |
| filled a field, differing from our prepared answer | overwritten with ours, then verified by read-back |
| filled a field we have **no** prepared answer for | **left as the parser set it, and reported.** It is the employer's own reading of a resume we wrote; it is not a claim this system is making, and blanking it would be an edit nobody asked for |
| filled a field whose prepared answer is BLOCKED | **stop.** A parser-inferred value standing in for an answer we deliberately refused to give is precisely the failure the confidence states exist to prevent |
| our value will not overwrite it | that field becomes BLOCKED and the run stops |

The reconciliation report is part of the run record, so what the ATS
inferred is always distinguishable from what we asserted.

## 6. Dynamic and multi-step forms

Handled as a loop rather than a single pass:

    fill what is visible and mapped
      -> re-snapshot
      -> did new fields appear?
         yes: map them; unmapped required field -> stop
         no:  done with this step
    -> next step, if the form has one

Conditional fields ("if other, please specify") are exactly the case that
breaks a single-pass filler, so the loop re-reads after every change. A
step boundary is crossed only by an explicit Next/Continue control, never
by anything that could be a submit. The loop has a hard iteration cap;
hitting it stops the run.

---

## 7. Detecting a changed form

The question this asks is narrow and worth stating exactly, because the
first implementation asked a different one and read every Greenhouse
form as changed.

**The invariant: a required field you reviewed may not disappear or
materially change.**

1. **Reviewed required fields must still be present.** Any required
   field from the reviewed snapshot that is missing from the live form
   aborts the run and returns the application to `PREPARING`. Stale
   answers are never typed into a changed form.
2. **A reviewed required field whose options changed incompatibly** is
   the same failure: an answer that is no longer offered is not an
   answer.
3. **A newly required field blocks.** A control the live form requires
   and the reviewed snapshot does not know about has no prepared answer,
   so it stops as a blocked required field. It is reported by label, not
   silently skipped.
4. **DOM-only optional, helper and duplicate controls are not form
   change.** The reviewed snapshot comes from the board API and the live
   one from the DOM, and the DOM is always the richer description: a
   country selector beside a phone input, a location autocomplete, a
   label-keyed duplicate of a control that has no name. None of that is
   the employer editing the posting.

The earlier rule compared the two sets symmetrically and treated any
difference in either direction as change. Because the two sources
describe the same form at different resolutions, that fired on every
Greenhouse form and filled nothing. Comparing DOM against API for
identity was the error; the reviewed set is the baseline, and only its
loss counts.

Separately, `applications.job_version_id` is frozen at DRAFT. If the
posting has a newer current version, filling refuses rather than applying
against text nobody read.

## 8. Login, sessions, SSO, CAPTCHA

**The system never authenticates.** It cannot: entering credentials is
outside what it does, and no password, token or session cookie is stored.

- **Session state** lives in the persistent Chrome profile on disk,
  created by you signing in normally. The worker reads it by using the
  same profile.
- **Login wall detected** → stop, report "sign in to <ATS> in the browser
  profile, then re-run". The run resumes cleanly.
- **SSO / OAuth consent** → stop. Granting permissions is your decision.
- **CAPTCHA or any anti-bot challenge** → stop immediately. It is never
  solved, worked around, or retried, and no behavioural mimicry is used
  to avoid triggering one. If an employer's form requires proving a human
  is present, that is the correct outcome: a human is present.
- **Rate limiting** → one application at a time, ordinary page loads, no
  parallel tabs against one employer.

---

## 8a. An unresolved required field blocks completion, not filling

Stopping at the first unanswerable required field left a barely-filled
form when every other field was answerable, which is worse for the
person who has to finish it. A stop is terminal for the RUN, not a
reason to abandon work already possible.

So:

1. Unresolved required controls are **collected**, not thrown on.
2. Every **independently supported** field is filled and read back.
3. The run ends on `REQUIRED_FIELD_BLOCKED`, naming all of them.
4. **No step is ever advanced** while anything required on the current
   step is unresolved. That guard lives inside `advanceStep`, not at its
   call site, so a future caller cannot forget it.

### Independently supported

A field is not filled if its meaning depends on an unresolved control.
Three signals, all read off the DOM rather than assumed:

- **grouping** — the two sit in one `fieldset` or `role="group"`, so the
  form asks them together;
- **association** — one declares `aria-controls`, `aria-owns` or
  `aria-describedby` pointing at the other;
- **calling code** — a `type="tel"` input beside an unresolved control
  whose options are dial codes. Greenhouse labels that control simply
  "Country", and typing a national number while the calling country is
  unset records a different phone number than the one intended.

Observed live: where such a control is unresolved the phone is deferred,
and on a form without one the phone is filled.

### Dynamic forms

Filling can change the page, so the DOM is re-read after every write. A
field that appears is picked up in the same pass: filled if it has a
supported answer, added to the unresolved set if it is required and does
not.

## 9. Stop conditions

Filling stops, leaves the browser open on the form, and writes what it
did. It never "does its best".

- a required field is BLOCKED, unmapped, or ambiguous (after everything
  independently supported has been filled, per §8a)
- a selector resolves to zero or several controls
- a value does not read back as written
- the form hash changed in a required field
- the posting has a newer version
- a login wall, SSO prompt, or CAPTCHA
- an unlabelled required control
- an upload with no acknowledgement
- the dynamic-field loop hits its cap
- a control cannot be shown to be a step advance rather than a final
  submission (§13)
- any submit event fires, or any submission-shaped request is attempted
- a resume parser populates a field whose prepared answer is BLOCKED

---

## 10. Failure recovery

Filling is **idempotent and re-runnable.** Every value comes from stored
state, so a second run converges on the same form rather than
compounding. A partial fill cannot submit, because submission is not a
thing the system does.

- Field-level failure → that field becomes BLOCKED, the application drops
  out of `READY_TO_SUBMIT` (the existing trigger already does this), and
  it appears in the queue.
- Page-level failure (navigation, crash) → the run aborts, the
  application returns to `READY_TO_SUBMIT`, nothing is marked submitted.
- The browser is **never closed on failure.** You see the state it
  reached.

---

## 11. Audit trail and screenshots

Every run writes `application_events` rows through the existing trigger
discipline, plus a new `application_fill_runs` record:

    started_at, finished_at, outcome, provider,
    form_snapshot_hash_at_fill, fields_attempted, fields_filled,
    fields_left_blank, stop_reason

**Screenshots** are captured at three points: form loaded, fill complete,
and any stop condition. Stored locally under a run directory, not in the
database, and not in the portal. They are the record of what the
employer's page actually looked like, which is the only durable answer to
"what did it fill in".

A screenshot of a filled form contains your address and phone. It stays
local, and the run directory is gitignored.

---

## 12. How HUMAN_CONFIRMED answers reach the form

They already flow, without a new mechanism. The queue writes
`application_answers.confidence_state = HUMAN_CONFIRMED` with the text
you supplied. The filler reads answers by field key and treats all three
non-blocked states identically: an answer is an answer, and where it came
from is recorded, not re-litigated at fill time.

The one asymmetry worth stating: a HUMAN_CONFIRMED answer that you left
deliberately blank is filled as blank, which is different from a field
nobody looked at. The state distinguishes them; the filler honours it.

---

## 13. Submission stays yours, structurally

"Never submits" is not a rule the filler follows. It is a thing the
filler is unable to do, enforced at four independent layers. A denylist
of button labels is the last of them and the weakest, because a button
reading "Continue" that posts an application is exactly the case a
label check cannot see.

### Layer 0: there is no submission code path

The filler's action vocabulary is a closed allow-list of five primitives:

    fillText  selectOption  setChecked  setFiles  readBack

None of them can activate a page-level control. Option selection inside a
resolved control (a listbox item, a radio label) is scoped to descendants
of that control and cannot reach a form button. **The answer-filling
layer has no click primitive at all.**

Exactly one function in the module can click a page-level control,
`advanceStep`, and it is subject to §13.1. There is no submit function,
no `--submit` flag, no environment variable, no debug mode, and no
configuration value that produces one. `submission_mode` remains
`ASSISTED`, and a test asserts the exported action list is exactly those
five primitives plus `advanceStep`, so adding a sixth is a failing test
rather than a code review someone might skim.

### Layer 1: structurally submit-capable controls are refused

Refused on structure, before any text is considered, whatever the label
says:

- `input[type=submit]`, `button[type=submit]`, `input[type=image]`
- a `<button>` inside a `<form>` with **no** `type` attribute, because
  the HTML default is `submit`
- anything carrying `formaction`, or a `form=` attribute associating it
  with a form
- the form's implicit default button

A control that passes this is *not yet* clickable; it is merely not
disqualified.

### Layer 2: submit events are cancelled and treated as failures

An init script installed on every page adds a capture-phase `submit`
listener at the document level that calls `preventDefault()` and
`stopImmediatePropagation()`, and records the attempt.
`HTMLFormElement.prototype.submit` and `requestSubmit` are replaced with
functions that record and throw.

So a misjudged click does not submit an application; it produces a
cancelled submit event, which is a **hard stop** with the attempt in the
run record. This is the layer that makes the guarantee hold even when
layers 0 and 1 are wrong.

### Layer 3: submission-shaped requests are aborted

During the automated phase, `page.route` aborts every POST, PUT and PATCH
to the page's own origin except an explicit allow-list for file upload
and autosave. An aborted request is a hard stop.

This covers the single-page case that layer 2 cannot: a React form that
submits with `fetch` and never fires a `submit` event at all.

### Layer 4: the accessible-name denylist

Defence in depth, and **explicitly not the primary mechanism.** Names
matching submit-like wording are refused. It exists to catch the case
where the first three layers are all somehow satisfied, and it is
expected to be redundant.

---

### 13.1 Next/Continue versus final submission

This is the hard part, and the honest answer is that it is sometimes
undecidable. A React "Continue" button and a React "Submit application"
button can be structurally identical: both `type="button"`, both wired to
a JavaScript handler.

`advanceStep` clicks a control only when **every** one of these holds:

1. it survived layers 1 and 4;
2. the form shows positive evidence of being multi-step: a step
   indicator, `aria-current="step"`, a progress element, or required
   fields named in the API snapshot that are not present in the DOM;
3. a one-shot submit probe is armed immediately before the click, so any
   submit event is cancelled and converted into a stop;
4. request interception is armed, so any submission-shaped request is
   aborted and converted into a stop;
5. after the click, the page shows a **new step** with fields still to
   fill, and not a confirmation, thank-you, or application-received
   state.

**If evidence for (2) cannot be established, the filler does not click.
It stops and hands the form to you.** That is not a degraded outcome: a
partly filled multi-step form that a person finishes is exactly the
intended product of a system whose rule is "stop on uncertainty".

The `application_fill_runs` record distinguishes `STOPPED_AMBIGUOUS_NAV`
from other stops, so if a provider turns out to be reliably decidable,
that is a change made deliberately with evidence, rather than a threshold
quietly loosened.

### Handoff

A successful run ends by tearing down all four automation-phase guards in
a single `handoff()` call, printing what was filled and what was left,
and leaving the browser open on the completed form with the submit
control untouched. The process then exits, so nothing can click anything
afterwards: the teardown is the last thing that happens.

You submit. The existing constraint stands unchanged: `SUBMITTED`
requires `human_approved`, `all_fields_confident` and a `submitted_at`.

### Recording that you actually submitted

The system cannot observe your click, and inferring it would be
manufacturing a fact. So it asks:

- The portal's application screen gains **"I submitted this"**, enabled
  only from `READY_TO_SUBMIT`, which sets `submitted_at` and moves the
  application to `SUBMITTED`.
- Optional confirmation reference, if the ATS gave you one.
- Nothing is auto-detected. A confirmation page appearing is not proof
  you sent it; you saying so is.

Later, `confirmation_email_received` can corroborate this from mail, but
that is a separate phase and it corroborates rather than decides.

## 14. What this does not do

- No automated submission, in any mode, under any flag, environment
  variable or debug setting. There is no code path to disable.
- No credential entry, account creation, or password handling.
- No CAPTCHA solving or anti-bot evasion.
- No filling of SSN, government identifiers, date of birth or payment
  details.
- No demographic or EEO answer that is not an explicit stored preference.
- No headless operation.
- No filling against a form that changed, or a posting that moved on.

---

## 15. Migration sketch

    0048  application_fill_runs (id, application_id, started_at,
            finished_at, outcome, provider, form_snapshot_hash_at_fill,
            fields_attempted, fields_filled, fields_left_blank,
            stop_reason, screenshot_dir, parser_reconciliation jsonb)
          ats_form_behaviour (provider primary key, parser_mode,
            upload_ordering, observation_count, observed_at, evidence)
          fill_outcome enum: exactly the worker's stop reasons, with no
            value meaning the system submitted anything
          applications: + submitted_by_human_at is unnecessary;
            submitted_at already exists and is the field

Portal grant: INSERT/UPDATE on `applications` already exists for the
"I submitted this" control. `application_fill_runs` is written by the
local worker with the service role, and is read-only to the portal, which
keeps the fill record outside anything the browser role can edit.
