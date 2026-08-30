import { hashObject } from "./hash.ts";
import type { NormalizedJob } from "./providers/types.ts";

/**
 * Change detection.
 *
 * content_hash covers exactly the fields frozen into a job_version. It
 * deliberately excludes anything the board mutates on its own schedule
 * (updated_at, view counts, tracking parameters on URLs), because a hash
 * that moves for those reasons creates a permanent, immutable version row
 * recording a change that never happened.
 */

export const CONTENT_FIELDS = [
  "title", "department", "locationRaw", "city", "state", "country", "metro",
  "remotePolicy", "remoteRestriction", "onsiteDaysPerWeek",
  "employmentArrangement", "seniority",
  "salaryMin", "salaryMax", "salaryCurrency", "salaryPeriod",
  "isIndividualContributor", "managesPeople",
  "travelRequirementPct", "hasQuotaOrCommission", "mentionsEquity",
  "descriptionText",
] as const satisfies readonly (keyof NormalizedJob)[];

export function contentHash(job: NormalizedJob): string {
  const subset: Record<string, unknown> = {};
  for (const f of CONTENT_FIELDS) subset[f] = job[f];
  return hashObject(subset);
}

/** Description alone, so "only the prose moved" is distinguishable from a structural change. */
export function descriptionHash(job: NormalizedJob): string {
  return hashObject({ descriptionText: job.descriptionText });
}

export type JobChangeKind =
  | "TITLE_CHANGED" | "DESCRIPTION_CHANGED" | "REQUIREMENTS_CHANGED"
  | "SALARY_ADDED" | "SALARY_REMOVED" | "SALARY_CHANGED"
  | "LOCATION_CHANGED" | "REMOTE_POLICY_CHANGED" | "SENIORITY_CHANGED"
  | "EMPLOYMENT_TYPE_CHANGED" | "DEPARTMENT_CHANGED" | "APPLY_URL_CHANGED"
  | "REPOSTED" | "STATUS_CHANGED" | "OTHER_CHANGE";

export interface DetectedChange {
  kind: JobChangeKind;
  fieldName: string | null;
  oldValue: string | null;
  newValue: string | null;
  isMaterial: boolean;
}

/**
 * Material means "could invalidate a decision already made". A salary
 * band appearing below the floor, remote becoming hybrid, seniority
 * moving: those need re-review. A reworded paragraph does not.
 */
export function detectChanges(prev: NormalizedJob, next: NormalizedJob): DetectedChange[] {
  const changes: DetectedChange[] = [];
  const add = (
    kind: JobChangeKind, field: string | null,
    oldV: unknown, newV: unknown, material: boolean,
  ) => changes.push({
    kind, fieldName: field,
    oldValue: str(oldV), newValue: str(newV), isMaterial: material,
  });

  if (prev.title !== next.title) {
    // A retitle is material only when it moves seniority, which is the
    // part a score actually reads.
    add("TITLE_CHANGED", "title", prev.title, next.title, prev.seniority !== next.seniority);
  }
  if (prev.seniority !== next.seniority) {
    add("SENIORITY_CHANGED", "seniority", prev.seniority, next.seniority, true);
  }
  if (prev.employmentArrangement !== next.employmentArrangement) {
    add("EMPLOYMENT_TYPE_CHANGED", "employment_arrangement",
        prev.employmentArrangement, next.employmentArrangement, true);
  }
  if (prev.remotePolicy !== next.remotePolicy || prev.remoteRestriction !== next.remoteRestriction) {
    add("REMOTE_POLICY_CHANGED", "remote_policy",
        `${prev.remotePolicy}${prev.remoteRestriction ? ` (${prev.remoteRestriction})` : ""}`,
        `${next.remotePolicy}${next.remoteRestriction ? ` (${next.remoteRestriction})` : ""}`, true);
  }
  if (prev.locationRaw !== next.locationRaw || prev.city !== next.city || prev.state !== next.state) {
    add("LOCATION_CHANGED", "location", prev.locationRaw, next.locationRaw, true);
  }

  const hadSalary = prev.salaryMin !== null || prev.salaryMax !== null;
  const hasSalary = next.salaryMin !== null || next.salaryMax !== null;
  if (!hadSalary && hasSalary) {
    add("SALARY_ADDED", "salary", null, range(next), true);
  } else if (hadSalary && !hasSalary) {
    add("SALARY_REMOVED", "salary", range(prev), null, true);
  } else if (hadSalary && hasSalary &&
             (prev.salaryMin !== next.salaryMin || prev.salaryMax !== next.salaryMax)) {
    add("SALARY_CHANGED", "salary", range(prev), range(next), true);
  }

  if (prev.department !== next.department) {
    add("DEPARTMENT_CHANGED", "department", prev.department, next.department, false);
  }
  if (prev.applyUrl !== next.applyUrl) {
    add("APPLY_URL_CHANGED", "apply_url", prev.applyUrl, next.applyUrl, false);
  }
  if (prev.descriptionText !== next.descriptionText) {
    add("DESCRIPTION_CHANGED", "description_text",
        `${prev.descriptionText.length} chars`, `${next.descriptionText.length} chars`, false);
  }

  if (changes.length === 0) {
    // The content hash moved but no tracked field did. Recorded rather
    // than dropped, because it means CONTENT_FIELDS and this function
    // have drifted apart and one of them is wrong.
    add("OTHER_CHANGE", null, null, null, false);
  }
  return changes;
}

function range(j: NormalizedJob): string {
  return `${j.salaryMin ?? "?"}-${j.salaryMax ?? "?"} ${j.salaryCurrency ?? ""}`.trim();
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v).slice(0, 2000);
}
