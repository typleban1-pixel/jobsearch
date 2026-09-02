# Continuous discovery: proposed architecture

Proposal only. Nothing here is built.

## Where things actually stand

Measured 30 Aug 2026, not estimated:

    companies                28   all SEED_LIST, all ACTIVE
    ats providers            22 Greenhouse, 6 Lever
    open jobs             3,841   median 32 per company, max 816
    eligible after gating   488   12.7% of the corpus
    extraction cost      $0.0113 per job, 1,568 calls, $17.77 to date

Four tables were designed for discovery in migration 0002 and have never
held a row: `company_sources`, `company_token_candidates`,
`coverage_snapshots`, plus the `discovery_method` and `company_lifecycle`
enums. The proposal fills them rather than adding parallel machinery.

## The one number that shapes the design

`data/company-candidates.json` holds 57 hand-picked companies with
hand-guessed ATS tokens. **20 verified. 35%.**

Guessing that Tempus AI is `greenhouse.io/tempus` is right about a third
of the time, and each wrong guess is a company silently absent from the
corpus. So token guessing cannot be the primary resolution path. Reading
the company's own careers page and finding the ATS URL it links to is the
primary path; guessing is the fallback.

## Sources

There is no legitimate way to enumerate every Greenhouse or Lever board.
Neither exposes a global search, which is the same constraint that shaped
ingestion. Discovery therefore splits into two different problems, and
conflating them is what produces a 35% hit rate:

**1. Getting company NAMES.** The real bottleneck.

| source | method | why it fits |
|---|---|---|
| Built In Chicago company directory | `PUBLIC_DIRECTORY` | Chicagoland-specific, public, names + domains + industry |
| Y Combinator company directory | `PUBLIC_DIRECTORY` | public JSON, heavy ATS adoption |
| VC portfolio pages (a16z, Sequoia, Chicago Ventures, Hyde Park, M25) | `VC_PORTFOLIO` | portfolio pages are public and list domains |
| 1871 / mHUB / Illinois Tech Association member lists | `PUBLIC_DIRECTORY` | local, and surfaces employers a national list misses |
| Companies already in the corpus | `RELATED_COMPANY` | competitor and partner mentions in job descriptions already fetched |
| Manual additions | `MANUAL` | anything noticed by hand |

Deliberately excluded: LinkedIn and Indeed. Both prohibit scraping in
their terms, both require defeating bot protection, and neither is
necessary when the ATS boards are the canonical source anyway. This
system reads canonical sources; it should not start by breaking terms of
service to find them.

**2. Resolving a name to a board.** Cheap and deterministic.

    a. fetch <domain>/careers, /jobs, /about/careers  (respect robots.txt)
    b. look for boards.greenhouse.io/<token>, jobs.lever.co/<token>,
       jobs.ashbyhq.com/<token>, or an embedded board script
    c. if that fails, generate token candidates from name and domain
       (slug, no-spaces, no-suffix, domain stem) and TEST each against
       the live board API
    d. a token is only accepted when the board answers with jobs

Step (d) is what `scripts/verify-boards.ts` already does, and it is the
rule that matters: a plausible-but-wrong token produces a company that
looks checked every day and contributes nothing, which is worse than
never having added it.

**Ashby is worth adding.** The enum has existed since 0002 with no
provider behind it. Many companies that would otherwise be invisible use
it, and its public API is the same shape as the two already supported.
Roughly a day of work, and it widens recall more than any single
directory would.

## Flow into the existing pipeline

Discovery's only job is to move a company to ACTIVE with a verified
token. Everything downstream already works and needs no changes: the
ingest run is described in its own header as "one ingest run across every
ACTIVE company".

    discovery source ─▶ companies (DISCOVERED)
                          │
                          ▼
                    ATS detection            careers page, then guessing
                          │
                          ▼
                 company_token_candidates    one row per guess
                          │
                          ▼
                   verify against board      HTTP only, no LLM
                          │
                          ▼
                    companies (ACTIVE) ──────┐
                                             │
    ┌────────────────────────────────────────┘
    ▼
  ingest ─▶ eligibility ─▶ extraction ─▶ scoring ─▶ portal
             (free)         ($0.0113/job)   (free)
                  ▲
                  └─ the cheap deterministic gate stays where it is:
                     only ELIGIBLE jobs are ever sent to a model

