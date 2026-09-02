/**
 * Turning "reuse this answer" into something that actually gets reused.
 *
 * The queue has always offered the checkbox. Ticking it set
 * application_answers.promote_to_bank = true and nothing read the
 * column, so the promise was never kept: measured before this existed,
 * 4 answers were flagged for reuse, 0 were linked to anything, and every
 * table the feedback architecture writes to held 0 rows.
 *
 * This is the missing half. It runs in the local worker rather than in
 * the portal, for the same reason preparation does: the deployed portal
 * holds a publishable Supabase key and nothing else, and that boundary
 * is not worth crossing for a convenience. Ticking the box records the
 * request; this fulfils it.
 *
 * It decides nothing on its own. classifyFeedback decides what kind of
 * knowledge an answer is, learnFromFeedback decides what may be written,
 * and both refuse to promote anything the person did not ask to reuse.
 * All this does is assemble the event and hand it over.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordFeedback, loadBeliefs } from "./store.ts";
import { normalizeQuestion } from "./classify.ts";
import { matchIntent } from "../applications/intents.ts";
import type { AnswerConditions, FeedbackEvent } from "./types.ts";

export interface PromotionOutcome {
  answerId: string;
  question: string;
  /** What was created, or why nothing was. */
  classification: string;
  scope: string;
  eventId: string | null;
  bankId: string | null;
  contextualId: string | null;
  conflicts: string[];
  audit: string[];
  skipped?: string;
}

/**
 * Promotes every answer whose reuse was requested and not yet fulfilled.
 *
 * Safe to run repeatedly. An answer is claimed by stamping the event id
 * on it, so a second run finds nothing to do rather than recording the
 * same intervention twice and opening a conflict against itself.
 */
