# Scoring-design issues

Diagnosed, quantified, and deliberately not fixed. Each entry records the
mechanism and the measurement, so that whoever revisits scoring design is
arguing with numbers rather than re-deriving them.

Nothing here may be solved with occupation blacklists, title exclusions,
or one-off rules for particular requirement strings such as "high school
diploma" or "bachelor degree". The problems below are general, and a
special case would hide them rather than fix them.

---

## 1. Equal requirement weighting over-values low-information requirements

Every HARD concept carries `HARDNESS_WEIGHT = 3` regardless of how much
it discriminates between candidates. "High school diploma" and "8+ years
leading enterprise implementations" contribute identically.

Measured on 556 eligible jobs, profile version 5, weights v4, using
inverse document frequency across the corpus rather than any judgement
about which requirements are worth having:

| concept | demanded by | credited in his favour | class |
|---|---|---|---|
| bachelor degree | 74 | 67 | EDUCATION |
| cross-functional collaboration | 63 | 63 | SKILL |
| project management | 34 | 34 | SKILL |
| stakeholder management | 20 | 20 | SKILL |
| high school diploma or GED | 13 | 13 | EDUCATION |

Each of these resolves in his favour essentially whenever it appears, so
it separates him from no other candidate while contributing exactly as
much coverage as a requirement that does.

Corpus-wide the low-information credit splits EDUCATION 67 / SKILL 63, so
this is not an education-specific problem and must not be fixed as one.

## 2. Sparse postings amplify every match, because coverage is a ratio

`coverage = Σ(weight × credit) / Σ(weight)` over evaluable concepts. The
denominator is however many evaluable concepts the posting happens to
contain, which ranges from 4 to 19 across the corpus.

Consequence, measured: **one HARD match is worth a median of 23.3 Fit
points in a job with ≤4 evaluable concepts, and 5.7 in a job with ≥10.**
A four-fold difference driven entirely by posting length.

The ratio is not itself the defect. It was introduced deliberately to fix
the opposite problem, where Fit correlated −0.75 with requirement count
and a thorough posting was punished for being thorough. The defect is the
interaction of the ratio with issue 1: uniform weights mean a short
posting stating one universal requirement scores like a long posting
whose substantive demands were met.

Denominator decomposition, corpus-wide: 8,069 requirements become 7,284
evaluable concepts. 1,392 removed as trait/generic/constraint, 22 as
UNCLEAR hardness, 24 as UNKNOWN resolution. **The exclusions are working
as designed and are not the problem.**

## 3. The distortion is concentrated where it does damage

Across all ordered pairs the effect looks negligible: 1,332 of 154,290
(0.86%) rank a job with fewer credited concepts more than 2 points above
one with more.

But **14 of the top 20 jobs are elevated primarily by one or two
low-information matches.** Samsara Enterprise Customer Success Manager
reaches Fit 19 on a single credited concept, "bachelor degree", worth 27%
of its achievable total. Included Health Consultant Relations Director
reaches 18 the same way with 4 evaluable concepts. Four Gopuff Operations
Associate / Starbucks Barista postings reach 14 to 18 on "high school
diploma or GED" alone.

The top of the ranking is the only part that gets acted on, so a
corpus-wide average understates this badly. Any future fix should be
evaluated on the top of the ranking, not on aggregate correlation.

## 4. DIRECT receives no additive bonus; TRANSFERABLE receives two things

There is no additive DIRECT term anywhere. Fit's skill contribution is
only `coverage × coverage_scale`, and DIRECT influences it solely through
`creditFor("DIRECT") = 1.0`.

TRANSFERABLE, by contrast, receives **both** `creditFor = 0.5` inside the
coverage ratio **and** a separate additive `fit.transferable_skill = +2`
per concept in `score2.ts`.

So a transferable match is rewarded through two channels and a direct
match through one. Whether that is intended is a scoring-design question,
not a bug to patch in isolation, and it should be settled when the
ranking model is revisited. Note that the additive term does not divide
by the denominator, so it also behaves differently from coverage as
posting length varies.

---

## 5. RESOLVED — Information weighting amplified the trivial-requirement problem

Measured after committing weights v5 / fit formula 2 on 488 eligible jobs.

