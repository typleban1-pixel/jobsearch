/**
 * Whether an application may be authorized without a person reading it.
 *
 * The portal writes the switches, this reads them, and Supabase is the
 * only thing between the two. The deployed portal has no worker and the
 * worker has no portal; they agree because they read the same rows.
 *
 * Two properties matter more than anything else here:
 *
 * 1. This decides AUTHORIZATION only. Every evidence, candidacy,
 *    confidence, verification and confirmation gate applies on top and
 *    none of them is configurable from here. A policy can only ever
 *    narrow what gets submitted, never widen it.
 *
 * 2. It is read twice. Once when an application is authorized, and again
 *    immediately before submitting, because a switch turned off while a
 *    browser was open has to take effect on that application and not on
 *    the one after it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Switches {
  globalAutoSubmit: boolean;
  byProvider: Record<string, { paused: boolean; capability: string }>;
}

export interface AutomationPolicy {
  autoSubmitCandidacy: string[];
  reviewCandidacy: string[];
  minFit: number | null;
  allowUnknownSalary: boolean;
  baseSalaryFloor: number;
  maxApplicationsPerDay: number | null;
  requireResumeReview: boolean;
  excludedCompanyIds: string[];
  excludedJobIds: string[];
}

export async function readSwitches(db: SupabaseClient): Promise<Switches> {
  const { data: op } = await db.from("operating_policy").select("auto_submit_enabled").limit(1).single();
  const { data: rows } = await db.from("ats_policy").select("provider,paused,capability");
  const byProvider: Switches["byProvider"] = {};
  for (const r of rows ?? []) byProvider[r.provider] = { paused: Boolean(r.paused), capability: r.capability };
  return { globalAutoSubmit: Boolean(op?.auto_submit_enabled), byProvider };
}

export async function readPolicy(db: SupabaseClient): Promise<AutomationPolicy> {
  const { data } = await db.from("automation_policy").select("*").limit(1).single();
  return {
    autoSubmitCandidacy: data?.auto_submit_candidacy ?? ["APPLICATION_CANDIDATE"],
    reviewCandidacy: data?.review_candidacy ?? ["STRETCH"],
    minFit: data?.min_fit ?? null,
    allowUnknownSalary: data?.allow_unknown_salary ?? true,
    baseSalaryFloor: data?.base_salary_floor ?? 85_000,
    maxApplicationsPerDay: data?.max_applications_per_day ?? null,
    requireResumeReview: data?.require_resume_review ?? false,
    excludedCompanyIds: data?.excluded_company_ids ?? [],
    excludedJobIds: data?.excluded_job_ids ?? [],
  };
}

/** What the worker should do with one candidate application. */
export type Disposition =
  | { action: "SUBMIT"; why: string }
  | { action: "REVIEW"; why: string }
  | { action: "SKIP"; why: string };

export interface Candidate {
  jobId: string;
  companyId: string;
  provider: string;
  // The database's own four values. An earlier draft of this file used
  // "CANDIDATE", which matches none of them, so every job would have
  // been skipped as unscored while looking like a working policy.
  candidacy: "APPLICATION_CANDIDATE" | "STRETCH" | "REJECT" | "MANUAL_REVIEW" | null;
  eligibility: string;
  fit: number | null;
  /** Employer-published base only. Null means unstated, never zero. */
  baseSalaryMin: number | null;
  allFieldsConfident: boolean;
  blockedAnswers: number;
  resumeClaimsAllGrounded: boolean;
  artifactValid: boolean;
  submittedToday: number;
}

/**
 * The decision, as one pure function so it can be argued with in tests
 * rather than inferred from worker logs.
 *
 * Order is deliberate. Kill switches come first, because "you turned it
 * off" must never be reported as "it did not qualify". Hard exclusions
 * come next. Only then does candidacy get considered.
 */
