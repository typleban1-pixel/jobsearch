import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Reading applications for the portal.
 *
 * Everything here goes through the signed-in user's client, so RLS is
 * the authorization boundary rather than anything in this file. Paged
 * throughout: an unranged select silently stops at a thousand rows, and
 * that has bitten this codebase twice.
 */

export interface AnswerRow {
  id: string;
  applicationId: string;
  fieldKey: string | null;
  fieldLabel: string;
  questionText: string;
  answer: string | null;
  isRequired: boolean;
  confidence: "VERIFIED" | "DERIVED" | "HUMAN_CONFIRMED" | "BLOCKED";
  blockKind: "UNKNOWN" | "AMBIGUOUS" | null;
  blockedReason: string | null;
  evidenceIds: string[];
  considered: Array<{ rowId: string | null; what: string; whyRejected: string }>;
  promoteToBank: boolean | null;
  category: string;
}

export interface ApplicationSummary {
  discoveredFields: number;
  id: string;
  jobId: string;
  jobVersionId: string;
  title: string;
  company: string;
  status: string;
  allFieldsConfident: boolean;
  humanApproved: boolean;
  submissionMode: string;
  preparedAt: string | null;
  createdAt: string;
  resumeId: string | null;
  blocked: number;
  required: number;
  accountedFor: number;
  /** The posting moved on after this application froze its version. */
  postingChanged: boolean;
  /** The form the approval was bound to, so drift at fill time is visible. */
  formSnapshotHash: string | null;
  submittedAt: string | null;
  humanApprovedAt: string | null;
  submitRequestedAt: string | null;
  submitStartedAt: string | null;
}

async function paged<T>(db: SupabaseClient, table: string, cols: string,
  f: (q: any) => any = (q) => q, order = "id"): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(db.from(table).select(cols)).order(order).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as T[]));
    if ((data as T[]).length < 1000) break;
  }
  return out;
}

const toAnswer = (a: any): AnswerRow => ({
  id: a.id, applicationId: a.application_id,
  fieldKey: a.field_key, fieldLabel: a.field_label ?? a.question_text,
  questionText: a.question_text, answer: a.answer_text,
  isRequired: a.is_required, confidence: a.confidence_state,
  blockKind: a.block_kind, blockedReason: a.blocked_reason,
  evidenceIds: a.evidence_ids ?? [], considered: a.considered_evidence ?? [],
  promoteToBank: a.promote_to_bank, category: a.category,
});

const ANSWER_COLS =
  "id,application_id,field_key,field_label,question_text,answer_text,is_required," +
  "confidence_state,block_kind,blocked_reason,evidence_ids,considered_evidence,promote_to_bank,category";

export async function loadApplications(db: SupabaseClient): Promise<ApplicationSummary[]> {
  const apps = await paged<any>(db, "applications",
    "id,job_id,job_version_id,status,all_fields_confident,human_approved,submission_mode,prepared_at,created_at,resume_id,form_snapshot_hash,submitted_at,human_approved_at,submit_requested_at,submit_started_at",
    (q) => q.eq("is_test", false), "created_at");
  if (!apps.length) return [];

  const answers = await paged<any>(db, "application_answers", ANSWER_COLS,
    (q) => q.in("application_id", apps.map((a) => a.id)));
  const byApp = new Map<string, any[]>();
  for (const a of answers) byApp.set(a.application_id, [...(byApp.get(a.application_id) ?? []), a]);

  const jobs = await paged<any>(db, "jobs", "id,title,company_id",
    (q) => q.in("id", [...new Set(apps.map((a) => a.job_id))]));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const companies = await paged<any>(db, "companies", "id,name",
    (q) => q.in("id", [...new Set(jobs.map((j) => j.company_id))]));
  const companyById = new Map(companies.map((c) => [c.id, c.name as string]));

  // A frozen version that is no longer the posting's current one means
  // the employer edited the job after this application was prepared.
  const versions = await paged<any>(db, "job_versions", "id,is_current",
    (q) => q.in("id", apps.map((a) => a.job_version_id).filter(Boolean)));
  const currentVersion = new Map(versions.map((v) => [v.id, v.is_current as boolean]));

  return apps.map((a) => {
    const rows = byApp.get(a.id) ?? [];
    const required = rows.filter((r) => r.is_required);
    return {
      id: a.id, jobId: a.job_id, jobVersionId: a.job_version_id,
      title: jobById.get(a.job_id)?.title ?? "unknown role",
      company: companyById.get(jobById.get(a.job_id)?.company_id) ?? "unknown company",
      status: a.status,
      allFieldsConfident: a.all_fields_confident,
      humanApproved: a.human_approved,
      submissionMode: a.submission_mode,
      preparedAt: a.prepared_at, createdAt: a.created_at, resumeId: a.resume_id,
      blocked: rows.filter((r) => r.confidence_state === "BLOCKED").length,
      // Zero means the form was never read; approval of nothing is refused.
      discoveredFields: rows.length,
      required: required.length,
      accountedFor: required.filter((r) => r.confidence_state !== "BLOCKED").length,
      postingChanged: a.job_version_id ? currentVersion.get(a.job_version_id) === false : false,
      formSnapshotHash: a.form_snapshot_hash ?? null,
      submittedAt: a.submitted_at ?? null,
      humanApprovedAt: a.human_approved_at ?? null,
      submitRequestedAt: a.submit_requested_at ?? null,
      submitStartedAt: a.submit_started_at ?? null,
    };
  }).sort((x, y) => (y.createdAt ?? "").localeCompare(x.createdAt ?? ""));
}

