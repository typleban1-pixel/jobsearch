# Technical debt

Things that are wrong but not urgent, with enough context that whoever
picks one up knows why it was left.

## The stored requirement-classification columns are dead

`supabase/migrations/0015_capability_graph.sql` added five columns to
`job_requirements`:

- `requirement_class`
- `concept`
- `education_level`
- `education_field`
- `taxonomy_version`

plus two indexes over them (`job_requirements_class_idx`,
`job_requirements_concept_idx`).

**Nothing has ever written to any of them.** Measured 31 Aug 2026:
`requirement_class` is null on all 24,525 requirement rows across all
1,769 jobs, and `concept` and `taxonomy_version` are populated on zero
rows. Classification is computed in memory at the point of use by
`classifyRequirement()` in `lib/scoring/requirementClass.ts`, which is
what scoring has always done.

**Why this matters.** Columns that look authoritative and are empty are
a trap, and the codebase fell into it twice:

- `lib/applications/prepare.ts` filtered themes on
  `requirement_class === "SKILL"`, matched nothing for every job, and
  every tailored resume was selected against a job title with no themes
  at all until it was fixed.
- `scripts/validate-stage3.ts` had the same filter, so its Stage 3
  validation was measuring the bug rather than the system.

**Current protection.** `scripts/themes-selftest.ts` walks every `.ts`
and `.tsx` file under `lib`, `scripts` and `app`, strips comments, and
fails if anything except the audit script names `requirement_class` or
`taxonomy_version`, or writes them in an insert or update. The runtime
contract is stated in the `roleThemes` doc comment: stored
classification is not the source of truth, classification is computed
from requirement text by the canonical classifier.

**The cleanup, when it is worth doing.** A migration dropping the five
columns and the two indexes, with a comment recording that
classification is computed rather than stored. Deliberately NOT done as
part of the selection fix: the columns cause no correctness problem
while nothing reads them, and the source-level guard is what actually
prevents recurrence. Dropping them is tidiness, and tidiness does not
belong in the same change as a correctness fix.

**Do not** resolve this by populating the columns. That would create a
second, persisted classification that can drift from the one scoring
computes, and a disagreement between them would be invisible.

## Two claims score zero, and the reasons are different

Recorded 31 Aug 2026 while fixing structurally unreachable project
evidence. **Neither is fixed here**, deliberately: both change relevance
scores across every posting and every role, and bundling that into a
change about project architecture would make it impossible to tell which
change moved which number.

### 1. The last word of every sentence is invisible to concept matching

This is a defect, not a gap. `wordsOf()` in `lib/render/relevance.ts`
tokenizes on `/[a-z0-9+#.-]+/g`. The `.` and `-` are there so that
"node.js", "c++" and "e-billing" survive as single terms, but the class
also swallows sentence-ending punctuation, so the final token of a claim
is `operations.` rather than `operations`, and no concept term ever
matches it.

Measured, against the SpotHero themes:

```
Supervised the day-to-day work of three student employees, and
managed day-to-day lab operations.            concepts NONE   score 0

...managed day-to-day lab operations          process_workflow  score 4
```

The same sentence, with one character removed from the end. Every claim
in the profile ends in a full stop, so every claim loses its last word,
and a claim whose only concept-bearing word is the last one scores zero
when it should not. The supervision line is one of those.

The fix is to strip trailing punctuation in `wordsOf` while keeping
internal dots and hyphens — roughly, match the current class then trim
`[.-]+$`. It is small. What is not small is the consequence: it changes
the score of most claims on most postings, which changes selection,
which changes every tailored resume. It needs its own pass, with a
before-and-after over a corpus of postings, not a footnote in this one.

### 2. There is no concept for supervising people, and none for audience scale

This one is a genuine dictionary gap, and it is separate from the bug
above. Even with the tokenization fixed, these two would still not
register against a posting that asks for them:

- **Supervision.** No cluster covers supervise, supervised, supervision,
  staff, direct reports, headcount, delegated, hired, onboarded as
  *people* rather than as process. `process_workflow` catches "lab
  operations" by accident, not "supervised three student employees" on
  purpose. A posting asking for "team supervision" scores that claim 0.
- **Audience scale.** "an audience of approximately 100,000 contacts"
  expresses `marketing_growth`, which is correct, and nothing else.
  There is no concept for reach or scale, so the size of the audience
  contributes nothing on a posting that cares about operating at scale.

Adding either is a scoring decision with the same corpus-wide blast
radius as the tokenization fix, and the same argument applies: measure
it deliberately, not as a side effect.

## Concept-level redundancy: prototyped, measured, rejected

Recorded 31 Aug 2026. Diagnostic item #3 proposed a second redundancy
signal working on concepts rather than words, because the lexical rule
misses three Genius One bullets that say substantially one thing while
sharing only 21-38% of their words. Each enumerates a DIFFERENT list over
the same territory, and the lists inflate the word count.

