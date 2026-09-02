import "server-only";
import { applicationsNeedingAnswers } from "./answerCompleteness.ts";

/** Statuses that end an application's claim on the operator's attention. */
const CLOSED_STATUSES = new Set(["ABANDONED", "WITHDRAWN", "REJECTED"]);
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Reading what the machine has been doing.
 *
 * Every row here already existed and was written by the workers; nothing
 * in this file creates state. application_fill_runs, pipeline_runs,
 * company_sources and company_token_candidates have been populated for
 * weeks with nothing reading them, which is the actual gap this closes.
 *
 * Paged throughout, through the signed-in client, same as the rest of
 * the portal.
 */

async function paged<T>(db: SupabaseClient, table: string, cols: string,
  f: (q: any) => any = (q) => q, order = "id", asc = true): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(db.from(table).select(cols))
      .order(order, { ascending: asc }).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

// ---- HANDOFF inbox ----------------------------------------------------

export interface HandoffRow {
  runId: string;
  applicationId: string;
  company: string;
  title: string;
  provider: string;
  outcome: string;
  stopDetail: string | null;
  startedAt: string;
  finishedAt: string | null;
  applicationStatus: string;
  humanApproved: boolean;
  blockedAnswers: number;
  submittedAt: string | null;
  screenshots: string[];
  guardReport: unknown;
  parserReconciliation: unknown[];
  /** Plain English: what this needs from a person. */
  action: string;
  /** True when the thing to do is answer a question rather than watch a form. */
  resolvableInPortal: boolean;
}

/**
 * What a stop actually asks of a person.
 *
 * Written here rather than in the database so the wording can improve
 * without a migration, and keyed on the closed set of fill outcomes so a
 * new stop reason cannot quietly render as a blank cell.
 */
const ACTION: Record<string, string> = {
  HANDOFF: "The form is filled and waiting. Review it and submit in the browser, or resume it here.",
  LOGIN_WALL: "The board wants a signed-in session. Sign in yourself, then resume.",
  SSO_PROMPT: "The board redirected to single sign-on. Complete it yourself, then resume.",
  CAPTCHA: "A CAPTCHA is displayed. Solve it yourself; this system does not.",
  FORM_CHANGED: "A required field differs from the approved snapshot. Re-prepare rather than answering something you did not approve.",
  POSTING_CHANGED: "The employer published a newer version of this posting. Re-prepare against the text you actually read.",
  SELECTOR_AMBIGUOUS: "A control could not be identified uniquely. Needs a look at the live form.",
  UNLABELLED_REQUIRED_FIELD: "A required field has no label to match an answer against.",
  READBACK_MISMATCH: "What was typed is not what the field holds. Nothing was submitted.",
  UPLOAD_UNACKNOWLEDGED: "The board never confirmed the resume upload.",
  PARSER_CONFLICT: "The board's resume parser disagreed with a prepared answer. Decide which stands.",
  PARSER_FILLED_BLOCKED_FIELD: "The board's parser answered a field this system deliberately refused to answer. Review it.",
  PARSER_BEHAVIOUR_LEARNED: "First evidence of the parser overwriting fields. Re-run in the corrected order.",
  REQUIRED_FIELD_BLOCKED: "A required question has no safe answer. Answer it here, then resume.",
  AMBIGUOUS_NAVIGATION: "A control could not be proven to advance rather than submit.",
  SUBMISSION_ATTEMPT_BLOCKED: "A submission guard fired. This is always worth reading before anything else.",
  DYNAMIC_LOOP_LIMIT: "The form kept revealing new fields past the rescan limit.",
  APPLICATION_NOT_READY: "The application was not in a fillable state.",
  NO_FORM_FOUND: "No application form was found at the URL.",
  PROVIDER_UNSUPPORTED: "There is no application adapter for this ATS yet.",
  BROWSER_ERROR: "The browser failed. Nothing was submitted.",
};

