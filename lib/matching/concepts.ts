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
    // Container nouns: a way of packaging a capability, not the
    // capability itself. "ai-assisted development tools" is
    // "ai-assisted development"; "workflow automation software" is
    // "workflow automation". Stripping them can only ever help a term
    // match a verified skill it already names, never invent one.
    "tools", "tool", "tooling", "platforms", "platform", "software",
    "systems", "solutions", "suite", "suites", "applications", "stack",
    // Trailing qualifiers: "X strategy", "X initiatives" are "the
    // <qualifier> for X", where X carries the capability. Stripping them
    // lets the head match a verified capability it already names; it can
    // never invent a match the head does not support. NOTE: "operations"
    // and "management" are deliberately NOT here -- they change the
    // discipline ("revenue operations" is not "revenue"), and composite.ts
    // handles those by requiring every part to be evidenced.
    "strategy", "strategies", "initiatives", "initiative",
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

  // "and/or" is one conjunction, not a slash-separated pair. Left alone
  // it split "workday and/or netsuite partnership" into "workday and"
  // and "or netsuite partnership", neither of which is a concept.
  t = t.replace(/\band\s*\/\s*or\b/gi, "or");

  // Possessives, articles and a dangling conjunction at the head. The
  // extractor sometimes returns a list fragment that still carries the
  // "or" that joined it, and "or netsuite partnership" is not a concept.
  t = t.replace(/^(?:or|and)\s+/i, "").replace(/^(?:the|a|an)\s+/i, "").replace(/'s\b/g, "").trim();

  // Parenthetical asides are examples, not the concept.
  const noParens = t.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (noParens && noParens !== t) { t = noParens; steps.push("removed parenthetical"); }

  return { concept: t.replace(/[.,;:]+$/, "").trim(), original: rawTerm, steps };
}

/**
 * A compound requirement, decomposed into what it actually asks for.
 *
 * The distinction that matters is AND versus OR, and it is not
 * cosmetic. "Python, SQL and data modeling" is three requirements
 * written as one: each is separately wanted, and treating the phrase as
 * a single unmatched blob understates coverage. "Business, Operations,
 * Science, Technology, or Math" is ONE requirement with several
 * acceptable answers: satisfying it once satisfies it, and splitting it
 * into five turns one qualification into five independent wins for
 * whichever branches happen to match, and five independent penalties
 * for the rest.
 *
 * Reading them the same way is how "Degree in Business, ..., Science,
 * ..., or a related field" became six separately credited concepts, one
 * of them labelled "degree in business" for a candidate who satisfies
 * the requirement through its science branch.
 */
export type Decomposition =
  | { kind: "SINGLE"; parts: [string] }
  | { kind: "AND"; parts: string[] }
  | { kind: "OR"; parts: string[] };

/** List items arrive as "or math" when the split lands after the comma. */
function cleanPart(p: string): string {
  return p.trim().replace(/^(?:or|and)\s+/i, "").replace(/^(?:a|an|the)\s+/i, "").trim();
}

const LIST_SPLIT = /\s*,\s*|\s+and\s+|\s+or\s+/;

/**
 * Whether a list is a set of alternatives.
 *
 * Decided from the ORIGINAL requirement text when it is available,
 * because that is where the conjunction actually lives: normalization
 * keeps the words but the raw sentence is what the employer wrote.
 *
 * A bare comma list with no conjunction stays a conjunction. That is the
 * existing behaviour, and it errs toward asking for more rather than
 * inventing qualification the candidate does not have.
 */
function isDisjunction(text: string): boolean {
  return /,\s*or\s+\S/i.test(text) || /\s+or\s+(?:a\s+|an\s+|the\s+)?\S+\s*$/i.test(text);
}

export function decompose(concept: string, rawText?: string): Decomposition {
  if (concept.length < 8) return { kind: "SINGLE", parts: [concept] };

  if (/,/.test(concept)) {
    const parts = concept.split(LIST_SPLIT).map(cleanPart).filter((p) => p.length > 1);
    if (parts.length >= 2 && parts.every((p) => p.length <= 40)) {
      // The raw sentence is the better witness; the normalized term is
      // the fallback when it is not to hand.
      const witness = rawText && rawText.length > 0 ? rawText : concept;
      return isDisjunction(witness) ? { kind: "OR", parts } : { kind: "AND", parts };
    }
  }

  // A bare two-item choice, with no comma to make it a list: "workday or
  // netsuite partnership". Still one requirement with two acceptable
  // answers, and still not two requirements.
  if (concept.length <= 80 && /\s+or\s+/i.test(concept)) {
    const parts = concept.split(/\s+or\s+/i).map(cleanPart).filter((p) => p.length > 1);
    if (parts.length === 2 && parts.every((p) => p.length <= 40)) return { kind: "OR", parts };
  }

  // "planning/execution": two names for adjacent work, both wanted.
  const slash = concept.split(/\s*\/\s*/).map(cleanPart);
  if (slash.length === 2 && slash.every((p) => p.length > 1 && p.length <= 24)) {
    return { kind: "AND", parts: slash };
  }
  return { kind: "SINGLE", parts: [concept] };
}

/**
 * Kept for callers that only want the pieces.
 *
 * Anything that scores must use decompose() instead: this signature
 * cannot say whether the pieces are all required or one of several, and
 * that difference is the whole point.
 */
export function splitCompound(concept: string): string[] {
  return decompose(concept).parts;
}
