/**
 * The verdict the worker is allowed to act on.
 *
 * THE DEFECT THIS CLOSES
 *
 * application-worker read job_candidacy as `select id,job_id,verdict`
 * and collapsed it with `new Map(rows.map(r => [r.job_id, r.verdict]))`.
 * That table holds one row per (job, profile, formula, taxonomy, model),
 * so every row silently overwrote the one before it and the verdict that
 * survived was whichever happened to sort last by uuid.
 *
 * Measured on live data at the time it was found: 1,004 of 1,491 jobs
 * resolved to a NON-authoritative verdict. 561 of those came from
 * profile v12, three truth versions stale. SpotHero read
 * APPLICATION_CANDIDATE from a model 3 row while the authoritative model
 * 4 verdict was MANUAL_REVIEW, which is the difference between
 * preparing a job and asking a person to resolve it first.
 *
 * It was always broken. Until model 4 was promoted there was only one
 * model in play, so the missing predicate had nothing to go wrong with.
 *
 * THE RULE
 *
 * A verdict describes exactly one scoring state. Migration 0060 says it
 * outright: a later profile version does not reinterpret an old row, it
 * makes it stale, and stale fails closed. So only a row matching all
 * four current versions counts, and a job with no such row has NO
 * verdict rather than an old one.
 *
 * The portal shows stale rows marked stale, because a person reading a
 * queue is served by seeing that a verdict exists and is out of date.
 * The worker acts unattended and gets no such latitude.
 */

import type { Verdict } from "../scoring/candidacy.ts";

export interface CandidacyVersionRow {
  job_id: string;
  verdict: Verdict;
  profile_version: number;
  formula_version: number;
  taxonomy_version: number;
  model_version: number;
  /** Optional: carried for the autonomous-submission guards (planner). */
  reason_codes?: string[] | null;
  hard_met?: number | null;
  hard_total?: number | null;
}

export interface ScoringVersions {
  profileVersion: number;
  formulaVersion: number;
  taxonomyVersion: number;
  modelVersion: number;
}

export const isAuthoritative = (r: CandidacyVersionRow, v: ScoringVersions): boolean =>
  r.profile_version === v.profileVersion
  && r.formula_version === v.formulaVersion
  && r.taxonomy_version === v.taxonomyVersion
  && r.model_version === v.modelVersion;

/**
 * job_id -> verdict, for authoritative rows only.
 *
 * Order-independent by construction: a row is either at the current
 * version or it is not, and nothing in here depends on the sequence rows
 * arrive in. A job absent from the result has no current verdict, which
 * every caller must treat as "not assessed" rather than as permission.
 *
 * Two authoritative rows disagreeing about one job is a broken unique
 * index, not a tie to be broken quietly. It throws.
 */
export function authoritativeCandidacy(
  rows: CandidacyVersionRow[],
  v: ScoringVersions,
): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  for (const r of rows) {
    if (!isAuthoritative(r, v)) continue;
    const seen = out.get(r.job_id);
    if (seen !== undefined && seen !== r.verdict) {
      throw new Error(
        `job ${r.job_id} has two different authoritative candidacy verdicts (${seen}, ${r.verdict}) `
        + `at profile v${v.profileVersion} / formula ${v.formulaVersion} / taxonomy ${v.taxonomyVersion} `
        + `/ model ${v.modelVersion}. job_candidacy_current should make this impossible.`);
    }
    out.set(r.job_id, r.verdict);
  }
  return out;
}

/**
 * Like authoritativeCandidacy, but returns the whole authoritative ROW per
 * job (verdict + reason code + hard counts), which the planner needs for the
 * material-gap and autonomous-STRETCH evidence guards. Same authoritative-
 * version filter; same throw on two disagreeing authoritative rows.
 */
export function authoritativeCandidacyRows(
  rows: CandidacyVersionRow[],
  v: ScoringVersions,
): Map<string, CandidacyVersionRow> {
  const out = new Map<string, CandidacyVersionRow>();
  for (const r of rows) {
    if (!isAuthoritative(r, v)) continue;
    const seen = out.get(r.job_id);
    if (seen !== undefined && seen.verdict !== r.verdict) {
      throw new Error(`job ${r.job_id} has two different authoritative candidacy verdicts (${seen.verdict}, ${r.verdict}).`);
    }
    out.set(r.job_id, r);
  }
  return out;
}

/**
 * Applications the production worker may consider.
 *
 * A test fixture is not a real application and must not stand in for
 * one. Left unfiltered it did two things: it became the `existing`
 * application for a real job, so the worker would authorize the fixture
 * instead of preparing the real thing; and it was eligible for the
 * requested-submission path, which requires only submit_requested_at and
 * human_approved. Thirteen fixtures carry human_approved.
 *
 * Nothing was armed when this was found, because no application had
 * submit_requested_at set. That is a fact about the data on one day, not
 * a property of the system, which is what this function is for.
 */
export const isProductionApplication = <T extends { is_test?: boolean | null }>(a: T): boolean =>
  a.is_test !== true;

export const productionApplications = <T extends { is_test?: boolean | null }>(apps: T[]): T[] =>
  apps.filter(isProductionApplication);