Inverse document frequency measures rarity in the corpus. It does not
measure triviality, and in this corpus the two point in opposite
directions:

| concept | df | information weight |
|---|---|---|
| high school diploma or equivalent | 3 / 488 | **0.867** |
| high school diploma or GED | 13 / 488 | **0.689** |
| project management | 37 / 488 | 0.563 |
| cross-functional collaboration | 64 / 488 | 0.496 |
| bachelor degree | 83 / 488 | 0.465 |

A high school diploma now carries **48% more weight than a bachelor's
degree**, because white-collar postings rarely state it. The requirement
that discriminates least between candidates is weighted most.

Consequence: 13 of the top 20 are Gopuff Operations Associate and
Starbucks Barista postings, each credited by exactly one concept, "high
school diploma or GED", on six to eight evaluable concepts. Before this
change they sat at Fit 14; they now sit at 20 to 23.

This was predicted as an unsolved case before the change was approved.
The magnitude was not: it did not merely fail to fix the case, it made it
the dominant feature of the top of the ranking.

What would actually address it is requirement SEMANTICS, not a
statistical weight. The distinguishing property of "high school diploma"
is that it is a floor almost every candidate clears, and no statistic
available in this corpus expresses that, because resolution is
deterministic given the profile: of 55 concepts ever satisfied, 49 are
satisfied on every posting naming them.

**Resolved 30 Aug 2026 by fit formula version 3**, without naming any
requirement, employer, occupation or title.

The fix is a rule about RELATIVE LEVEL, not about any string: a generic
education requirement below the profile's own verified attainment is a
qualification floor, because everyone still in the running clears it. It
carries 0.15 instead of full weight. A FIELD-SPECIFIC requirement is
never a floor: "degree in nursing" discriminates whatever its level.

IDF was removed from the weighting entirely. It measured rarity, and
rarity is not value. A side effect worth having: **formula 3 does not
depend on the corpus at all**, so a score no longer moves because
unrelated postings were ingested, which retires the reproducibility
hazard formula 2 introduced.

Measured on 687 eligible jobs, profile version 5, weights unchanged at v5:

    top 25 whose entire credit is a floor      13 -> 0
    Gopuff barista postings (1 of 7 matched)   fit 22 -> 7, rank 4 -> 127

## 6. RESOLVED — Flat term weights dominated the compressed coverage signal

Measured on the committed weights v5 / formula 2 run, 488 eligible jobs.

Smoothing pushed the coverage component down to roughly 8 to 13 points at
the top of the ranking. The non-coverage Fit terms did not move, and they
are large:

    512 pts   SENIORITY_MATCH: LEAD        (64 jobs)
    472 pts   SENIORITY_MATCH: SENIOR      (59 jobs)
    464 pts   SENIORITY_MATCH: MANAGER     (58 jobs)
    462 pts   TITLE_MATCH: operations      (77 jobs)
    246 pts   TITLE_MATCH: product         (41 jobs)
   -435 pts   HARD_REQUIREMENT_MISSING: CLINICAL
   -384 pts   HARD_REQUIREMENT_MISSING: education

A job matching on seniority and title family collects a flat +14 before
any evidence is considered, which is more than the entire coverage
component of most jobs. Ranked by coverage alone, multi-evidence jobs sit
at median rank 13. Ranked by full Fit they sit at 80.

Combined with issue 5, **the current top 20 is not a defensible final
ranking.** It should be treated as inspectable output, not as a
recommendation.

Scope: this is a RANKING-QUALITY issue. It is not a defect in the truth
profile, the requirement classifier, location normalization, the
eligibility gate or canonical-opening identity, all of which were
verified separately and are unaffected.

**Resolved 30 Aug 2026 by fit formula version 3**, in the same release as
issue 5, because they were one problem seen from two directions.

Title-family and seniority are PRIORS, not evidence. They now scale by
`min(1, credited / 3)`, reaching full strength at three credited
concepts. A prior modifies evidence; it does not substitute for it. No
weight value changed: `scoring_weights` is still v5.

Measured on the same corpus:

    top 25 with <=1 credited concept           14 -> 0
    median credited concepts in the top 25      1 -> 2
    DIRECT / TRANSFERABLE in the top 25     29/11 -> 36/28
    Gopuff Regional Manager I (6 of 19)     rank 94 -> 22
    requirement-count correlation          -0.083 -> -0.077
    jobs moving 3+ / 5+                        397 / 299, mean -3.08

