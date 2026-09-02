/**
 * Turning one intervention into something the system may rely on later.
 *
 * Everything here is a pure decision over a snapshot of what is already
 * believed. It writes nothing; it returns what SHOULD be written, with
 * the reasoning attached, so the same decision can be tested offline and
 * read back months later.
 *
 * Two rules do most of the work. Nothing overwrites an existing belief:
 * a disagreement opens a conflict and stops. And nothing broadens on one
 * example: an exact wording confirmed once is exact evidence and may be
 * relied on for that wording, but generalising past it takes repeated
 * confirmation from different places.
 */
import { classifyFeedback, normalizeQuestion, type Classification } from "./classify.ts";
import { INTENTS } from "../applications/intents.ts";
import type {
  AdapterRule, BankWrite, ContextualAnswer, FeedbackConflict, FeedbackEvent,
  LearnedProfileFact, SemanticMapping,
} from "./types.ts";

/** One approved answer already in the bank, as the learner needs it. */
export interface BankBelief {
  id: string;
  intentKey: string;
  answer: string | null;
  provenance: string | null;
}

/** What is already believed, at the moment the correction arrives. */
export interface BeliefSnapshot {
  /** Current profile values, by column. */
  profile: Record<string, unknown>;
  /** Which profile columns are VERIFIED truth rather than blank. */
  verifiedFields: Set<string>;
  mappings: SemanticMapping[];
  contextual: ContextualAnswer[];
  adapters: AdapterRule[];
  /** Approved answers already in the question bank. */
  bank?: BankBelief[];
}

export interface MappingWrite {
  normalizedQuestion: string;
  intentKey: string;
  provider: string | null;
  /** Set when an existing row is being confirmed again. */
  existingId: string | null;
  confirmations: number;
  status: SemanticMapping["status"];
  because: string;
}

export interface LearnOutcome {
  classification: Classification;
  profileFact: LearnedProfileFact | null;
  mapping: MappingWrite | null;
  contextual: Omit<ContextualAnswer, "id"> | null;
  adapter: Omit<AdapterRule, "id"> | null;
  bank: BankWrite | null;
  conflicts: Array<Omit<FeedbackConflict, "id">>;
  /** Why each of the above happened, or why nothing did. */
  audit: string[];
}

/**
 * How many independent confirmations broaden a mapping past the one ATS
 * it was seen on.
 *
 * One confirmation establishes the wording on the form it appeared on.
 * Claiming that every ATS phrasing it resembles means the same thing is
 * a different claim, and it takes seeing it hold somewhere else.
 */
export const BROADENING_CONFIRMATIONS = 2;

const sameAnswer = (a: unknown, b: unknown) =>
  String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/** "Yes"/"No" answers become booleans where the column is a boolean. */
function coerce(field: string, answer: string, current: unknown): string | boolean {
  if (typeof current === "boolean" || /^(is_|has_|requires_|willing_|relocation_assistance_required$)/.test(field)) {
    if (/^y(es)?$/i.test(answer.trim())) return true;
    if (/^n(o)?$/i.test(answer.trim())) return false;
  }
  return answer.trim();
}

