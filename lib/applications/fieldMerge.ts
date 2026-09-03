/**
 * Rediscovering a form must not erase what was answered about it.
 *
 * Discovery deleted every answer row and re-inserted from the DOM, so
 * each pass over a Workday page reset fields that had already been
 * resolved -- verified identity, a confirmed preferred name, a phone
 * code a person had just supplied. Nothing was lost permanently because
 * the resolver could run again, but a HUMAN_CONFIRMED answer is not
 * reproducible: it came from a person, and deleting it throws away the
 * one kind of answer this system cannot regenerate.
 *
 * Multi-step forms make it worse. Page 2's DOM does not contain page 1's
 * fields, so a delete-and-recreate on step 2 would discard step 1
 * entirely.
 *
 * WHAT COUNTS AS THE SAME FIELD
 *
 * The field key, falling back to the question text. Two controls with
 * the same key are the same question asked again.
 *
 * WHAT COUNTS AS A CHANGE
 *
 * The question's wording, whether it is required, and the choices it
 * offers. Any of those moving means the employer is asking something
 * different, and an answer given to the old wording is not an answer to
 * the new one. That fails closed: the answer is set aside and the field
 * returns for reconciliation rather than being carried over.
 */

export interface StoredField {
  id?: string;
  field_key: string | null;
  question_text: string;
  is_required: boolean;
  /** The choices offered when the answer was given, if any. */
  options?: string[] | null;
  answer_text: string | null;
  confidence_state: string;
  category?: string | null;
  provenance?: string | null;
  block_kind?: string | null;
  blocked_reason?: string | null;
  evidence_ids?: string[] | null;
}

export interface DiscoveredField {
  field_key: string | null;
  question_text: string;
  is_required: boolean;
  options?: string[] | null;
}

export type MergeAction = "PRESERVED" | "ADDED" | "RECONCILE" | "RETAINED_OFFPAGE";

export interface MergeResult {
  action: MergeAction;
  field: StoredField;
  /** Set on RECONCILE: what moved. */
  changed?: string[];
}

const keyOf = (f: { field_key: string | null; question_text: string }): string =>
  (f.field_key && f.field_key.trim()) || f.question_text.trim();

const sameOptions = (a?: string[] | null, b?: string[] | null): boolean => {
  const x = [...(a ?? [])].sort(), y = [...(b ?? [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** What materially differs between a stored field and its rediscovery. */
export function materialChanges(stored: StoredField, found: DiscoveredField): string[] {
  const changed: string[] = [];
  if (stored.question_text.trim() !== found.question_text.trim()) changed.push("question text");
  if (Boolean(stored.is_required) !== Boolean(found.is_required)) changed.push("required status");
  if (!sameOptions(stored.options, found.options)) changed.push("available choices");
  return changed;
}

/**
 * Merges a discovery pass into what is already recorded.
 *
 * Never deletes. A stored field absent from this page is retained,
 * because a later step's DOM does not contain an earlier step's
 * questions and their answers are still true.
 */
export function mergeDiscovery(
  stored: StoredField[],
  found: DiscoveredField[],
): MergeResult[] {
  const byKey = new Map(stored.map((s) => [keyOf(s), s]));
  const seen = new Set<string>();
  const out: MergeResult[] = [];

  for (const f of found) {
    const k = keyOf(f);
    seen.add(k);
    const prior = byKey.get(k);
    if (!prior) {
      out.push({ action: "ADDED", field: {
        field_key: f.field_key, question_text: f.question_text, is_required: f.is_required,
        options: f.options ?? null, answer_text: null, confidence_state: "BLOCKED",
        category: "E_UNKNOWN", provenance: "USER_RESPONSE", block_kind: "UNKNOWN",
        blocked_reason: "discovered on the employer's form; not yet resolved against verified evidence",
        evidence_ids: [],
      } });
      continue;
    }
    const changed = materialChanges(prior, f);
    if (changed.length) {
      // Fail closed. The old answer is not carried onto a changed
      // question; it is set aside and the field comes back for review.
      out.push({ action: "RECONCILE", changed, field: {
        ...prior, question_text: f.question_text, is_required: f.is_required,
        options: f.options ?? null, answer_text: null, confidence_state: "BLOCKED",
        block_kind: "AMBIGUOUS",
        blocked_reason: `the employer changed this question (${changed.join(", ")}); `
          + `the previous answer${prior.answer_text ? ` ("${prior.answer_text}")` : ""} was given to different `
          + `wording and has not been carried over`,
      } });
      continue;
    }
    // Unchanged: everything about the answer survives untouched.
    out.push({ action: "PRESERVED", field: { ...prior, options: f.options ?? prior.options ?? null } });
  }

  for (const s of stored) {
    if (seen.has(keyOf(s))) continue;
    // A field from an earlier step. Not on this page, still answered.
    out.push({ action: "RETAINED_OFFPAGE", field: s });
  }
  return out;
}

export const summarise = (r: MergeResult[]): Record<MergeAction, number> => {
  const t = { PRESERVED: 0, ADDED: 0, RECONCILE: 0, RETAINED_OFFPAGE: 0 } as Record<MergeAction, number>;
  for (const x of r) t[x.action]++;
  return t;
};