Gates still behave: 150 jobs carry an unmet education or credential gate,
median Fit -4, and 2 appear in the top 50.

Formula 2 rows are retained (1,894 of them) and no stale row is marked
current, so the change is auditable and reversible by rescoring.

## Issue 7: OR-lists read as conjunctions (RESOLVED 30 Aug 2026)

Found from the portal, not from a test. Gopuff "Regional Manager I"
displayed four green DIRECT concepts including **degree in business**,
against a profile whose only verified degree is a B.S. in Health Science.

The posting says:

> Degree in Business, Operations, Supply Chain, Management, Science,
> Technology, Engineering, Math, or a related field

One requirement, satisfiable by any one branch. `splitCompound` treated
every comma list as a conjunction, so it became eight independent
concepts. Six took DIRECT credit from the single verified degree, and
the concept labels were the split fragments, so the portal showed a
business degree the profile does not contain. Every credited concept on
that job came from that one misread requirement; all twelve of its real
requirements were unmet.

Four defects, all fixed:

1. **OR read as AND.** `decompose(concept, rawText)` now returns AND or
   OR, decided from the raw sentence where the conjunction actually
   lives. A qualification requirement is never split at all: you hold
   one degree and one licence.
2. **Labels asserted an unsatisfied branch.** A concept with
   alternatives now carries `alternatives`, `satisfiedBranch` and a
   `displayLabel`, and the label names the branch actually met:
   `degree in one of: business, ..., math (met via "science")`.
   `scripts/score.ts` stores the display label plus a `conceptDetail`
   array carrying the reasoning.
3. **Degree fields merged with experience concepts.** `byConcept` keyed
   on concept text alone, so "management" as an acceptable degree field
   and "management" as work experience were one entry. Now keyed by
   class as well.
4. **Split artifacts.** ", or math" left the concept "or math", and
   "and/or" was split as a slash pair into "workday and" +
   "or netsuite partnership". Both normalized away.

Two further defects surfaced while sweeping the corpus:

5. **Graduate requirements read as bachelor's.** "J.D. or graduate
   degree" matched no level pattern and fell through to the BACHELOR
   default, so a verified bachelor's satisfied it. Three Flexport trade
   roles were credited this way. Professional doctorates and
   "graduate/advanced/postgraduate degree" are now recognized.
6. **Level lists read as their highest.** `educationLevel` returned the
   first pattern to match, so "BS, MS, or PhD in Computer Science" was
   read as DOCTORATE. A list of acceptable degrees is satisfied by its
   LOWEST, and BACHELOR is now a matchable level rather than only the
   fallback.

**Before and after**, over 687 scored jobs, profile version 5:

| | before | after |
|---|---|---|
| concepts extracted | 9,013 | 8,471 |
| concepts credited | 460 | 495 |
| DIRECT credit on a degree fragment | 1 | 0 |
| DIRECT on a bare generic field word | 1 | 0 |
| DIRECT on a graduate/doctoral requirement | 4 | 0 |
| split artifacts | 158 | 0 |

Fit fell on 6 jobs and rose on 80; 601 unchanged; no recommendation
changed. The falls are false credit removed (Gopuff 15 to 4, Flexport
Senior Trade Advisory Manager 17 to 5). The rises are false penalty
removed: an OR-list of five acceptable backgrounds was five unmet
requirements and is now one.

Regression tests: `node scripts/or-list-selftest.ts`, 35 cases built on
the exact Gopuff text plus synthetic boundaries in both directions.

No re-extraction was needed. Classification and scoring are computed
from stored requirement text at score time, so `node scripts/score.ts
--commit` was sufficient.

## Issue 8: one demand, several extracted rows (RESOLVED 30 Aug 2026)

Follow-up to issue 7, on the 38 jobs carrying more than one education
concept. They were categorized before anything was changed, because a
rule that collapses education rows merely for being education rows would
destroy genuinely distinct requirements.