export function decide(c: Candidate, p: AutomationPolicy, s: Switches): Disposition {
  // HARD EXCLUSIONS FIRST.
  //
  // An earlier version checked the kill switches first, so that "you
  // switched it off" would never be reported as "it did not qualify".
  // The consequence was worse than the problem: with the switch off,
  // every job in the corpus became REVIEW, REJECTs included, and the
  // worker would have prepared an application for a store associate
  // role. A switch must be able to narrow what gets submitted and must
  // never widen what gets considered.
  if (p.excludedJobIds.includes(c.jobId)) return { action: "SKIP", why: "this job is excluded" };
  if (p.excludedCompanyIds.includes(c.companyId)) return { action: "SKIP", why: "this employer is excluded" };
  if (c.candidacy === "REJECT" || c.candidacy === null) {
    return { action: "SKIP", why: `candidacy is ${c.candidacy ?? "unscored"}` };
  }
  if (c.eligibility !== "ELIGIBLE") return { action: "SKIP", why: `eligibility is ${c.eligibility}` };

  // Unknown salary stays unknown. An unstated salary is not evidence of
  // a low one, and treating it as failing the floor would silently
  // discard every employer that does not publish pay.
  if (c.baseSalaryMin !== null && c.baseSalaryMin < p.baseSalaryFloor) {
    return { action: "SKIP", why: `published base ${c.baseSalaryMin} is below the ${p.baseSalaryFloor} floor` };
  }

  // Capability and pause are facts about whether ANY unattended work is
  // possible, so they come before candidacy routing. Without this, a
  // STRETCH job on a provider with no adapter was routed to REVIEW and
  // the worker tried to prepare it, which failed on "no form snapshot is
  // implemented for LEVER" and was recorded as a failure rather than as
  // something that was never possible.
  const cap = s.byProvider[c.provider];
  if (!cap) return { action: "SKIP", why: `no policy row exists for ${c.provider}` };
  if (cap.capability !== "PRODUCTION") {
    return { action: "SKIP", why: `no application adapter exists for ${c.provider} yet` };
  }
  // Pausing stops unattended processing for a provider, which includes
  // preparing. The global switch is narrower: it governs submission, so
  // a globally-paused system still prepares and routes to review.
  if (cap.paused) return { action: "SKIP", why: `${c.provider} is paused` };

  // Candidacy class decides whether automatic submission is even on the
  // table for this job, before any switch is consulted.
  if (c.candidacy === "MANUAL_REVIEW") return { action: "REVIEW", why: "candidacy is MANUAL_REVIEW" };
  if (!p.autoSubmitCandidacy.includes(c.candidacy)) {
    return p.reviewCandidacy.includes(c.candidacy)
      ? { action: "REVIEW", why: `${c.candidacy} is prepared but never auto-submitted` }
      : { action: "SKIP", why: `${c.candidacy} is not in any policy list` };
  }

  // Only now do the switches matter, and only to demote a would-be
  // submission to review. They can never promote anything.
  if (!s.globalAutoSubmit) return { action: "REVIEW", why: "unattended submission is switched off globally" };

  if (c.baseSalaryMin === null && !p.allowUnknownSalary) {
    return { action: "REVIEW", why: "salary is unstated and policy does not allow unknown salary" };
  }
  if (p.minFit !== null && (c.fit === null || c.fit < p.minFit)) {
    return { action: "REVIEW", why: `Fit ${c.fit ?? "unscored"} is below the configured minimum ${p.minFit}` };
  }

  // Standing gates, restated so a policy can never be configured around them.
  if (c.blockedAnswers > 0) return { action: "REVIEW", why: `${c.blockedAnswers} question(s) have no safe answer` };
  if (!c.allFieldsConfident) return { action: "REVIEW", why: "not every required field is accounted for" };
  if (!c.resumeClaimsAllGrounded) return { action: "REVIEW", why: "a resume claim did not pass the grounding guards" };
  if (!c.artifactValid) return { action: "REVIEW", why: "the rendered resume failed artifact validation" };
  if (p.requireResumeReview) return { action: "REVIEW", why: "policy requires every tailored resume to be read" };

  if (p.maxApplicationsPerDay !== null && c.submittedToday >= p.maxApplicationsPerDay) {
    return { action: "REVIEW", why: `the daily cap of ${p.maxApplicationsPerDay} is reached` };
  }

  return { action: "SUBMIT", why: "satisfies every condition of the enabled policy" };
}

