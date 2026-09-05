/**
 * Classifying an open-ended application question into how it may be answered.
 *
 * The engine must tell apart four things that all arrive as free text:
 *
 *   PERSONALITY        "tell us a fun fact" -- compose from HUMAN_CONFIRMED
 *                      personality/interest facts.
 *   GROUNDED_OPEN_ENDED "why are you interested", "describe relevant
 *                      experience", "how do you approach ambiguity" -- a
 *                      written answer drawn ENTIRELY from verified evidence.
 *   NEW_FACT_REQUIRED  "how many years have you personally done X",
 *                      "rate your proficiency 1-10" -- a specific fact or
 *                      quantity that is not established. Never fabricated;
 *                      it blocks.
 *   NOT_OPEN_ENDED     handled by the ordinary intent/low-stakes paths.
 *
 * Classification is deterministic. The composer is the backstop: even a
 * GROUNDED question returns INSUFFICIENT (and blocks) if the evidence does
 * not actually support an answer, so a permissive classification never
 * becomes an invented one.
 */
export type OpenEndedKind = "PERSONALITY" | "GROUNDED_OPEN_ENDED" | "NEW_FACT_REQUIRED" | "NOT_OPEN_ENDED";

/** A specific unestablished fact/quantity. Checked FIRST; these must block. */
const NEW_FACT: RegExp[] = [
  /\bhow many years\b/i,
  /\byears? of (?:experience|expertise)\b/i,
  /\bhow many\b[^?]{0,40}\b(?:years|jobs|companies|projects|people|reports|campaigns|deals)\b/i,
  /\brate your\b|\bon a scale of\b|\bself[- ]?rate\b/i,
  /\bwhat (?:is|was) your\b[^?]{0,30}\b(?:gpa|sat|act|salary|score|notice period)\b/i,
  /\bhow long have you\b/i,
  /\bwhat is your (?:current )?(?:base )?(?:salary|compensation|pay)\b/i,
];

/** Personality / interest / "about you" questions. */
const PERSONALITY: RegExp[] = [
  /\bfun fact\b/i,
  /\bsomething (?:interesting|unique|surprising|fun|cool)\b/i,
  /\bsomething (?:we|that we)\s*(?:would ?n[o']?t|wouldn't|don'?t)\s*know\b/i,
  /\bnot on (?:your|the) r[ée]sum[ée]\b|\bfrom your r[ée]sum[ée]\b/i,
  /\boutside (?:of )?work\b/i,
  /\bhobb(?:y|ies)\b/i,
  /\bpassionate about\b/i,
  /\bwhat (?:are you|do you) (?:interested in|enjoy|like to do|do for fun)\b/i,
  /\btell us (?:a little )?about yourself\b/i,
  /\bget to know you\b|\bmore about you\b/i,
];

/** Motivation / experience / behavioral -- answerable from verified evidence. */
const GROUNDED: RegExp[] = [
  /\bwhy (?:are you |do you |would you )?(?:interested|excited|applying|keen)\b/i,
  /\bwhy (?:this|our|the) (?:role|position|company|team|job|opportunity)\b/i,
  /\bwhat (?:interests|excites|draws|attracts|appeals to) you\b/i,
  /\btell us about (?:your |a |any )?(?:relevant )?experience\b/i,
  /\bdescribe (?:a|your|how|an? )\b/i,
  /\bhow (?:do|would|have) you (?:approach|handle|deal with|manage|navigate)\b/i,
  /\bwhy (?:do you think )?(?:you|you'?d|you would) (?:be|are|make)\b[^?]{0,40}\b(?:good|great|successful|strong|fit|excel)\b/i,
  /\bwhat (?:makes you|do you bring|can you contribute|would you bring)\b/i,
  /\bcover letter\b/i,
  /\banything else (?:you'?d like|we should know|to add)\b/i,
  /\btell us (?:why|how|about your interest)\b/i,
  /\bwhat (?:are you looking for|motivates you)\b/i,
];

export interface OpenEndedClassification { kind: OpenEndedKind; reason: string }

export function classifyOpenEnded(
  label: string, fieldType?: string, key?: string,
): OpenEndedClassification {
  const t = `${label ?? ""} ${key ?? ""}`.trim();
  if (!t) return { kind: "NOT_OPEN_ENDED", reason: "no question text" };

  // A specific unestablished fact must never be composed. Checked first so a
  // "how many years..." phrased conversationally is not swept into GROUNDED.
  const nf = NEW_FACT.find((r) => r.test(t));
  if (nf) return { kind: "NEW_FACT_REQUIRED", reason: `asks for a specific fact/quantity that is not established (${nf.source.slice(0, 32)}); it must not be invented` };

  if (PERSONALITY.some((r) => r.test(t))) {
    return { kind: "PERSONALITY", reason: "a personality / interests / about-you question, answerable from stored personality facts" };
  }
  if (GROUNDED.some((r) => r.test(t))) {
    return { kind: "GROUNDED_OPEN_ENDED", reason: "a motivation/experience/behavioral question answerable from verified evidence" };
  }
  // A long free-text field that is not a recognised specific-fact question
  // is treated as grounded open-ended; the composer blocks if the evidence
  // cannot actually support an answer.
  if (fieldType === "textarea") {
    return { kind: "GROUNDED_OPEN_ENDED", reason: "a free-text (textarea) question; attempt a grounded answer, block if evidence is insufficient" };
  }
  return { kind: "NOT_OPEN_ENDED", reason: "not recognised as an open-ended question" };
}
