/**
 * Using what was learned, on a later application.
 *
 * The bar does not move. An answer supplied here carries HUMAN_CONFIRMED
 * provenance because a human actually confirmed it, for conditions that
 * actually match; it is not a lowered threshold and it is not a guess
 * dressed up as one. Where the conditions do not match, this returns
 * nothing and the field blocks exactly as it would have before, which is
 * the point: accumulated feedback makes the system answer MORE questions
 * correctly, never the same questions more loosely.
 *
 * The commute case is the one to hold in mind. "Yes, I can commute to
 * the Chicago office" is stored with Chicago attached. Asked about New
 * York, this returns nothing at all.
 */
import { SCOPE_ORDER, type AnswerConditions, type ContextualAnswer, type ReuseScope,
         type SemanticMapping } from "./types.ts";

export interface RecallRequest {
  intentKey: string | null;
  questionNormalized: string;
  provider: string | null;
  employer: string | null;
  jobId: string | null;
  /** Where THIS posting is. */
  conditions: AnswerConditions;
  now?: Date;
}

export interface RecallStore {
  mappings: SemanticMapping[];
  contextual: ContextualAnswer[];
}

export interface Recalled {
  answer: string;
  confidence: "HUMAN_CONFIRMED";
  scope: ReuseScope;
  because: string;
  fromEventIds: string[];
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Do the conditions a stored answer depends on hold for this posting?
 *
 * Absence is never a match. An answer given about a named city is not
 * usable for a posting whose city is unknown, because "unknown" is not
 * "the same place".
 */
export function conditionsHold(stored: AnswerConditions, asked: AnswerConditions): { ok: boolean; why: string } {
  const city = norm(stored.locationCity), metro = norm(stored.locationMetro), state = norm(stored.locationState);
  if (!city && !metro && !state) return { ok: false, why: "the stored answer records no conditions, so nothing can be shown to match" };

  const askedCity = norm(asked.locationCity), askedMetro = norm(asked.locationMetro), askedState = norm(asked.locationState);
  if (city && askedCity && city === askedCity) return { ok: true, why: `both are in ${stored.locationCity}` };
  if (metro && askedMetro && metro === askedMetro) return { ok: true, why: `both are in the ${stored.locationMetro} area` };
  if (metro && askedCity && metro === askedCity) return { ok: true, why: `the posting city matches the recorded area ${stored.locationMetro}` };

  if (!askedCity && !askedMetro && !askedState) {
    return { ok: false, why: "this posting records no location, so a location-dependent answer cannot be shown to apply" };
  }
  // Same state, different city is not the same commute.
  return {
    ok: false,
    why: `the answer was given about ${[stored.locationCity, stored.locationState].filter(Boolean).join(", ") || stored.locationMetro}`
       + `, and this posting is ${[asked.locationCity, asked.locationState].filter(Boolean).join(", ") || asked.locationMetro || "elsewhere"}`,
  };
}

/**
 * The intent a wording has been confirmed to carry.
 *
 * Provider-specific mappings win over broad ones: the narrower rule was
 * confirmed on the form actually in front of us. Only ACTIVE mappings
 * count, so a contradicted one stops answering until a person settles
 * it.
 */
export function recallIntent(questionNormalized: string, provider: string | null, store: RecallStore):
  { intentKey: string; because: string } | null {
  const candidates = store.mappings.filter(
    (m) => m.status === "ACTIVE" && m.normalizedQuestion === questionNormalized
    && (m.provider === null || m.provider === provider));
  if (!candidates.length) return null;

  const specific = candidates.filter((m) => m.provider !== null);
  const pick = (specific.length ? specific : candidates)
    .sort((a, b) => b.confirmations - a.confirmations)[0]!;

  // Two different intents both claiming this wording is not evidence,
  // it is a disagreement.
  const rival = candidates.find((m) => m.intentKey !== pick.intentKey);
  if (rival) return null;

  return {
    intentKey: pick.intentKey,
    because: `this exact wording was human confirmed to ask ${pick.intentKey}`
      + `${pick.provider ? ` on ${pick.provider}` : " on more than one ATS"}`
      + ` (${pick.confirmations} confirmation${pick.confirmations === 1 ? "" : "s"})`,
  };
}

/**
 * An answer previously confirmed for conditions that hold here.
 *
 * The narrowest justified scope wins. A job-specific answer beats an
 * employer-specific one, which beats a location-specific one, because
 * the narrower rule was confirmed closer to the question being asked.
 */
export function recallAnswer(req: RecallRequest, store: RecallStore): Recalled | { blocked: string } {
  const intentKey = req.intentKey;
  const asked = norm(req.questionNormalized);
  if (!intentKey && !asked) return { blocked: "no intent is established for this question" };

  const now = req.now ?? new Date();
  const rejected: string[] = [];
  const usable: Array<{ a: ContextualAnswer; why: string }> = [];

  for (const a of store.contextual) {
    // Keyed on the intent, or on the exact wording when there is no
    // intent to key on. A QUESTION-scoped answer matches one wording and
    // nothing that resembles it: "5+ years of SEO experience" and "SEO
    // experience" are different propositions, and the difference is the
    // part a person would be held to.
    if (a.scope === "QUESTION") {
      if (!asked || norm(a.normalizedQuestion) !== asked) continue;
    } else if (!intentKey || a.intentKey !== intentKey) {
      continue;
    }

    if (a.scope === "NONE") { rejected.push("an answer marked not reusable was ignored"); continue; }
    if (a.expiresAt && new Date(a.expiresAt) <= now) { rejected.push("a time limited answer has expired"); continue; }
    if (a.scope === "JOB" && a.jobId !== req.jobId) { rejected.push("an answer specific to another posting was ignored"); continue; }
    if (a.scope === "EMPLOYER" && norm(a.employer) !== norm(req.employer)) { rejected.push("an answer specific to another employer was ignored"); continue; }
    if (a.scope === "PROVIDER" && norm(a.provider) !== norm(req.provider)) { rejected.push("an answer specific to another ATS was ignored"); continue; }

    // Conditions gate an answer that HAS conditions. Requiring them of
    // an answer that records none would make every non-location scope
    // permanently unrecallable, because conditionsHold reports an empty
    // condition set as "nothing can be shown to match" -- correct for a
    // commute answer, wrong for "this exact question, anywhere".
    const conditioned = a.scope === "LOCATION"
      || Boolean(a.conditions.locationCity || a.conditions.locationMetro || a.conditions.locationState);
    if (conditioned) {
      const holds = conditionsHold(a.conditions, req.conditions);
      if (!holds.ok) { rejected.push(holds.why); continue; }
      usable.push({ a, why: holds.why });
      continue;
    }
    usable.push({ a, why: a.scope === "QUESTION"
      ? "this is the same question, word for word"
      : `it was confirmed for ${a.scope.toLowerCase()} and that still holds` });
  }

  if (!usable.length) {
    return { blocked: rejected.length
      ? `nothing confirmed applies here: ${rejected[0]}`
      : "nothing has been confirmed for this question" };
  }

  // Narrowest first, then most confirmed.
  usable.sort((x, y) =>
    SCOPE_ORDER.indexOf(x.a.scope) - SCOPE_ORDER.indexOf(y.a.scope) || y.a.confirmations - x.a.confirmations);

  // Two confirmed answers that disagree are a reconciliation problem,
  // not a tie to break.
  const top = usable[0]!;
  const disagreeing = usable.find((u) => norm(u.a.answer) !== norm(top.a.answer)
    && SCOPE_ORDER.indexOf(u.a.scope) === SCOPE_ORDER.indexOf(top.a.scope));
  if (disagreeing) {
    return { blocked: `two human confirmed answers of equal scope disagree (${top.a.answer} / ${disagreeing.a.answer}); this needs reconciliation` };
  }

  return {
    answer: top.a.answer,
    confidence: "HUMAN_CONFIRMED",
    scope: top.a.scope,
    because: `answered ${JSON.stringify(top.a.answer)} by a human for `
      + `${intentKey ?? `the question ${JSON.stringify(top.a.normalizedQuestion)}`}, and ${top.why}`,
    fromEventIds: top.a.fromEventIds,
  };
}