| category | jobs | example | verdict |
|---|---|---|---|
| A. one sentence, several rows, same level and hardness | 2 | TRM Labs FP&A: four rows from "Degree in Finance, Accounting, Economics, or Business Administration preferred" | **merge** |
| B. one sentence, several rows, level differs | 1 | Fieldguide: "Bachelor's in Accounting + CPA license **or** Master's in Accounting" | keep separate |
| C. distinct sentences, required vs preferred | 30 | "Bachelor's degree required" + "MBA a plus" | keep separate |
| D. distinct sentences, same hardness | 2 | Flexport: bachelor's + "J.D. or graduate degree" | keep separate |
| E. distinct sentences, near-identical wording | 3 | FourKites: "Bachelor's degree or equivalent experience, MBA a plus" + "MBA a plus" | keep separate |

Only category A is deterministic. Rows sharing one raw_text that agree on
class, level and hardness are branches of a single list the extractor
split; nothing distinguishes them but the field, which is what makes them
alternatives. They merge into one concept whose `alternatives` are the
union of the fields and whose `requirementIds` cite every row.

Everything else stays separate, on purpose:

- **B** is one demand with two routes at different levels. Merging means
  deciding which level the requirement is, which is a judgement, so it is
  preserved as two rather than guessed.
- **C** is the common case and is genuinely two demands: a floor and a
  preference. Thirty jobs would have been corrupted by a naive rule.
- **E** shows why textual similarity is not a merge signal. FourKites'
  second row is a literal substring of the first, and the two express
  different demands (a bachelor's, and an MBA preference).

Result: TRM Labs FP&A 5 education concepts to 2, Gopuff Category Manager
4 to 2. No other job changed. `scripts/verify-qualification-units.ts`
asserts the invariant in both directions over the whole corpus:

    jobs carrying a qualification requirement: 260
    distinct qualification demands:            383
      satisfied (one unit each):               132
      unsatisfied (one unit each):             251
    no qualification demand contributes more than one unit

A third defect surfaced here. **"MS Excel" was a master's degree.**
`ms\b` appeared unguarded in both the education detector and the level
patterns, so "advanced skills in Google Sheets and/or MS Excel" became a
graduate-degree requirement nobody could meet. Bare two-letter degree
abbreviations now require degree context: a separator, a conjunction,
"in", "from", or the word "degree". "BS, MS, or PhD in Computer Science"
still reads correctly.

Regression suite is now 46 cases in `scripts/or-list-selftest.ts`,
including every boundary above in both directions.

## Zero extracted requirements is not always a failure

Checked after the second Gopuff "Regional Manager I" posting was found
with no requirements at all.

That posting is **INELIGIBLE**: its locations are Dallas and Fort Worth,
and extraction only ever runs on ELIGIBLE and UNCERTAIN jobs. It has no
score row either. Its Chicago twin carries the identical 4,509-character
description and all twelve requirements, which is what proves the text is
extractable and the skip deliberate.

Across 4,658 open jobs:

| | |
|---|---|
| ELIGIBLE, extracted | 684 |
| ELIGIBLE, zero requirements | 3 |
| UNCERTAIN, extracted | 608 |
| UNCERTAIN, never attempted | 123 |
| INELIGIBLE, never attempted | 2,759 |

All three ELIGIBLE zero-requirement jobs are genuinely empty: Beyond
Finance "Future Interest" and Nourish "General Interest Application" are
talent pools, and Zocdoc "Platform Engineering Manager" contains the
literal placeholder **"Plug in job spec"** where its requirements should
be. Zero is the correct answer in all three.

The 123 unattempted UNCERTAIN jobs were all first seen 30 Aug 2026, after
the last extraction batch. That is pipeline lag from continuous
discovery, not a failure, and clears on the next extraction run
(about $1.39 at the measured $0.0113 per job).

## Still open

Nothing. Issues 1 to 4 were addressed by formula 2, 5 and 6 by formula 3, and 7 by
the decomposition fix above.

## Status

Issues 1 to 4 diagnosed 30 Aug 2026 against profile version 5, taxonomy
version 2, weights v4. Issues 5 and 6 measured after committing weights
v5 / fit formula 2 the same day, which addressed issue 4 outright and
issues 1 to 3 only partially.

Reproduce with `node scripts/diag/trivial.ts` and
`node scripts/diag/v5-divergence.ts`.

The ranking redesign is to be kept separate from the classifier,
duplicate-opening and location-normalization work so its effect can be
measured independently.
