/**
 * Storing what the reading was, at the time it was made.
 *
 * The evaluation is tied to the exact bytes it described, through the
 * canonical content hash. That is what stops an old reading from
 * appearing to describe a newer draft, which would be the most
 * flattering possible mistake: a resume revised after a poor evaluation
 * would carry the poor evaluation's record and the revised document,
 * and nothing would show that the two had ever disagreed.
 *
 * Nothing here writes to any table that decides anything. This module
 * imports no application state, no eligibility, and no browser code, and
 * a test asserts that it never will.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { contentHash } from "../render/canonical.ts";
import type { ResumeDoc } from "../render/resume.ts";
import type { Evaluation } from "./evaluator.ts";
import type { Reconciliation } from "./reconcile.ts";
import type { RevisionProposal } from "./loop.ts";

export const PERSIST_VERSION = 1;

export interface StoredEvaluation {
  resumeId: string;
  applicationId: string | null;
  jobId: string | null;
  jobVersionId: string | null;
  doc: ResumeDoc;
  iteration: number;
  evaluation: Evaluation;
  reconciliation: Reconciliation;
  revisions: Array<{ accepted: boolean; before: string; after: string; why: string }>;
  stoppedBecause: string | null;
}

/** The hash an evaluation is filed under: the document as it was read. */
export function evaluatedContentHash(doc: ResumeDoc): string {
  return contentHash(doc);
}

export async function storeEvaluation(db: SupabaseClient, s: StoredEvaluation): Promise<string | null> {
  const { data, error } = await db.from("resume_screening_evaluations").insert({
    resume_id: s.resumeId,
    application_id: s.applicationId,
    job_id: s.jobId,
    job_version_id: s.jobVersionId,
    content_sha256: evaluatedContentHash(s.doc),
    iteration: s.iteration,
    evaluator_version: s.evaluation.evaluatorVersion,
    model: s.evaluation.model,
    findings: s.evaluation.findings as any,
    requirement_coverage: s.evaluation.coverage as any,
    assessment: s.evaluation.assessment as any,
    score: s.evaluation.assessment.score,
    // The two kinds of gap are stored apart because they mean opposite
    // things: one is a job for the writer, the other is a fact.
    communication_gaps: s.reconciliation.communicationGaps.map((g) => ({
      requirement: g.finding.requirement, kind: g.finding.kind,
      detail: g.finding.detail, evidenceSays: g.evidenceSays, concepts: g.conceptKeys,
    })) as any,
    real_evidence_gaps: s.reconciliation.realEvidenceGaps.map((g) => ({
      requirement: g.finding.requirement, kind: g.finding.kind,
      detail: g.finding.detail, evidenceSays: g.evidenceSays, concepts: g.conceptKeys,
    })) as any,
    revision_decisions: s.revisions as any,
    stopped_because: s.stoppedBecause,
    // Diagnostics, not judgement. An evaluation that took two attempts
    // is worth exactly as much as one that took a single attempt; it
    // only cost more, and knowing how often that happens is how a
    // cheaper model gets argued for later.
    attempts: s.evaluation.attempts,
    first_attempt_failure: s.evaluation.firstAttemptFailure,
    input_tokens: s.evaluation.usage.inputTokens,
    output_tokens: s.evaluation.usage.outputTokens,
    estimated_cost_cents: s.evaluation.usage.estimatedCostCents,
    latency_ms: s.evaluation.usage.latencyMs,
  }).select("id").single();

  if (error) {
    // A duplicate is the same reading of the same bytes, which is not a
    // failure and is not stored twice.
    if (/screening_one_per_draft_iteration/.test(error.message)) return null;
    throw new Error(`the screening evaluation could not be stored: ${error.message}`);
  }
  return data?.id ?? null;
}

/** Everything ever read for one resume, oldest first. */
export async function evaluationHistory(db: SupabaseClient, resumeId: string) {
  const { data } = await db.from("resume_screening_evaluations")
    .select("id,iteration,content_sha256,model,score,attempts,first_attempt_failure,stopped_because,created_at")
    .eq("resume_id", resumeId).order("iteration").order("created_at");
  return data ?? [];
}

export function describeRevisions(
  accepted: RevisionProposal[], refused: Array<{ proposal: RevisionProposal; why: string }>,
): StoredEvaluation["revisions"] {
  return [
    ...accepted.map((p) => ({ accepted: true, before: p.before, after: p.after, why: p.becauseOf })),
    ...refused.map((r) => ({ accepted: false, before: r.proposal.before, after: r.proposal.after, why: r.why })),
  ];
}
