/**
 * Reading and writing what has been learned.
 *
 * The decisions themselves live in learn.ts and recall.ts, as pure
 * functions over a snapshot, so they can be argued with offline. This is
 * only the part that talks to the database, and it keeps two properties
 * the rest of the system depends on: the event is written before
 * anything derived from it, and a conflict is written INSTEAD of a
 * change, never alongside one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { learnFromFeedback, type BeliefSnapshot, type LearnOutcome } from "./learn.ts";
import { normalizeQuestion } from "./classify.ts";
import type { RecallStore } from "./recall.ts";
import type { AdapterRule, ContextualAnswer, FeedbackEvent, SemanticMapping } from "./types.ts";

/** Everything a later application may draw on. */
export async function loadRecallStore(db: SupabaseClient): Promise<RecallStore> {
  const [{ data: mappings }, { data: contextual }] = await Promise.all([
    db.from("semantic_mappings").select("*").eq("status", "ACTIVE"),
    db.from("contextual_answers").select("*"),
  ]);
  return {
    mappings: (mappings ?? []).map(rowToMapping),
    contextual: (contextual ?? []).map(rowToContextual),
  };
}

export async function loadBeliefs(db: SupabaseClient, profileRow: Record<string, unknown>): Promise<BeliefSnapshot> {
  const [{ data: mappings }, { data: contextual }, { data: adapters }, { data: bank }] = await Promise.all([
    db.from("semantic_mappings").select("*"),
    db.from("contextual_answers").select("*"),
    db.from("ats_adapter_rules").select("*"),
    // Every bank row, not only the reusable ones: an answer already
    // stored for an intent contradicts a new one whether or not reuse
    // happens to be switched on for it.
    db.from("question_bank").select("id,intent_key,approved_answer,answer_provenance"),
  ]);
  // A column holding a value is a fact already established; the
  // distinction from a blank one is what makes a contradiction visible.
  const verified = new Set(Object.entries(profileRow)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k]) => k));
  return {
    profile: profileRow,
    verifiedFields: verified,
    mappings: (mappings ?? []).map(rowToMapping),
    contextual: (contextual ?? []).map(rowToContextual),
    adapters: (adapters ?? []).map(rowToAdapter),
    bank: (bank ?? []).map((r: any) => ({
      id: r.id, intentKey: r.intent_key, answer: r.approved_answer, provenance: r.answer_provenance,
    })),
  };
}

const rowToMapping = (r: any): SemanticMapping => ({
  id: r.id, normalizedQuestion: r.normalized_question, intentKey: r.intent_key,
  provider: r.provider, confirmations: r.confirmations, status: r.status,
  fromEventIds: r.from_event_ids ?? [],
});
const rowToContextual = (r: any): ContextualAnswer => ({
  id: r.id, intentKey: r.intent_key, normalizedQuestion: r.normalized_question ?? null,
  answer: r.answer, scope: r.scope,
  conditions: r.conditions ?? {}, employer: r.employer, provider: r.provider,
  jobId: r.job_id, expiresAt: r.expires_at, confirmations: r.confirmations,
  fromEventIds: r.from_event_ids ?? [],
});
const rowToAdapter = (r: any): AdapterRule => ({
  id: r.id, provider: r.provider, kind: r.kind, subject: r.subject,
  note: r.note, confirmations: r.confirmations, fromEventIds: r.from_event_ids ?? [],
});

export interface RecordResult {
  eventId: string;
  outcome: LearnOutcome;
  /** Conflicts opened. Non-empty means a person has to decide something. */
  conflictIds: string[];
}

/**
 * Records one intervention and applies what it teaches.
 *
 * The event goes in first and unconditionally, because it is history:
 * even a correction that teaches nothing reusable is the record of what
 * the system could not do. Everything after it is derived, and each
 * derived write points back at the event that caused it.
 */
