/**
 * Matching the reviewed question to the live control.
 *
 * The board API describes the SEMANTIC field: what is being asked,
 * whether it is required, and what answers are acceptable. The embedded
 * DOM describes the INTERACTION: Greenhouse renders the same question as
 * a native select on one surface and as a react-select combobox with no
 * <option> elements on another. Treating those as a mismatch would block
 * every embedded form; treating them as interchangeable by position
 * would put an answer in the wrong box.
 *
 * So identity and control type are separate concepts. Identity is
 * established from stable evidence — the provider's own field name, the
 * question wording, the intent the resolver assigned — and never from
 * where a control happens to sit on the page. There is no index-based
 * matching here and none may be added: ambiguity blocks.
 */
import type { FormField } from "../applications/answer.ts";
import type { LiveField } from "./liveSnapshot.ts";
import { matchIntent } from "../applications/intents.ts";

export const RECONCILE_VERSION = 1;

export type MatchBasis = "provider-key" | "exact-label" | "normalized-label" | "intent-key";

export interface Reconciled {
  live: LiveField;
  api: FormField | null;
  basis: MatchBasis | null;
  /** Set when identity could not be established safely. */
  blocked: string | null;
  /** The API and DOM disagree about the control type. Legitimate, and recorded. */
  controlTypeDiffers: boolean;
}

const norm = (s: string) =>
  s.toLowerCase().replace(/\*/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Reconciles one live control against the reviewed field set.
 *
 * Tried in order of how much the evidence proves. A provider key is the
 * provider's own identifier for the question and is conclusive; a label
 * match is strong; an intent match is weakest and is only accepted when
 * it is unique on both sides, because two different questions can share
 * an intent and answering one with the other's answer is exactly the
 * failure this exists to prevent.
 */
export function reconcileField(live: LiveField, api: FormField[]): Reconciled {
  const base = { live, api: null as FormField | null, basis: null as MatchBasis | null, blocked: null as string | null, controlTypeDiffers: false };

  const finish = (match: FormField, basis: MatchBasis): Reconciled => ({
    live, api: match, basis, blocked: null,
    controlTypeDiffers: match.type !== live.type,
  });

  // 1. The provider's own key for the question.
  const byKey = api.filter((f) => f.key === live.key);
  if (byKey.length === 1) return finish(byKey[0]!, "provider-key");
  if (byKey.length > 1) {
    return { ...base, blocked: `${byKey.length} reviewed fields share the key ${live.key}` };
  }

  // 2. The question as written.
  const exact = api.filter((f) => f.label === live.label);
  if (exact.length === 1) return finish(exact[0]!, "exact-label");
  const normalized = api.filter((f) => norm(f.label) === norm(live.label));
  if (normalized.length === 1) return finish(normalized[0]!, "normalized-label");
  if (normalized.length > 1) {
    return { ...base, blocked: `${normalized.length} reviewed fields ask ${JSON.stringify(live.label.slice(0, 50))}` };
  }

  // 3. The intent, and only when it is unique on both sides.
  const liveIntent = matchIntent(live.label).intent?.key;
  if (liveIntent) {
    const byIntent = api.filter((f) => matchIntent(f.label).intent?.key === liveIntent);
    if (byIntent.length === 1) return finish(byIntent[0]!, "intent-key");
    if (byIntent.length > 1) {
      return { ...base, blocked: `${byIntent.length} reviewed fields share the intent ${liveIntent}` };
    }
  }

  return { ...base, blocked: "no reviewed field corresponds to this control" };
}

export function reconcileAll(live: LiveField[], api: FormField[]): Reconciled[] {
  const results = live.map((l) => reconcileField(l, api));

  // One reviewed field may not answer two live controls unless they are
  // the same element, which the alias check handles separately.
  const counts = new Map<string, number>();
  for (const r of results) if (r.api) counts.set(r.api.key, (counts.get(r.api.key) ?? 0) + 1);
  return results.map((r) => {
    if (r.api && (counts.get(r.api.key) ?? 0) > 1 && r.basis === "intent-key") {
      return { ...r, api: null, basis: null, blocked: `the reviewed field ${r.api.key} would answer several live controls` };
    }
    return r;
  });
}

/**
 * Whether a confirmed answer may be given to this live control.
 *
 * A stored answer establishes what the person said. It does not
 * establish that an arbitrary control accepts it. Where the live control
 * offers choices, the answer has to BE one of them; where it offers
 * none, the reviewed field's own options still govern, because a
 * question that had a closed answer set when it was reviewed does not
 * become free text because the DOM renders it differently.
 */
export function answerFitsControl(
  answer: string, live: LiveField, api: FormField | null, inspectedOptions: string[] | null,
): { ok: true; value: string } | { ok: false; why: string } {
  const offered = inspectedOptions ?? (live.options?.length ? live.options : null);

  if (offered && offered.length) {
    const hit = offered.find((o) => o.trim().toLowerCase() === answer.trim().toLowerCase());
    if (hit) return { ok: true, value: hit };
    return { ok: false, why: `the live control does not offer ${JSON.stringify(answer)} (offers ${offered.slice(0, 6).join(", ")}${offered.length > 6 ? ", ..." : ""})` };
  }

  // No live choices visible. If the reviewed field was a closed set, the
  // answer must still be one of its values: a control whose options
  // could not be read is not thereby a free-text box.
  if (api && (api.options?.length ?? 0) > 0) {
    const hit = api.options!.find((o) => o.trim().toLowerCase() === answer.trim().toLowerCase());
    if (hit) return { ok: true, value: hit };
    return { ok: false, why: `the reviewed question is a closed set and does not include ${JSON.stringify(answer)}` };
  }

  if (live.type === "text" || live.type === "textarea" || live.type === "number" || live.type === "date") {
    return { ok: true, value: answer };
  }
  return { ok: false, why: `the live control offers no readable choices and the reviewed question had none either` };
}