It was built and measured over the 212 same-entry claim pairs the v11
master holds. **It does not work, and it is not being adopted.**

**Identical concept sets fire on 0 of 212 pairs**, at every overlap
threshold from 0.10 to 0.30. Concept sets are large and heterogeneous:
the three bullets in question express 7, 3 and 3 concepts respectively.
Equality is unreachable.

The weaker subset relation -- one claim's concepts contained in the
other's, plus a shared core -- flags 2 pairs at overlap >= 0.15 and 1 at
>= 0.20:

- **A false positive.** The two Holley bullets ("Produced creative work
  across multiple brands..." and "Collaborated cross-functionally with
  marketing...") are genuinely different accomplishments, and the rule
  would have dropped the first.
- **A true positive** the lexical rule misses: "Contributed directly to
  product ideation and development..." against "Contribute to product
  ideation and development...", which are the past and present stints of
  one responsibility.

**The trio that motivated the whole exercise is not caught at any
threshold** -- pairwise overlap 0.14 to 0.16, and no subset relation,
because differing enumerations give the bullets genuinely different
concept signatures.

One true positive in 212 pairs, alongside a false positive that deletes a
real accomplishment, is not a basis for a rule whose failure mode is
destroying employer-facing evidence. The module's own doc comment already
states the principle: "two genuinely different accomplishments that
happen to cite one employment record must both survive, and a system that
quietly deletes one of them is destroying the resume to tidy it."

**Do not** revive this by lowering the overlap threshold. The measured
false positive appears at 0.15, below the point where the true positive
is the only hit. If the repeated-enumeration problem is worth solving, it
needs a signal that understands enumerations -- not a looser version of
one that does not.

## Tailoring produces vocabulary the profile does not have

Recorded 31 Aug 2026. Fixing NO_TARGET_TERMINOLOGY unblocked seven
rewrites that had been refused over words the profile does establish.
Six of the seven then failed the mandatory provenance gate anyway, on
words like "critical", "logs", "map", "rule", "opaque", "encompassing"
and "core business operations" -- vocabulary the model reached for and
the profile does not contain. So the RentPup bullets still print in their
verbatim evidence wording, which reads like internal documentation.

**This is a generation problem, not a guard problem.** Shorter wording
that expresses the identical supported predicate exists and passes every
gate. Two worked examples, both verified SUPPORTED with clean grounding
against the rows they cite, recorded here for the later tailoring-prompt
work:

- 8daaeff6 (CURRENT), 20 words:
  "Structured the product as four interconnected subsystems: property
  intelligence, monitoring and alerts, customer compliance workflow, and
  growth and CRM intelligence."

- 38893886 (CURRENT), 21 words against the evidence's 39:
  "Connected detected changes to delivery: a scheduled job recomputes
  obligation statuses and then sends deadline notifications, watchlist
  reminders and status-change alerts."

These are illustrations of what a better prompt should produce. They are
NOT to be written into the evidence summaries: the evidence is what the
user confirmed, and editing it to match a resume is the exact inversion
this project exists to prevent.

The third selected claim, 37bda77e, is BUILT_BUT_PAUSED. A 39-word
version of it is provenance-SUPPORTED and still correctly refused by
NO_STATE_ESCALATION. That guard is not to be relaxed: a paused claim
appears in its own words or not at all.

## Greenhouse descriptions omit content the employer's own page shows

Recorded 1 Sep 2026, while fixing the application-form URL defect. **Not
fixed here**, deliberately: it is a different failure from the
compensation parser bug and conflating them would hide both.

Stripe's careers page for AEO and GEO Marketing Manager states:

> The annual US base salary range for this role is $143,400 - $215,200.

Our stored `description_text` for that job is 4,182 characters and does
not contain it. Searching for `143,400`, `215,200` or "annual US base
salary" finds nothing. The Greenhouse API's `content` field for this
posting simply does not carry the pay section; Stripe renders it from
their own CMS on stripe.com.

**This is not the 401k-label bug.** Migration-era parser defects were
about failing to read text we had. Here the text was never ingested, so
`parseSalaryFromText` had nothing to work with and no parser change
would have helped.

**Why it matters.** `compareToFloor` correctly treats unknown salary as
INDETERMINATE, so these jobs survive the hard floor on the strength of
an absence. For Stripe that absence is benign: $143k-$215k is far above
the $85,000 floor. The gap is that we cannot know that from our own
data, and 575 Stripe jobs are in this state. The same is likely true of
other custom-board employers whose careers pages render sections the API
body omits.

**What a fix would involve.** Fetching the employer's rendered page
rather than trusting the API body, for the employers where the two
diverge, and reconciling the two descriptions. That is a real ingest
change with its own blast radius: it changes `content_hash` inputs, and
therefore what counts as a job version, for every affected posting. It
needs measuring on its own.

**Do not** solve it by scraping only the pay section and stitching it
into the stored description. A description that is partly the API body
and partly a scrape is neither, and `content_hash` would stop meaning
what it says.