export async function loadHandoffs(db: SupabaseClient): Promise<HandoffRow[]> {
  const runs = await paged<any>(db, "application_fill_runs",
    "id,application_id,started_at,finished_at,provider,outcome,stop_detail,guard_report,parser_reconciliation,screenshot_dir",
    (q) => q, "started_at", false);
  if (!runs.length) return [];

  // Only the most recent run per application is an open item; earlier
  // ones are history and belong on the detail page.
  const latest = new Map<string, any>();
  for (const r of runs) if (!latest.has(r.application_id)) latest.set(r.application_id, r);

  const apps = await paged<any>(db, "applications",
    "id,job_id,status,human_approved,submitted_at", (q) => q);
  const appById = new Map(apps.map((a) => [a.id, a]));
  const jobs = await paged<any>(db, "jobs", "id,title,company_id", (q) => q);
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const companies = await paged<any>(db, "companies", "id,name", (q) => q);
  const companyById = new Map(companies.map((c) => [c.id, c.name]));
  const answers = await paged<any>(db, "application_answers",
    "id,application_id,confidence_state", (q) => q);

  const blockedBy = new Map<string, number>();
  for (const a of answers) {
    if (a.confidence_state !== "BLOCKED") continue;
    blockedBy.set(a.application_id, (blockedBy.get(a.application_id) ?? 0) + 1);
  }

  const out: HandoffRow[] = [];
  for (const run of latest.values()) {
    const app = appById.get(run.application_id);
    if (!app) continue;
    const job = jobById.get(app.job_id);
    const blocked = blockedBy.get(app.id) ?? 0;
    out.push({
      runId: run.id,
      applicationId: run.application_id,
      company: job ? (companyById.get(job.company_id) ?? "unknown employer") : "unknown employer",
      title: job?.title ?? "unknown role",
      provider: run.provider,
      outcome: run.outcome,
      stopDetail: run.stop_detail,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      applicationStatus: app.status,
      humanApproved: Boolean(app.human_approved),
      submittedAt: app.submitted_at,
      blockedAnswers: blocked,
      screenshots: [],
      guardReport: run.guard_report,
      parserReconciliation: Array.isArray(run.parser_reconciliation) ? run.parser_reconciliation : [],
      action: blocked > 0
        ? `${blocked} question${blocked === 1 ? "" : "s"} could not be answered safely. Answer ${blocked === 1 ? "it" : "them"} here, then resume.`
        : (ACTION[run.outcome] ?? "Needs a look."),
      resolvableInPortal: blocked > 0,
    });
  }
  // Submitted applications are not open items.
  return out
    .filter((r) => !r.submittedAt)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function loadFillRuns(db: SupabaseClient, applicationId: string) {
  return paged<any>(db, "application_fill_runs",
    "id,started_at,finished_at,provider,outcome,stop_detail,form_snapshot_hash_at_fill,"
    + "fields_attempted,fields_filled,fields_left_blank,parser_reconciliation,guard_report,screenshot_dir",
    (q) => q.eq("application_id", applicationId), "started_at", false);
}

// ---- activity ---------------------------------------------------------

export async function loadPipelineRuns(db: SupabaseClient, limit = 40) {
  const runs = await paged<any>(db, "pipeline_runs",
    "id,kind,started_at,finished_at,succeeded,steps,companies_checked,companies_resolved,"
    + "jobs_added,jobs_closed,eligible_before,eligible_after",
    (q) => q, "started_at", false);
  return runs.slice(0, limit);
}

// ---- ATS status -------------------------------------------------------

export interface AtsStatus {
  provider: string;
  paused: boolean;
  pausedReason: string | null;
  capability: string;
  capabilityNote: string | null;
  companies: number;
  openJobs: number;
  applicationsQueued: number;
  handoffs: number;
  submitted: number;
  lastIngest: string | null;
  recentFailures: string[];
}

const QUEUED = new Set(["DRAFT", "PREPARING", "AWAITING_REVIEW", "READY_TO_SUBMIT", "BLOCKED_NEEDS_INPUT"]);
const SUBMITTED = new Set(["SUBMITTED", "ACKNOWLEDGED", "IN_PROCESS", "INTERVIEWING", "OFFER"]);

export async function loadAtsStatus(db: SupabaseClient): Promise<AtsStatus[]> {
  const [policies, companies, jobs, apps, runs] = await Promise.all([
    paged<any>(db, "ats_policy", "provider,paused,paused_reason,capability,capability_note", (q) => q, "provider")
      .catch(() => [] as any[]),
    paged<any>(db, "companies", "id,ats_provider,lifecycle,ats_token", (q) => q),
    paged<any>(db, "jobs", "id,source,status,company_id", (q) => q),
    paged<any>(db, "applications", "id,job_id,status", (q) => q),
    paged<any>(db, "application_fill_runs", "id,provider,outcome,started_at,stop_detail", (q) => q, "started_at", false),
  ]);

  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const providers = policies.length
    ? policies.map((p) => p.provider)
    : ["GREENHOUSE", "LEVER", "ASHBY"];

  return providers.map((provider) => {
    const policy = policies.find((p) => p.provider === provider);
    const theseJobs = jobs.filter((j) => j.source === provider);
    const appsHere = apps.filter((a) => jobById.get(a.job_id)?.source === provider);
    const runsHere = runs.filter((r) => r.provider === provider);
    return {
      provider,
      paused: policy ? Boolean(policy.paused) : true,
      pausedReason: policy?.paused_reason ?? null,
      capability: policy?.capability ?? "NONE",
      capabilityNote: policy?.capability_note ?? null,
      companies: companies.filter((c) => c.ats_provider === provider && c.ats_token).length,
      openJobs: theseJobs.filter((j) => j.status === "OPEN").length,
      applicationsQueued: appsHere.filter((a) => QUEUED.has(a.status)).length,
      handoffs: runsHere.filter((r) => r.outcome === "HANDOFF").length,
      submitted: appsHere.filter((a) => SUBMITTED.has(a.status)).length,
      lastIngest: null,
      recentFailures: runsHere.filter((r) => r.outcome !== "HANDOFF").slice(0, 3)
        .map((r) => `${r.outcome}: ${(r.stop_detail ?? "").slice(0, 90)}`),
    };
  });
}

// ---- company discovery ------------------------------------------------

export async function loadDiscovery(db: SupabaseClient) {
  const [sources, companies, candidates] = await Promise.all([
    paged<any>(db, "company_sources", "id,label,method,last_run_at,companies_found,notes", (q) => q),
    paged<any>(db, "companies",
      "id,name,domain,lifecycle,ats_provider,ats_token,ats_detection_method,discovery_method,"
      + "discovery_source,discovered_at,has_chicagoland_presence,hires_remote_us,last_checked_at", (q) => q),
    paged<any>(db, "company_token_candidates",
      "id,company_id,company_name,ats_provider,candidate_token,source,tested_at,test_result,job_count,confirmed", (q) => q),
  ]);
  const byCompany = new Map(companies.map((c) => [c.id, c]));
  // A tested token that was not confirmed is the interesting row: it is
  // a board that exists and demonstrably belongs to somebody else. That
  // rejection is the cross-company isolation protection doing its job,
  // and it is worth being able to read.
  const rejected = candidates
    .filter((c) => c.tested_at && !c.confirmed && c.test_result)
    .sort((a, b) => String(b.tested_at).localeCompare(String(a.tested_at)))
    .slice(0, 60)
    .map((c) => ({
      company: byCompany.get(c.company_id)?.name ?? c.company_name ?? "unknown",
      provider: c.ats_provider, token: c.candidate_token, method: c.source,
      testedAt: c.tested_at as string, reason: c.test_result as string,
    }));
  return { sources, companies, rejected };
}

// ---- dashboard counters -----------------------------------------------

export interface Counters {
  openJobs: number;
  eligible: number;
  candidates: number;
  stretches: number;
  validatedBoards: number;
  chicagoland: number;
  remoteUs: number;
  queued: number;
  needsAnswers: number;
  awaitingReview: number;
  readyToSubmit: number;
  handoffs: number;
  submitted: number;
  lastPipelineRun: string | null;
  lastPipelineKind: string | null;
}

export async function loadCounters(db: SupabaseClient): Promise<Counters> {
  const [jobs, companies, apps, answers, runs, pipelines, candidacy] = await Promise.all([
    paged<any>(db, "jobs", "id,status,eligibility", (q) => q),
    paged<any>(db, "companies", "id,ats_token,has_chicagoland_presence,hires_remote_us", (q) => q),
    paged<any>(db, "applications", "id,status,submitted_at", (q) => q),
    paged<any>(db, "application_answers", "id,application_id,confidence_state", (q) => q),
    paged<any>(db, "application_fill_runs", "id,application_id,outcome,started_at", (q) => q, "started_at", false),
    paged<any>(db, "pipeline_runs", "id,kind,started_at", (q) => q, "started_at", false).catch(() => []),
    paged<any>(db, "job_candidacy", "id,job_id,verdict", (q) => q).catch(() => []),
  ]);

  const open = jobs.filter((j) => j.status === "OPEN");
  const liveJobs = new Set(open.filter((j) => j.eligibility === "ELIGIBLE").map((j) => j.id));
  // One definition, shared with the queue and with Apply. Deriving this
  // from application.status counted work that had already been done.
  const blockedApps = applicationsNeedingAnswers(answers as any);
  // Live means still in play, not merely unsubmitted.
  //
  // This was `!a.submitted_at`, which correctly excluded submitted
  // applications and wrongly kept abandoned ones. Six abandoned drafts
  // still carried unresolved blocked answers from before they were
  // abandoned, so the header advertised six applications needing answers
  // that nobody could act on and that the queue rightly showed as
  // nothing. Closing an application ends its claim on attention.
  const live = apps.filter((a) => !a.submitted_at && !CLOSED_STATUSES.has(a.status));
  const latestRun = new Map<string, any>();
  for (const r of runs) if (!latestRun.has(r.application_id)) latestRun.set(r.application_id, r);

  return {
    openJobs: open.length,
    eligible: open.filter((j) => j.eligibility === "ELIGIBLE").length,
    // Counted against live jobs only. job_candidacy keeps its history, so
    // a verdict outlives the posting it was about: counting the table
    // directly reported 897 candidacy rows against 885 eligible jobs.
    candidates: candidacy.filter((c) => c.verdict === "APPLICATION_CANDIDATE" && liveJobs.has(c.job_id)).length,
    stretches: candidacy.filter((c) => c.verdict === "STRETCH" && liveJobs.has(c.job_id)).length,
    validatedBoards: companies.filter((c) => c.ats_token).length,
    chicagoland: companies.filter((c) => c.has_chicagoland_presence).length,
    remoteUs: companies.filter((c) => c.hires_remote_us).length,
    queued: live.filter((a) => QUEUED.has(a.status)).length,
    needsAnswers: live.filter((a) => blockedApps.has(a.id)).length,
    awaitingReview: live.filter((a) => a.status === "AWAITING_REVIEW").length,
    readyToSubmit: live.filter((a) => a.status === "READY_TO_SUBMIT").length,
    handoffs: live.filter((a) => latestRun.has(a.id)).length,
    submitted: apps.filter((a) => a.submitted_at).length,
    lastPipelineRun: pipelines[0]?.started_at ?? null,
    lastPipelineKind: pipelines[0]?.kind ?? null,
  };
}

/**
 * Which fill screenshots actually exist on this machine.
 *
 * Screenshots are deliberately local: they show a filled application
 * form, so they are never uploaded. The deployed portal runs somewhere
 * that has none of them, and this is how the page knows to say so
 * instead of rendering broken images.
 */
export async function existingScreenshots(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { resolve, sep } = await import("node:path");
  const root = resolve(process.cwd(), ".fill-runs");
  const full = resolve(process.cwd(), dir);
  if (full !== root && !full.startsWith(root + sep)) return [];
  try {
    const names = await readdir(full);
    return names.filter((n) => /^[0-9a-z][0-9a-z-]{0,60}\.png$/i.test(n)).sort();
  } catch {
    return [];
  }
}