export interface ResumeClaimRow {
  claim: string;
  evidenceIds: string[];
  sourceText: string | null;
  generation: string | null;
  grounding: any;
}

export interface ApplicationDetail {
  summary: ApplicationSummary;
  answers: AnswerRow[];
  accepted: ResumeClaimRow[];
  rejected: ResumeClaimRow[];
  masterClaims: string[];
  formFields: Array<{ key: string; label: string; type: string; required: boolean; options?: string[] }>;
  /** The employer-facing document itself, as metadata; bytes are served separately. */
  artifact: { sha256: string; bytes: number; rendererVersion: number | null } | null;
  snapshotProvider: string | null;
  evidenceText: Map<string, string>;
}

export async function loadApplication(db: SupabaseClient, id: string): Promise<ApplicationDetail | null> {
  const all = await loadApplications(db);
  const summary = all.find((a) => a.id === id);
  if (!summary) return null;

  const answers = (await paged<any>(db, "application_answers", ANSWER_COLS,
    (q) => q.eq("application_id", id))).map(toAnswer);

  const { data: app } = await db.from("applications").select("form_snapshot,resume_id").eq("id", id).single();
  const snapshot = app?.form_snapshot as any;

  let accepted: ResumeClaimRow[] = [], rejected: ResumeClaimRow[] = [];
  let artifact: ApplicationDetail["artifact"] = null;
  if (app?.resume_id) {
    const { data: r } = await db.from("resumes")
      .select("artifact_sha256,artifact_bytes,renderer_version").eq("id", app.resume_id).maybeSingle();
    if (r?.artifact_sha256) {
      artifact = { sha256: r.artifact_sha256, bytes: r.artifact_bytes ?? 0, rendererVersion: r.renderer_version };
    }
    const claims = await paged<any>(db, "resume_claims",
      "claim,evidence_ids,source_text,generation,grounding_checks", (q) => q.eq("resume_id", app.resume_id));
    const rows = claims.map((c) => ({
      claim: c.claim, evidenceIds: c.evidence_ids ?? [], sourceText: c.source_text,
      generation: c.generation, grounding: c.grounding_checks,
    }));
    accepted = rows.filter((r) => r.grounding?.ok !== false);
    rejected = rows.filter((r) => r.grounding?.ok === false);
  }

  // The master resume, so a reviewer can see what tailoring changed.
  const { data: master } = await db.from("resumes").select("id,label").eq("is_master", true).maybeSingle();
  let masterClaims: string[] = [];
  let evidenceText = new Map<string, string>();
  if (master) {
    masterClaims = (await paged<any>(db, "resume_claims", "claim", (q) => q.eq("resume_id", master.id)))
      .map((c) => c.claim as string);
    const version = Number(String(master.label).match(/profile version (\d+)/)?.[1] ?? 0);
    const rows = await paged<any>(db, "profile_version_rows", "row_id,source_table,row_data",
      (q) => q.eq("profile_version", version), "row_id");
    for (const r of rows) {
      const d = r.row_data;
      const t = [d.summary, d.detail, d.approved_wording, d.name, d.employer, d.institution]
        .filter(Boolean).join(" ");
      if (t) evidenceText.set(r.row_id, t);
    }
  }

  return {
    summary, answers, accepted, rejected, masterClaims, artifact,
    formFields: snapshot?.fields ?? [],
    snapshotProvider: snapshot?.provider ?? null,
    evidenceText,
  };
}

export interface QueueItem extends AnswerRow {
  applicationTitle: string;
  applicationCompany: string;
  jobId: string;
  options: string[];
  advice: ReuseAdvice;
}

/**
 * Every blocked question across every live application.
 *
 * Ordered so the applications closest to being finishable come first: a
 * single remaining block is one answer away from a review, and twelve
 * blocks is a different kind of afternoon.
 */
