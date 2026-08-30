import { normalizeTerm } from "../matching/normalize.ts";
import type { ExtractedRequirement } from "./extractRequirements.ts";

/**
 * Did the posting actually say this?
 *
 * The extraction prompt asks for a verbatim quote in raw_text precisely so
 * this check is possible. A requirement whose quote cannot be found in the
 * source is either a paraphrase or an invention, and those look identical
 * in the output but are very different problems.
 *
 * This is a check on OUR pipeline, not a trust exercise. It runs on every
 * extraction, not just the pilot.
 */

export type Grounding = "VERBATIM" | "TERM_ONLY" | "UNGROUNDED";

export interface GroundingResult {
  grounding: Grounding;
  detail: string;
}

export function checkGrounding(
  description: string,
  req: ExtractedRequirement,
  /** The posting's title. Part of the posting, and quotable from. */
  title = "",
): GroundingResult {
  // The title has to be in scope. The bulk run flagged three requirements
  // as ungrounded and all three were quoted from the title rather than
  // the body: "Spanish/Bilingual" and "Night Shift" from
  // "... - El Paso (Spanish/Bilingual)" and "FSQA Supervisor - Night
  // Shift". The model was right and the check was wrong.
  const haystack = normalizeTerm(`${title}\n${description}`);
  const quote = normalizeTerm(req.raw_text);
  const term = normalizeTerm(req.normalized_term);

  if (quote.length >= 4 && haystack.includes(quote)) {
    return { grounding: "VERBATIM", detail: "quote found in posting" };
  }
  // A quote the model lightly reworded still counts as grounded if most
  // of its content words survive in the source.
  const words = quote.split(" ").filter((w) => w.length > 3);
  if (words.length) {
    const present = words.filter((w) => haystack.includes(w)).length;
    if (present / words.length >= 0.8) {
      return { grounding: "VERBATIM", detail: `${present}/${words.length} quote words present` };
    }
  }
  if (term.length >= 3 && haystack.includes(term)) {
    return { grounding: "TERM_ONLY", detail: "term present but quote not found verbatim" };
  }
  return { grounding: "UNGROUNDED", detail: "neither quote nor term found in the posting" };
}

const REQUIREMENT_MARKER =
  /\b(years? of experience|\d\+?\s*years?|required|requirement|must have|must be|you have|you'll need|qualifications?|bachelor|master|degree|certification|licensed?|proficien|experience (?:with|in)|familiarity with|ability to)\b/i;

/**
 * Sentences that read like requirements but that nothing extracted
 * touches. A rough proxy for what the model may have missed: it
 * over-reports (a lot of this text is genuinely not a requirement), so it
 * is a review queue, not a verdict.
 */
export function findUncoveredRequirementSentences(
  description: string, reqs: ExtractedRequirement[],
): string[] {
  const sentences = description
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25 && s.length < 400 && REQUIREMENT_MARKER.test(s));

  const covered = reqs.map((r) => normalizeTerm(r.raw_text)).filter((t) => t.length >= 4);
  const terms = reqs.map((r) => normalizeTerm(r.normalized_term)).filter((t) => t.length >= 3);

  return sentences.filter((s) => {
    const n = normalizeTerm(s);
    if (covered.some((c) => n.includes(c) || c.includes(n))) return false;
    if (terms.some((t) => n.includes(t))) return false;
    return true;
  });
}