export async function promoteRequestedAnswers(
  db: SupabaseClient, actor: string, opts: { applicationId?: string; dryRun?: boolean } = {},
): Promise<PromotionOutcome[]> {
  let q = db.from("application_answers")
    .select("id,application_id,question_text,field_label,field_key,answer_text,confidence_state,provenance,blocked_reason")
    .eq("promote_to_bank", true).is("promoted_event_id", null);
  if (opts.applicationId) q = q.eq("application_id", opts.applicationId);
  const { data: pending, error } = await q;
  if (error) throw new Error(`could not read the answers awaiting promotion: ${error.message}`);

  const out: PromotionOutcome[] = [];
  if (!pending?.length) return out;

  // Test applications never teach the real system anything.
  //
  // A rehearsal once wrote a placeholder answer to whatever question
  // happened to block first, marked it reusable, and promoted it. The
  // question was "Are you 18 years of age or older?", the placeholder
  // was "No", and the next real application was auto-filled with it
  // under HUMAN_CONFIRMED provenance. The rehearsal was fixed not to ask
  // for promotion; this makes the request unable to succeed even if
  // something asks again.
  const { data: testApps } = await db.from("applications").select("id").eq("is_test", true);
  const isTest = new Set((testApps ?? []).map((a: any) => a.id));

  const { data: profileRow } = await db.from("profile").select("*").eq("singleton", true).maybeSingle();

  for (const a of pending) {
    const question = a.question_text ?? a.field_label ?? "";
    const base: PromotionOutcome = {
      answerId: a.id, question, classification: "-", scope: "-",
      eventId: null, bankId: null, contextualId: null, conflicts: [], audit: [],
    };

    if (isTest.has(a.application_id)) {
      out.push({ ...base, skipped: "it belongs to a test application, and test data never becomes real truth" });
      continue;
    }

    // Only human work is promoted. A VERIFIED or DERIVED answer is
    // already computed from truth, and storing a copy of it as a
    // remembered reply would create a second answer that can drift from
    // the first. A BLOCKED one is not an answer at all.
    if (a.confidence_state !== "HUMAN_CONFIRMED") {
      out.push({ ...base, skipped: `it is ${a.confidence_state}, and only an answer you gave is promoted` });
      continue;
    }
    if (a.provenance !== "USER_RESPONSE") {
      out.push({ ...base, skipped: `its provenance is ${a.provenance ?? "unrecorded"}, not USER_RESPONSE` });
      continue;
    }
    if (a.answer_text === null) {
      // "Leave blank" is a real answer for one form and not a fact about
      // anything. There is nothing to reuse.
      out.push({ ...base, skipped: "it was deliberately left blank, which is an answer here and nowhere else" });
      continue;
    }

    const scope = await applicationScope(db, a.application_id);
    const intent = matchIntent(question).intent?.key ?? null;

    const ev: FeedbackEvent = {
      applicationId: a.application_id,
      jobId: scope.jobId, canonicalOpeningId: scope.canonicalOpeningId,
      employer: scope.employer, provider: scope.provider,
      questionRaw: question, questionNormalized: normalizeQuestion(question),
      providerFieldKey: a.field_key,
      intentBefore: intent,
      confidenceBefore: "BLOCKED",
      whyStopped: a.blocked_reason ?? "the resolver could not answer this from the profile",
      proposedAnswer: null,
      humanAnswer: a.answer_text,
      // Nothing here confirms what a question MEANS. The person answered
      // it; they did not say it asks something the catalog already
      // knows, and inferring that from an answer is exactly the guess
      // the semantic-mapping path exists to avoid making.
      intentConfirmed: null,
      conditions: scope.conditions,
      occurredAt: new Date().toISOString(),
      // The whole point: this ran because the box was ticked.
      reuseRequested: true,
    };

    if (opts.dryRun) {
      const { learnFromFeedback } = await import("./learn.ts");
      const snap = await loadBeliefs(db, (profileRow ?? {}) as Record<string, unknown>);
      const o = learnFromFeedback(ev, snap);
      out.push({ ...base, classification: o.classification.classification,
        scope: o.classification.scope, audit: o.audit,
        conflicts: o.conflicts.map((c) => `${c.kind}: ${c.existing} / ${c.incoming}`) });
      continue;
    }

    const snap = await loadBeliefs(db, (profileRow ?? {}) as Record<string, unknown>);
    const result = await recordFeedback(db, ev, snap, actor);

    // Claim the answer so a second run does not record it again. Written
    // after the event exists, so a crash between the two leaves the
    // answer unclaimed and the work repeatable, rather than claimed and
    // lost.
    const { data: back } = await db.from("answer_feedback_events")
      .select("resulting_question_bank_id,resulting_contextual_id").eq("id", result.eventId).single();
    await db.from("application_answers").update({
      promoted_event_id: result.eventId,
      question_bank_id: back?.resulting_question_bank_id ?? null,
    }).eq("id", a.id);

    out.push({
      ...base,
      classification: result.outcome.classification.classification,
      scope: result.outcome.classification.scope,
      eventId: result.eventId,
      bankId: back?.resulting_question_bank_id ?? null,
      contextualId: back?.resulting_contextual_id ?? null,
      conflicts: result.conflictIds,
      audit: result.outcome.audit,
    });
  }

  return out;
}

/** Where the posting is, which is what a conditional answer depends on. */
async function applicationScope(db: SupabaseClient, applicationId: string): Promise<{
  jobId: string | null; canonicalOpeningId: string | null;
  employer: string | null; provider: string | null; conditions: AnswerConditions;
}> {
  const empty = { jobId: null, canonicalOpeningId: null, employer: null, provider: null, conditions: {} };
  const { data: app } = await db.from("applications")
    .select("job_id,canonical_opening_id").eq("id", applicationId).maybeSingle();
  if (!app?.job_id) return empty;

  const { data: job } = await db.from("jobs")
    .select("id,source,company_id,canonical_opening_id").eq("id", app.job_id).maybeSingle();
  const { data: version } = await db.from("job_versions")
    .select("city,state,metro,remote_policy").eq("job_id", app.job_id).eq("is_current", true).maybeSingle();
  const { data: company } = job?.company_id
    ? await db.from("companies").select("name").eq("id", job.company_id).maybeSingle()
    : { data: null };

  return {
    jobId: app.job_id,
    canonicalOpeningId: app.canonical_opening_id ?? job?.canonical_opening_id ?? null,
    employer: company?.name ?? null,
    provider: job?.source ?? null,
    conditions: {
      locationCity: version?.city ?? null,
      locationState: version?.state ?? null,
      locationMetro: version?.metro ?? null,
      remotePolicy: version?.remote_policy ?? null,
    },
  };
}
