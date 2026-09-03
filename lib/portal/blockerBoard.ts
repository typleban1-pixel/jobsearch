/**
 * The applications page's data: every application with its one real
 * blocker, plus the compact summary a person reads in seconds.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadApplications, type ApplicationSummary } from "./applications.ts";
import { deriveBlocker, type Blocker, type BlockerFacts } from "./blocker.ts";
import { parseStopDetail, STOP_EVENT } from "../applications/stopReason.ts";

export interface BoardRow { app: ApplicationSummary; blocker: Blocker }
export interface BoardSummary {
  processing: number; needAnswer: number; needReview: number; ready: number;
  issue: number; submittedToday: number; submittedTotal: number;
}

const ISSUE_CODES = new Set(["AMBIGUOUS_SUBMIT_STATE", "SUBMISSION_FAILED", "REVALIDATION_FAILED", "FORM_NOT_READ"]);
const CLOSED = new Set(["REJECTED", "WITHDRAWN", "ABANDONED"]);

export async function loadBlockerBoard(db: SupabaseClient): Promise<{ rows: BoardRow[]; summary: BoardSummary }> {
  const apps = await loadApplications(db);

  const { data: jobRows } = await db.from("jobs").select("id,status,source,apply_url,application_form_url,url")
    .in("id", [...new Set(apps.map((a) => a.jobId))]);
  const jobById = new Map((jobRows ?? []).map((j: any) => [j.id, j]));
  const { data: ats } = await db.from("ats_policy").select("provider,paused,capability");
  const atsByProvider = new Map((ats ?? []).map((p: any) => [p.provider, p]));
  const { data: pol } = await db.from("automation_policy").select("max_applications_per_day").limit(1).maybeSingle();

  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const submittedToday = apps.filter((a) => a.submittedAt && a.submittedAt >= midnight.toISOString()).length;
  const cap = pol?.max_applications_per_day ?? null;
  const capReached = cap !== null && submittedToday >= cap;

  // The last recorded stop, for applications whose most recent attempt
  // stopped safely. One query, newest first, first per application.
  const { data: stops } = await db.from("application_events")
    .select("application_id,detail,occurred_at").eq("event", STOP_EVENT)
    .in("application_id", apps.map((a) => a.id)).order("occurred_at", { ascending: false });
  const lastStop = new Map<string, string>();
  for (const s of stops ?? []) if (!lastStop.has(s.application_id)) lastStop.set(s.application_id, s.detail);

  // submit_outcome is not on the summary; read it in one sweep.
  const { data: outcomes } = await db.from("applications").select("id,submit_outcome")
    .in("id", apps.map((a) => a.id));
  const outcomeById = new Map((outcomes ?? []).map((o: any) => [o.id, o.submit_outcome]));

  const rows: BoardRow[] = apps.map((a) => {
    const job = jobById.get(a.jobId);
    const policy = atsByProvider.get(job?.source ?? "");
    const stop = lastStop.get(a.id) ?? null;
    const facts: BlockerFacts = {
      status: a.status, submittedAt: a.submittedAt,
      submitQueued: Boolean(a.submitRequestedAt && !a.submitStartedAt),
      submitRunning: Boolean(a.submitStartedAt && !a.submittedAt),
      submitOutcome: (outcomeById.get(a.id) ?? null) as any,
      lastStopCode: stop ? parseStopDetail(stop)?.code ?? null : null,
      lastStopDetail: stop,
      humanApproved: a.humanApproved,
      blockedAnswers: a.blocked,
      requiredUnanswered: a.required - a.accountedFor,
      discoveredFields: a.discoveredFields,
      refusals: [],
      provider: job?.source ?? "UNKNOWN",
      providerCapability: policy?.capability ?? null,
      providerPaused: Boolean(policy?.paused),
      applyUrl: job?.application_form_url ?? job?.apply_url ?? job?.url ?? null,
      dailyCapReached: capReached,
      jobStatus: job?.status ?? "OPEN",
    };
    return { app: a, blocker: deriveBlocker(facts, a.id) };
  });

  const open = rows.filter((r) => !CLOSED.has(r.app.status));
  const summary: BoardSummary = {
    processing: open.filter((r) => r.blocker.code === "PROCESSING" || r.blocker.code === "SUBMISSION_IN_PROGRESS" || r.blocker.code === "ENQUEUED").length,
    needAnswer: open.filter((r) => r.blocker.code === "WAITING_FOR_MY_ANSWER").length,
    needReview: open.filter((r) => r.blocker.code === "WAITING_FOR_MY_REVIEW").length,
    ready: open.filter((r) => r.blocker.code === "READY_TO_SUBMIT" || r.blocker.code === "DAILY_CAP_REACHED").length,
    issue: open.filter((r) => ISSUE_CODES.has(r.blocker.code)
      || r.blocker.code === "ATS_NOT_AUTOMATED" || r.blocker.code === "AUTHENTICATION_REQUIRED").length,
    submittedToday,
    submittedTotal: rows.filter((r) => r.app.submittedAt).length,
  };
  return { rows, summary };
}