## Dedup

Three levels, two of which already exist.

- **Company**: `companies.domain` and the existing unique constraint on
  `(ats_provider, candidate_token)`. Two directories naming the same
  employer differently resolve to one company through the domain.
- **Job**: `(source, external_id)`, already enforced.
- **Opening**: canonical openings, already built and verified. A newly
  discovered company posting one requisition to five cities still
  produces one applyable opening.

## Frequency

| step | cadence | why |
|---|---|---|
| directory sweep | weekly | company lists change slowly; daily would be noise |
| ATS resolution for new names | on discovery | one-off per company |
| re-resolution for unresolved | monthly | a company without a board today may have one later |
| ingest across ACTIVE companies | daily | already the design |
| eligibility, extraction, scoring | after each ingest, incremental | already the design |
| coverage snapshot | daily | `coverage_snapshots` exists for exactly this |

## Expected coverage

At 28 companies the corpus holds 3,841 open jobs and 488 eligible. The
directories above plausibly yield 300 to 600 resolvable companies, most
of them small, so the per-company job count should fall well below the
current 137 average, which is skewed by one company with 816 postings.

At 400 companies and a conservative 25 open jobs each: roughly 10,000
open jobs and, at the current 12.7% eligibility rate, about 1,270
eligible. That is a 2.6x increase in things worth looking at.

Stated as a range on purpose. The honest uncertainty is the resolution
rate: if careers-page detection lands near 80% it is 400 companies, and
if it behaves like token guessing it is 150.

## Expected recurring cost

Discovery itself is HTTP and costs nothing but bandwidth.

The only paid step is requirement extraction, at a **measured** $0.0113
per job:

    one-time backfill of ~1,270 newly eligible jobs      ~$14
    steady state, if 3% of 10,000 jobs turn over daily
      = 300 new jobs/day x 12.7% eligible x $0.0113      ~$0.43/day
                                                         ~$13/month

The churn figure is the weakest number here. The corpus has only been
ingested a handful of times, so 3% daily is an assumption rather than a
measurement. Two weeks of daily ingest would replace it with a real one,
and that measurement should happen before the extraction budget is set.

Supabase and Vercel both stay on their free tiers at this scale; the row
counts involved are tens of thousands, not millions.

## Local versus cloud

**The worker stays local. The portal stays on Vercel.**

The service-role key is the reason. It is deliberately absent from Vercel
and the portal is verified not to need it, so the worker cannot run there
without undoing that. The alternatives are:

- **launchd on the Mac** (proposed). The key already lives there, the
  scripts already run there, and the portal reads whatever the worker
  writes without knowing the worker exists. Cost: nothing runs while the
  laptop is closed.
- **GitHub Actions** with the key as a repository secret. Runs on
  schedule regardless of the laptop. Cost: the key now exists in a second
  place, and this repository has no remote today.
- **Supabase Edge Functions**. Closest to the data, but the extraction
  code is Node and would need reworking.

Proposed: launchd now, because it adds no new place for the key to live
and can be changed later without touching anything else. Revisit if a
missed day starts mattering.

## What I would build, in order

1. `discovery_sources` seeded as rows in the existing `company_sources`
   table, one per directory, each with its own fetcher.
2. `scripts/discover.ts`: sweep enabled sources, insert new companies as
   DISCOVERED, never overwrite an existing one.
3. `scripts/resolve-ats.ts`: careers-page detection, then candidate
   generation, then live verification. Writes `company_token_candidates`
   and promotes to ACTIVE only on a confirmed board.
4. Ashby provider, mirroring the Greenhouse and Lever ones.
5. `scripts/coverage.ts`: daily snapshot into `coverage_snapshots`.
6. launchd plists for the daily and weekly runs.
7. A portal page reading `coverage_snapshots`, so corpus growth is
   visible rather than assumed.

Steps 1 to 3 are the substance. Everything else is small.

## What this proposal does not do

- No application automation. Discovery ends at a scored job in the portal.
- No scoring changes. Issues 5 and 6 stay open until there is real
  save and dismiss evidence.
- No new application-volume target. Volume remains an output.
- No paid data APIs. If a directory turns out to need one, that is a
  decision to bring back rather than to make quietly.