export function learnFromFeedback(ev: FeedbackEvent, snap: BeliefSnapshot): LearnOutcome {
  const classification = classifyFeedback(ev);
  const out: LearnOutcome = {
    classification, profileFact: null, mapping: null, contextual: null, adapter: null, bank: null,
    conflicts: [], audit: [`classified ${classification.classification} (${classification.scope}): ${classification.because}`],
  };
  const normalized = ev.questionNormalized || normalizeQuestion(ev.questionRaw);

  // Checked before anything else, whatever the classification.
  //
  // If this wording is already confirmed to ask something else, then
  // what the question MEANS is in dispute, and an answer to a disputed
  // question is not evidence about anything. Nothing is promoted, the
  // existing mapping is weakened rather than replaced, and a person
  // decides which reading is right.
  const contradicting = ev.intentConfirmed ? snap.mappings.find(
    (m) => m.normalizedQuestion === normalized && m.intentKey !== ev.intentConfirmed && m.status === "ACTIVE"
    && (m.provider === null || m.provider === ev.provider)) : undefined;
  if (contradicting) {
    out.conflicts.push({
      kind: "SEMANTIC_MAPPING", subject: normalized,
      existing: contradicting.intentKey, incoming: ev.intentConfirmed!,
      fromEventId: "", status: "OPEN", resolution: null,
    });
    out.mapping = {
      normalizedQuestion: normalized, intentKey: contradicting.intentKey, provider: contradicting.provider,
      existingId: contradicting.id, confirmations: contradicting.confirmations, status: "CONTRADICTED",
      because: "contradicted by a later human answer",
    };
    out.audit.push(`this wording is already confirmed to ask ${contradicting.intentKey}, and the correction reads it as `
      + `${ev.intentConfirmed}; the existing mapping is marked contradicted, nothing is promoted, and a person reconciles it`);
    return out;
  }

  switch (classification.classification) {
    case "PROFILE_FACT": {
      const field = classification.profileField!;
      const current = snap.profile[field];
      const value = coerce(field, ev.humanAnswer, current);

      if (current !== null && current !== undefined && current !== "" && !sameAnswer(current, value)) {
        // Disagreeing with an established fact is the one case that must
        // never resolve itself. Whichever is right, a person decides.
        out.conflicts.push({
          kind: "PROFILE_FACT", subject: field,
          existing: String(current), incoming: String(value),
          fromEventId: "", status: "OPEN", resolution: null,
        });
        out.audit.push(`profile.${field} already holds ${JSON.stringify(current)}, which the correction contradicts`
          + `${snap.verifiedFields.has(field) ? " and which is VERIFIED truth" : ""}; nothing was written and a conflict is open for reconciliation`);
        break;
      }
      if (sameAnswer(current, value)) {
        out.audit.push(`profile.${field} already holds this value; the correction confirms it and changes nothing`);
        break;
      }
      out.profileFact = { field, value, provenance: "HUMAN_CONFIRMED", fromEventId: "" };
      out.audit.push(`profile.${field} set to ${JSON.stringify(value)} with HUMAN_CONFIRMED provenance`);
      break;
    }

    case "SEMANTIC_MAPPING": {
      const intentKey = ev.intentConfirmed!;
      const existing = snap.mappings.find(
        (m) => m.normalizedQuestion === normalized && m.intentKey === intentKey && m.provider === (ev.provider ?? null));
      const confirmations = (existing?.confirmations ?? 0) + 1;

      // The exact wording, on the ATS it was seen on, is exact evidence:
      // one human confirmation is enough for that and nothing wider.
      out.mapping = {
        normalizedQuestion: normalized, intentKey, provider: ev.provider ?? null,
        existingId: existing?.id ?? null, confirmations, status: "ACTIVE",
        because: existing
          ? `confirmed again (${confirmations} times) for this exact wording`
          : "one human confirmation establishes this exact wording, on this ATS, and nothing broader",
      };
      out.audit.push(out.mapping.because);

      // Broadening past the one ATS is a separate, weaker claim, and it
      // takes the wording holding somewhere else first.
      const elsewhere = snap.mappings.filter(
        (m) => m.normalizedQuestion === normalized && m.intentKey === intentKey
        && m.provider !== null && m.provider !== ev.provider && m.status === "ACTIVE");
      if (ev.provider && elsewhere.length + 1 >= BROADENING_CONFIRMATIONS) {
        out.audit.push(`the same wording is now confirmed on ${elsewhere.length + 1} ATS providers,`
          + " which is enough to stop treating it as provider specific");
        out.mapping = { ...out.mapping, provider: null, existingId: null,
          because: `confirmed on ${elsewhere.length + 1} different ATS providers` };
      }
      break;
    }

    case "CONTEXTUAL_ANSWER": {
      const intentKey = ev.intentConfirmed ?? ev.intentBefore ?? null;
      if (classification.scope === "NONE") {
        out.audit.push("the answer depends on conditions that were not recorded, so it is kept for the record and never reused");
        break;
      }

      // A question-keyed answer. It has no intent and must not be given
      // one, so the exact wording is what it is looked up by later.
      if (classification.scope === "QUESTION") {
        const rival = snap.contextual.find(
          (c) => c.scope === "QUESTION" && c.normalizedQuestion === normalized
          && !sameAnswer(c.answer, ev.humanAnswer));
        if (rival) {
          out.conflicts.push({
            kind: "CONTEXTUAL_ANSWER", subject: normalized,
            existing: rival.answer, incoming: ev.humanAnswer,
            fromEventId: "", status: "OPEN", resolution: null,
          });
          out.audit.push(`this exact question already has the approved answer ${JSON.stringify(rival.answer)},`
            + ` and this one says ${JSON.stringify(ev.humanAnswer)}; nothing was changed and a person reconciles it`);
          break;
        }
        if (snap.contextual.some((c) => c.scope === "QUESTION" && c.normalizedQuestion === normalized)) {
          out.audit.push("this exact question already has the same approved answer; the correction confirms it and changes nothing");
          break;
        }
        out.contextual = {
          intentKey: null, normalizedQuestion: normalized,
          answer: ev.humanAnswer, scope: "QUESTION", conditions: {},
          employer: null, provider: null, jobId: null,
          expiresAt: null, confirmations: 1, fromEventIds: [],
        };
        out.audit.push(`stored against the exact wording ${JSON.stringify(normalized)}, and reused only where that`
          + " exact wording is asked again; a question that merely resembles it is a different question");
        break;
      }

      out.contextual = {
        intentKey, normalizedQuestion: null,
        answer: ev.humanAnswer, scope: classification.scope,
        conditions: classification.conditions,
        employer: ev.employer, provider: ev.provider, jobId: ev.jobId,
        expiresAt: null, confirmations: 1, fromEventIds: [],
      };
      out.audit.push(`stored as an answer for ${intentKey} valid only where ${JSON.stringify(classification.conditions)}`);
      break;
    }

    case "BANK_ANSWER": {
      const intentKey = (ev.intentConfirmed ?? ev.intentBefore)!;
      const known = INTENTS.find((i) => i.key === intentKey);
      if (!known) {
        out.audit.push(`no catalog entry for ${intentKey}, so there is nothing to describe the stored answer`);
        break;
      }

      // Disagreeing with an approved answer is never resolved here. The
      // old answer keeps standing and a person decides which is right.
      const existing = (snap.bank ?? []).find((b) => b.intentKey === intentKey);
      if (existing && existing.answer !== null && !sameAnswer(existing.answer, ev.humanAnswer)) {
        out.conflicts.push({
          kind: "BANK_ANSWER", subject: intentKey,
          existing: String(existing.answer), incoming: ev.humanAnswer,
          fromEventId: "", status: "OPEN", resolution: null,
        });
        out.audit.push(`the bank already holds ${JSON.stringify(existing.answer)} for ${intentKey}, which this answer`
          + " contradicts; the stored answer is left exactly as it was and a conflict is open for reconciliation");
        break;
      }
      if (existing && sameAnswer(existing.answer, ev.humanAnswer)) {
        out.audit.push(`the bank already holds this answer for ${intentKey}; the correction confirms it and changes nothing`);
        break;
      }

      out.bank = {
        intentKey, intentDescription: known.description,
        category: known.category, answer: ev.humanAnswer,
        sensitive: known.category === "D_SENSITIVE",
        classification: known.category === "D_SENSITIVE" ? "SENSITIVE" : "NORMAL_PERSONAL",
        existingId: existing?.id ?? null,
        because: `approved by the person for ${intentKey} and stored with USER_RESPONSE provenance,`
          + " which is what it is: a reply they gave, not a fact evidence establishes",
      };
      out.audit.push(out.bank.because);
      break;
    }

    case "ADAPTER_CORRECTION": {
      if (!ev.provider) {
        out.audit.push("no ATS was recorded, so there is nothing to teach an adapter");
        break;
      }
      out.adapter = {
        provider: ev.provider, kind: "FIELD_LABEL",
        subject: ev.providerFieldKey ?? normalized,
        note: ev.humanAnswer, confirmations: 1, fromEventIds: [],
      };
      out.audit.push(`recorded against the ${ev.provider} adapter; it describes a control and can never become an answer`);
      break;
    }

    case "ONE_OFF":
      out.audit.push("kept for audit and history only");
      break;
  }

  return out;
}