export async function recordFeedback(
  db: SupabaseClient, ev: FeedbackEvent, snap: BeliefSnapshot, actor: string,
): Promise<RecordResult> {
  if (!actor.startsWith("user:")) {
    throw new Error(`feedback comes from a person; the actor ${JSON.stringify(actor)} is not one`);
  }
  const normalized = ev.questionNormalized || normalizeQuestion(ev.questionRaw);
  const outcome = learnFromFeedback({ ...ev, questionNormalized: normalized }, snap);

  const { data: event, error } = await db.from("answer_feedback_events").insert({
    application_id: ev.applicationId, job_id: ev.jobId, canonical_opening_id: ev.canonicalOpeningId,
    employer: ev.employer, provider: ev.provider,
    question_raw: ev.questionRaw, question_normalized: normalized, provider_field_key: ev.providerFieldKey,
    intent_before: ev.intentBefore, confidence_before: ev.confidenceBefore, why_stopped: ev.whyStopped,
    proposed_answer: ev.proposedAnswer, human_answer: ev.humanAnswer, intent_confirmed: ev.intentConfirmed,
    classification: outcome.classification.classification,
    reuse_scope: outcome.classification.scope,
    conditions: ev.conditions as any,
    audit: outcome.audit, actor, occurred_at: ev.occurredAt,
  }).select("id").single();
  if (error || !event) throw new Error(`the intervention could not be recorded: ${error?.message}`);
  const eventId = event.id as string;

  const conflictIds: string[] = [];
  for (const c of outcome.conflicts) {
    const { data } = await db.from("feedback_conflicts").insert({
      kind: c.kind, subject: c.subject, existing: c.existing, incoming: c.incoming,
      from_event_id: eventId, status: "OPEN",
    }).select("id").single();
    if (data) conflictIds.push(data.id as string);
  }

  const patch: Record<string, unknown> = {};

  if (outcome.profileFact) {
    const { error: pErr } = await db.from("profile")
      .update({ [outcome.profileFact.field]: outcome.profileFact.value })
      .eq("singleton", true);
    if (pErr) throw new Error(`the profile fact could not be written: ${pErr.message}`);
    // Provenance is recorded as its own statement, naming the person and
    // the event, so a later reader can see why the system believes it.
    await db.from("truth_change_log").insert({
      source_table: "profile", operation: "UPDATE",
      changed_fields: [outcome.profileFact.field],
      new_data: {
        [outcome.profileFact.field]: outcome.profileFact.value,
        basis: `HUMAN_CONFIRMED via feedback event ${eventId}`,
        question: ev.questionRaw, application: ev.applicationId,
      } as any,
      actor,
    });
    patch.resulting_profile_field = outcome.profileFact.field;
  }

  if (outcome.mapping) {
    const m = outcome.mapping;
    if (m.existingId) {
      await db.from("semantic_mappings").update({
        confirmations: m.confirmations, status: m.status, provider: m.provider,
        from_event_ids: [...(snap.mappings.find((x) => x.id === m.existingId)?.fromEventIds ?? []), eventId],
        updated_at: new Date().toISOString(),
      }).eq("id", m.existingId);
      patch.resulting_mapping_id = m.existingId;
    } else {
      const { data } = await db.from("semantic_mappings").insert({
        normalized_question: m.normalizedQuestion, intent_key: m.intentKey, provider: m.provider,
        confirmations: m.confirmations, status: m.status, from_event_ids: [eventId],
      }).select("id").single();
      if (data) patch.resulting_mapping_id = data.id;
    }
  }

  if (outcome.contextual) {
    const c = outcome.contextual;
    const { data, error: cErr } = await db.from("contextual_answers").insert({
      intent_key: c.intentKey, normalized_question: c.normalizedQuestion,
      answer: c.answer, scope: c.scope, conditions: c.conditions as any,
      employer: c.employer, provider: c.provider, job_id: c.jobId,
      expires_at: c.expiresAt, confirmations: c.confirmations, from_event_ids: [eventId],
    }).select("id").single();
    if (cErr) throw new Error(`the reusable answer could not be stored: ${cErr.message}`);
    if (data) patch.resulting_contextual_id = data.id;
  }

  // The question bank. An approved answer names the occasion it was
  // given on, so a later reader can always find the form that asked.
  if (outcome.bank) {
    const b = outcome.bank;
    const fields = {
      approved_answer: b.answer,
      // Always. The person is the source, and being stored for reuse
      // does not turn what they said into evidence.
      answer_provenance: "USER_RESPONSE",
      reuse_allowed: true,
      last_reviewed: new Date().toISOString(),
      source_application_id: ev.applicationId,
      source_event_id: eventId,
      source_question_raw: ev.questionRaw,
    };
    if (b.existingId) {
      const { error: bErr } = await db.from("question_bank").update(fields).eq("id", b.existingId);
      if (bErr) throw new Error(`the approved answer could not be updated: ${bErr.message}`);
      patch.resulting_question_bank_id = b.existingId;
    } else {
      const { data, error: bErr } = await db.from("question_bank").insert({
        intent_key: b.intentKey, intent_description: b.intentDescription,
        category: b.category, sensitive: b.sensitive, classification: b.classification,
        // Deliberately empty. A reply the person gave cites no evidence,
        // and inventing an id to make it look grounded is the exact
        // failure this system exists to prevent.
        evidence_ids: [],
        ...fields,
      }).select("id").single();
      if (bErr) throw new Error(`the approved answer could not be stored: ${bErr.message}`);
      if (data) patch.resulting_question_bank_id = data.id;
    }
  }

  if (outcome.adapter) {
    const a = outcome.adapter;
    const existing = snap.adapters.find((x) => x.provider === a.provider && x.kind === a.kind && x.subject === a.subject);
    if (existing) {
      await db.from("ats_adapter_rules").update({
        confirmations: existing.confirmations + 1,
        from_event_ids: [...existing.fromEventIds, eventId],
      }).eq("id", existing.id);
      patch.resulting_adapter_rule_id = existing.id;
    } else {
      const { data } = await db.from("ats_adapter_rules").insert({
        provider: a.provider, kind: a.kind, subject: a.subject, note: a.note,
        confirmations: 1, from_event_ids: [eventId],
      }).select("id").single();
      if (data) patch.resulting_adapter_rule_id = data.id;
    }
  }

  // The event names what it produced. This is the one permitted write to
  // an event row, and the trigger allows exactly these columns.
  if (Object.keys(patch).length) {
    await db.from("answer_feedback_events").update(patch).eq("id", eventId);
  }

  return { eventId, outcome, conflictIds };
}