/**
 * Whether an answer to this question is worth keeping for next time.
 *
 * A consent, an attestation and a signature are about THIS employer and
 * this application; storing one and replaying it would be asserting
 * agreement to a document nobody read. A postal code or a name is a fact
 * about the applicant and is worth once. Everything in between is a
 * judgement, so the guidance says which it is and why, and the choice
 * stays the operator's.
 */
export type ReuseAdvice = { scope: "PROFILE" | "QUESTION" | "APPLICATION_ONLY"; why: string };

export function reuseAdviceFor(a: {
  category: string; fieldKey: string | null; questionText: string; blockKind: string | null;
}): ReuseAdvice {
  const key = (a.fieldKey ?? "").toLowerCase();
  const q = (a.questionText ?? "").toLowerCase();
  if (/signature|attest|certif/.test(key) || /\bi (?:acknowledge|agree|consent|certify|understand)\b/.test(q)) {
    return { scope: "APPLICATION_ONLY",
      why: "An acknowledgement or signature is about this employer's document. It is never replayed." };
  }
  if (/salary|compensation|expectation/.test(q)) {
    return { scope: "PROFILE",
      why: "A stated salary expectation is a standing preference. Marking it reusable stores it once, and it is never inferred." };
  }
  if (a.category === "D_SENSITIVE") {
    return { scope: "APPLICATION_ONLY",
      why: "Sensitive. Answer it here if you want to; it is not carried anywhere else unless you say so." };
  }
  if (/zip|postal|address|phone|full name|legal name/.test(q) || a.category === "A_VERIFIED_FACT") {
    return { scope: "PROFILE",
      why: "A fact about you rather than about this job. Worth storing once so it stops being asked." };
  }
  if (/how many years|which best describes|level of experience|proficien/.test(q)) {
    return { scope: "QUESTION",
      why: "Employers ask this in near-identical wording. Reusable only against this exact question, never generalized to adjacent skills." };
  }
  return { scope: "APPLICATION_ONLY",
    why: "Specific enough to this posting that carrying it forward would probably be wrong." };
}

export async function loadQueue(db: SupabaseClient): Promise<QueueItem[]> {
  const apps = await loadApplications(db);
  const live = apps.filter((a) => !["SUBMITTED", "REJECTED", "WITHDRAWN", "ABANDONED", "ACKNOWLEDGED", "IN_PROCESS", "INTERVIEWING", "OFFER"].includes(a.status));
  if (!live.length) return [];
  const rows = await paged<any>(db, "application_answers", ANSWER_COLS,
    (q) => q.in("application_id", live.map((a) => a.id)).eq("confidence_state", "BLOCKED"));
  const byId = new Map(live.map((a) => [a.id, a]));

  // The employer's own choices, so a blocked question can be answered
  // with what the form actually offers instead of free text that will
  // not match an option at fill time.
  const snapshots = await paged<any>(db, "applications", "id,form_snapshot",
    (q) => q.in("id", live.map((a) => a.id)));
  const optionsByApp = new Map<string, Map<string, string[]>>();
  for (const s of snapshots) {
    const m = new Map<string, string[]>();
    for (const f of (s.form_snapshot?.fields ?? [])) {
      if (Array.isArray(f.options) && f.options.length) m.set(f.key, f.options);
    }
    optionsByApp.set(s.id, m);
  }

  return rows
    .map((r) => ({
      ...toAnswer(r),
      applicationTitle: byId.get(r.application_id)?.title ?? "",
      applicationCompany: byId.get(r.application_id)?.company ?? "",
      jobId: byId.get(r.application_id)?.jobId ?? "",
      options: (optionsByApp.get(r.application_id) ?? new Map()).get(r.field_key) ?? [],
      advice: reuseAdviceFor({
        category: r.category, fieldKey: r.field_key,
        questionText: r.question_text ?? r.field_label, blockKind: r.block_kind,
      }),
    }))
    .sort((a, b) =>
      (byId.get(a.applicationId)?.blocked ?? 0) - (byId.get(b.applicationId)?.blocked ?? 0)
      || Number(b.isRequired) - Number(a.isRequired)
      || a.applicationCompany.localeCompare(b.applicationCompany));
}

export interface EventRow {
  id: string; event: string; detail: string | null;
  fromStatus: string | null; toStatus: string | null;
  actor: string | null; occurredAt: string;
}

export async function loadEvents(db: SupabaseClient, applicationId: string): Promise<EventRow[]> {
  const rows = await paged<any>(db, "application_events",
    "id,event,detail,from_status,to_status,actor,occurred_at",
    (q) => q.eq("application_id", applicationId), "occurred_at");
  return rows.map((e) => ({
    id: e.id, event: e.event, detail: e.detail,
    fromStatus: e.from_status, toStatus: e.to_status,
    actor: e.actor, occurredAt: e.occurred_at,
  }));
}
