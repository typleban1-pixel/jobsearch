# Architecture

Personal job search, matching and application system. Standalone: separate
repository, database, auth, secrets, deployment and worker. Shares nothing
with any other project.

## The finding that shapes everything

There is no cross-company job search API. Greenhouse, Lever and Ashby each
publish complete, canonical, free job lists **per company**, and none
offers global search. Verified 29 August 2026:

```
boards-api.greenhouse.io/v1/boards/stripe/jobs      574 jobs
api.lever.co/v0/postings/spotify?mode=json           89 jobs
api.ashbyhq.com/posting-api/job-board/ramp          139 jobs
any global search endpoint                          404
```

So coverage is not a function of clever searching. It is a function of how
many companies are known. **The company universe is the product's real
input**, which is why it is a first-class subsystem with its own discovery
sources, candidate-token proving and priority ordering, rather than a list.

The payoff: canonical listings, real requisition IDs, `updated_at` for
change detection, no scraping, no terms-of-service exposure, and complete
coverage of every company in the universe rather than whatever a keyword
search surfaced.

## Shape

```
phone / laptop
      │  read, approve, answer questions
      ▼
Portal ──────────── Next.js on Vercel, single user, private
      │
      ▼
Postgres ────────── Supabase + pgvector. Truth profile, companies,
      │             jobs, observations, scores, applications.
      │             Invariants live here as constraints.
      ▼
Worker ──────────── Always-on container. Daily ingest now,
                    Playwright with a persistent profile later.
```

The portal never depends on the worker being up, and the worker never
depends on a personal machine being on. The worker is a container with a
mounted volume so moving it from cloud to a mini-PC later is a deploy
target change, not a redesign.

Browser automation cannot live in a serverless request, and separately,
serverless billing is usually active-CPU based, which is exactly what a
browser burns.

## Daily cycle

```
select companies      status ACTIVE, ordered by priority, least-recently-checked first
  fetch board         per-company API; failure is recorded as failure, never as absence
    diff              content hash per job decides new / changed / unchanged
      observe         one row per job per successful check
        status        derived from observations, never from one fetch
          filter      deterministic: deal breakers, location, hard-requirement conflicts
            embed     semantic similarity against the profile, whole corpus, cheap
              analyze reasoning tier on the shortlist only
                score fit, opportunity, generalist fit, specialist risk
```

Unchanged jobs skip analysis entirely. A profile change bumps
`profile_version` and rescores the corpus **without refetching or
reanalyzing** listings, so promoting SQL from `EXPOSURE` to `CAPABLE`
lifts jobs already on file.

## Component classification

| Component | Type |
|---|---|
| Board fetch, normalize, canonicalize | Deterministic |
| Dedupe on requisition / ATS id / canonical URL | Deterministic |
| Dedupe on description similarity | Hybrid: embeddings propose, rules confirm |
| Job status and closure | Deterministic, over observation history |
| Requirement extraction, required vs preferred | LLM, ambiguity preserved as NULL |
| Hard-requirement comparison and blocking | Deterministic |
| Remote eligibility interpretation | LLM extracts, deterministic compares |
| Fit score | Hybrid: embedding prefilter, reasoning on shortlist |
| Opportunity score | Deterministic, weighted over stored fields |
| Salary estimation | LLM, ranges with explicit confidence |
| Career family discovery | LLM clustering over embeddings |
| Resume tailoring | LLM, constrained to evidence rows |
| Answer provenance | Deterministic, foreign keys |
| Application state machine | Deterministic |
| Submission gate | Deterministic, never LLM |

## Where the invariants live

In the database, not in a prompt. An LLM cannot be relied on to refuse;
a constraint can.

- AI may only insert skills with `status = 'SUGGESTED'`. Nothing in the
  matching or application path reads a suggested row as fact. Promotion
  is a human action, stamped with `verified_at`.
- `claim_expert` defaults false and no automated path sets it. A five out
  of five is not the word "expert".
- `job_requirements.is_hard_requirement` is three-valued. NULL means the
  posting was unclear, which surfaces; false silently passes. They must
  not be the same value.
- Capability and appetite are separate columns. Being good at video
  editing and wanting a video editing job are different facts.
- Every resume claim points at evidence rows. A claim with no evidence is
  the thing this system exists not to produce.
- `consecutive_misses` advances only on a **successful** fetch that did
  not contain the job, so a board outage cannot close a company's jobs.
- A removed posting is never a rejection: description, requirements and
  application are preserved, disappearance is timestamped, and the reason
  stays UNKNOWN unless actually known.

## Location model

Chicagoland is rows in `location_preferences`, not a string match on
"Chicago". A job in Naperville is Chicagoland; a job labelled Chicago that
is onsite elsewhere is not. Preferences are configuration so changing what
counts as an acceptable commute is an edit, not a deploy.

Remote is treated as a claim rather than a fact, because a posting saying
"Remote" while requiring residency in three states is not remote for this
user. `remote_eligible_states`, `remote_excluded_states`, timezone
requirement, occasional-onsite and travel are extracted and compared
deterministically against the profile.

Default rule: Greater Chicagoland at any onsite frequency, or fully remote
US where the user is actually eligible. Hybrid and onsite elsewhere are
excluded until relocation is enabled.

## Matching stays broad

Discovery is driven by skills, evidence, responsibilities and stated
appetite, not by a list of titles. `career_family` is assigned by
clustering rather than chosen from a taxonomy, because a fixed title list
is precisely what would prevent the system from surfacing the roles worth
finding. Industry shapes company priority and never restricts discovery.

## Status

Phase 1 in progress. Schema first, UI after review.

```
0001_truth_profile.sql     profile, employment, projects, education,
                           skills, evidence, answers, resumes
0002_company_universe.sql  companies, discovery sources, token candidates,
                           ingest runs
0003_jobs_core.sql         jobs, observations, requirements, relations, scores
```
