/**
 * Deterministic term to concept normalization.
 *
 * The 1% match rate came from comparing raw extracted phrases against
 * skill names. Postings do not write "pricing"; they write "analytical
 * pricing management" and "pricing strategy and analysis". Those are the
 * same concept wearing three coats.
 *
 * This strips the coats. Everything here is rule-based and inspectable:
 * no similarity scores, no embeddings, no thresholds to tune. A term
 * either reduces to a concept or it does not, and the same input always
 * reduces the same way.
 *
 * What it deliberately does NOT do is guess. "Similar words do not
 * necessarily mean equivalent experience" was the instruction, so
 * stripping happens only for modifiers that carry no capability meaning
 * of their own.
 */

export const CONCEPT_VERSION = 1;

/** Qualifiers describing HOW MUCH, not WHAT. Safe to remove. */
const LEADING_QUALIFIERS = new RegExp(
  "^(?:" + [
    "strong", "solid", "proven", "demonstrated", "demonstrable", "deep", "extensive",
    "significant", "substantial", "excellent", "exceptional", "outstanding", "advanced",
    "expert", "expert-level", "working", "practical", "hands-on", "hands on", "basic",
    "foundational", "familiarity with", "familiar with", "experience with", "experience in",
    "experience", "background in", "background", "knowledge of", "knowledge",
    "understanding of", "understanding", "proficiency in", "proficiency with", "proficiency",
    "proficient in", "proficient with", "proficient", "ability to", "ability",
    "track record of", "track record", "history of", "exposure to", "comfort with",
    "comfortable with", "skilled in", "skilled at", "expertise in", "expertise with",
    "expertise", "fluency in", "fluency", "command of", "mastery of",
  ].join("|") + ")\\s+", "i");

/** Trailing nouns that add nothing to WHAT the capability is. */
const TRAILING_NOUNS = new RegExp(
  "\\s+(?:" + [
    "experience", "experiences", "proficiency", "skills", "skill", "knowledge",
    "expertise", "background", "capability", "capabilities", "competency", "competencies",
    "fundamentals", "principles", "practices", "acumen", "fluency", "literacy",
  ].join("|") + ")$", "i");

/** "5+ years of X", "a minimum of 3 years in X". The years live elsewhere. */
const YEARS_PREFIX =
  /^(?:a\s+)?(?:minimum\s+of\s+)?(?:at\s+least\s+)?\d+\+?\s*(?:-\s*\d+\s*)?(?:years?|yrs?)\s*(?:of|in|with|as)?\s*/i;

export interface ConceptResult {
  concept: string;
  original: string;
  /** Every transformation applied, so a surprising result can be traced. */
  steps: string[];
}

export function toConcept(rawTerm: string): ConceptResult {
  const steps: string[] = [];
  let t = rawTerm.toLowerCase().trim()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ");

  const before = t;
  t = t.replace(YEARS_PREFIX, "");
  if (t !== before) steps.push("stripped years prefix");

  // Applied repeatedly: "strong hands-on experience with X" stacks three.
  for (let i = 0; i < 4; i++) {
    const b = t;
    t = t.replace(LEADING_QUALIFIERS, "");
    if (t === b) break;
    steps.push("stripped leading qualifier");
  }
  for (let i = 0; i < 3; i++) {
    const b = t;
    t = t.replace(TRAILING_NOUNS, "");
    if (t === b) break;
    steps.push("stripped trailing noun");
  }

  // Possessives and articles at the head.
  t = t.replace(/^(?:the|a|an)\s+/i, "").replace(/'s\b/g, "").trim();

  // Parenthetical asides are examples, not the concept.
  const noParens = t.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (noParens && noParens !== t) { t = noParens; steps.push("removed parenthetical"); }

  return { concept: t.replace(/[.,;:]+$/, "").trim(), original: rawTerm, steps };
}

/**
 * Splits a compound requirement into the concepts it actually contains.
 *
 * "Python, SQL and data modeling" is three requirements written as one,
 * and treating it as a single unmatched blob both understates coverage
 * and inflates the penalty. Splitting only happens on clear list
 * separators, never on "and" inside a phrase like "research and
 * development".
 */
export function splitCompound(concept: string): string[] {
  if (concept.length < 8) return [concept];
  // Only split when there is a comma-separated list, or a slash between
  // two short tokens. "A, B and C" splits; "planning and execution" does not.
  if (/,/.test(concept)) {
    const parts = concept.split(/\s*,\s*|\s+and\s+|\s+or\s+/).map((p) => p.trim()).filter((p) => p.length > 1);
    if (parts.length >= 2 && parts.every((p) => p.length <= 40)) return parts;
  }
  const slash = concept.split(/\s*\/\s*/).map((p) => p.trim());
  if (slash.length === 2 && slash.every((p) => p.length > 1 && p.length <= 24)) return slash;
  return [concept];
}
