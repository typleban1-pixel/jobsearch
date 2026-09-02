/**
 * Does the evidence a sentence CITES actually support it?
 *
 * Every other check asks whether a claim is consistent with evidence it
 * was handed. This one asks a narrower and harder question: of the
 * evidence rows this particular sentence names, do they together carry
 * every substantive thing the sentence says. A claim that is true, and
 * whose support sits in a row it does not cite, fails here. That is not
 * pedantry. The citation is what a later reader follows to check the
 * sentence, and a citation that does not reach the support is a citation
 * that cannot be checked.
 *
 * The rewrite guards in grounding.ts compare a sentence to the sentence
 * it replaced, so they say nothing about a master claim, which replaces
 * nothing. This is the check for those.
 *
 * Four outcomes, and the last one is the point of the design. Where a
 * deterministic rule cannot tell a conservative restatement from a
 * widened claim, it says so and stops, rather than picking the answer
 * that keeps the pipeline moving.
 */
import { contentTokens, stem, QUALIFIERS, STEMMED_GENERAL } from "./grounding.ts";

export const PROVENANCE_VERSION = 1;

export type ClaimVerdict =
  /** Every substantive part is carried by the cited evidence. */
  | "SUPPORTED"
  /** True, but the support lives in a verified row the claim does not cite. */
  | "UNDER_PROVENANCED"
  /** Nothing in the profile carries it. */
  | "UNSUPPORTED"
  /** A deterministic rule cannot settle it. A person decides. */
  | "HUMAN_REVIEW";

export interface CitedSource {
  id: string;
  text: string;
  /**
   * The row's individual recorded statements, where it has them.
   *
   * An employment record holds several responsibilities, and a claim
   * rests on one or two of them. Comparing a sentence against the whole
   * row treats every qualifier anywhere in it as a bound on that
   * sentence, which is how seven claims that restate a recorded
   * responsibility word for word were flagged as uncertain: "supported"
   * and "helped" were in different responsibilities, about different
   * work. Where statements are supplied, the comparison is scoped to the
   * ones the claim actually draws on.
   */
  statements?: string[];
}

export interface ClaimAudit {
  verdict: ClaimVerdict;
  /** Substantive words the cited evidence does not carry. */
  uncovered: string[];
  /** Rows that would cover them, if any are verified and uncited. */
  wouldBeCoveredBy: string[];
  /** Bounding words the cited evidence uses and the claim does not. */
  droppedQualifiers: string[];
  /** Why, in words, for a person reading the audit. */
  reason: string;
}

/**
 * Words that carry meaning for this purpose.
 *
 * The general-vocabulary list does the heavy lifting: "team", "project"
 * and "delivery" appear in every resume ever written and prove nothing
 * either way, so demanding a citation for them would classify the whole
 * document as unsupported.
 */
/**
 * English that carries grammar rather than content.
 *
 * The first measurement flagged "set", "run", "basis", "against",
 * "behind", "cover", "personally" and "since" as unsupported concepts.
 * None of them is a claim about anything: they are the connective tissue
 * every sentence needs. Domain words stay out of this list, which is why
 * it holds no nouns that name a field, a tool, a market or a technique.
 */
const FUNCTION_AND_LIGHT = new Set([
  "set", "sets", "run", "runs", "take", "takes", "taking", "taken", "make", "makes", "making",
  "give", "gives", "given", "get", "gets", "keep", "keeps", "put", "use", "uses", "using", "used",
  "provide", "provides", "provided", "providing", "cover", "covers", "covered", "covering",
  "basis", "basi", "against", "behind", "toward", "towards", "along", "around", "between",
  "personally", "person", "directly", "since", "spanning", "span", "same", "several", "many",
  "including", "include", "includes", "included", "within", "without", "outside", "inside",
  "well", "still", "already", "further", "later", "earlier", "often", "always", "never",
  "one", "two", "three", "first", "second", "third", "own", "owns", "owned",
  "help", "helps", "helping", "helped", "let", "lets", "via", "per", "upon", "onto",
  "thing", "things", "way", "ways", "kind", "kinds", "type", "types", "area", "areas",
  "across", "through", "throughout", "during", "before", "after", "about",
  "move", "moves", "moved", "moving", "align", "aligns", "aligned", "aligning",
  "took", "made", "gave", "got", "kept", "went", "came", "brought", "follow", "follows",
  "followed", "following", "then", "next", "also",
  "based", "base", "involve", "involves", "involving", "involved",
]);
const STEMMED_FUNCTION = new Set([...FUNCTION_AND_LIGHT].map(stem));

/**
 * Words that carry meaning for this purpose.
 *
 * The general-vocabulary list does the heavy lifting: "team", "project"
 * and "delivery" appear in every resume ever written and prove nothing
 * either way, so demanding a citation for them would classify the whole
 * document as unsupported. Figures are excluded too: they are checked
 * against the evidence by NO_NEW_NUMBERS, digit for digit, which is a
 * stricter test than this one.
 */
export function substantiveTokens(text: string): string[] {
  return [...new Set(contentTokens(text))]
    .filter((w) => !STEMMED_GENERAL.has(w) && !STEMMED_FUNCTION.has(w) && !/^\d/.test(w));
}

/**
 * Does any cited source use this word, or a form of it?
 *
 * Stemming alone was not enough, and the failures were all morphology
 * rather than meaning: "identifying" against "identify", "refinement"
 * against "refine", "conception" against "concept". Chasing them with
 * more suffix rules is an arms race, so words of six characters or more
 * match on their shared root instead. Shorter words must match exactly,
 * which is what keeps "legal" from being carried by "legacy".
 */
// Five, not six. "refinement" against an evidence stem of "refin" was
// being called unsupported on a two-character difference, which is a
// spelling fact rather than a claim about anything. Five still keeps
// "legal" away from "legacy".
const ROOT_FLOOR = 5;

function sharesRoot(a: string, b: string): boolean {
  if (a === b) return true;
  const floor = Math.min(ROOT_FLOOR, a.length, b.length);
  if (floor < ROOT_FLOOR) return false;
  return a.slice(0, floor) === b.slice(0, floor);
}

const covers = (sources: CitedSource[], token: string) =>
  sources.some((s) => contentTokens(s.text).some((w) => sharesRoot(w, token)));

/**
 * Bounding language the cited evidence uses about the same work.
 *
 * Reported, never decisive on its own. A source that mentions the owner
 * and a small internal team does not oblige every sentence derived from
 * it to say "owner" and "small": the sentence may be about something
 * else entirely in the same row. What it does mean is that a rule cannot
 * settle the question, which is what HUMAN_REVIEW is for.
 */
export function droppedQualifiers(claim: string, sources: CitedSource[]): string[] {
  const evidence = supportingText(claim, sources);
  return QUALIFIERS.filter((q) => {
    const re = new RegExp(`\\b${q}\\b`, "i");
    return re.test(evidence) && !re.test(claim);
  });
}

/**
 * The part of the cited evidence this sentence actually draws on.
 *
 * A statement counts as supporting when the claim shares most of its
 * content with it, which is what a restatement looks like. Where no
 * statement is close enough, or a row records none, the whole row is
 * used and the comparison stays as coarse as it was.
 */
export function supportingText(claim: string, sources: CitedSource[]): string {
  const claimTokens = new Set(contentTokens(claim));
  const matched: string[] = [];
  for (const s of sources) {
    for (const st of s.statements ?? []) {
      const t = contentTokens(st);
      if (!t.length) continue;
      const shared = t.filter((w) => claimTokens.has(w) || [...claimTokens].some((c) => sharesRoot(c, w))).length;
      if (shared / t.length >= 0.6) matched.push(st);
    }
  }
  return matched.length ? matched.join(" ") : sources.map((s) => s.text).join(" ");
}

/**
 * Verbs that describe a position in the work rather than the work.
 *
 * "Coordinated implementation across teams" and "coordinated with the
 * owner and a small internal team" use the same verb about different
 * things, and the difference is the whole claim. Where a claim leads
 * with one of these AND the cited evidence bounds the same activity,
 * nothing deterministic can tell a fair summary from a promotion.
 */
const POSITIONAL_VERBS = /\b(coordinat\w*|manag\w*|led|lead\w*|direct\w*|own\w*|oversaw|oversee\w*|drove|driv\w*|supervis\w*|head\w*)\b/i;

/** Qualifiers whose loss changes who did what, rather than adding colour. */
const SCOPE_BEARING = new Set(["owner", "portions", "some", "small", "assisted", "supported",
  "contributed", "helped", "participated", "a role in", "substantial", "substantially"]);

export interface AuditInput {
  claim: string;
  cited: CitedSource[];
  /** Every verified row in the profile, for telling missing from absent. */
  profile: CitedSource[];
}

/**
 * Audits one employer-facing sentence against the rows it cites.
 *
 * Order matters. A sentence resting on nothing is judged before a
 * sentence resting on the wrong rows, and both before the question of
 * whether a dropped qualifier changed the meaning, because that question
 * is only worth asking about a sentence whose words are accounted for.
 */
export function auditClaim(input: AuditInput): ClaimAudit {
  const { claim, cited, profile } = input;

  if (!cited.length) {
    return { verdict: "UNSUPPORTED", uncovered: [], wouldBeCoveredBy: [], droppedQualifiers: [],
             reason: "the claim cites no evidence at all" };
  }

  const tokens = substantiveTokens(claim);
  const uncovered = tokens.filter((t) => !covers(cited, t));
  const dropped = droppedQualifiers(claim, cited);

  if (uncovered.length) {
    // Uncited rows are consulted only to tell "cited the wrong row" from
    // "the profile does not contain this". They never rescue the claim.
    const citedIds = new Set(cited.map((c) => c.id));
    const rescuers = profile.filter((p) => !citedIds.has(p.id)
      && uncovered.some((t) => contentTokens(p.text).some((w) => sharesRoot(w, t))));

    if (rescuers.length) {
      const stillMissing = uncovered.filter((t) =>
        !rescuers.some((r) => contentTokens(r.text).some((w) => sharesRoot(w, t))));
      return {
        verdict: stillMissing.length ? "UNSUPPORTED" : "UNDER_PROVENANCED",
        uncovered, wouldBeCoveredBy: rescuers.map((r) => r.id),
        droppedQualifiers: dropped,
        reason: stillMissing.length
          ? `${JSON.stringify(stillMissing)} appears nowhere in the profile, and ${JSON.stringify(uncovered.filter((u) => !stillMissing.includes(u)))} sits in rows the claim does not cite`
          : `${JSON.stringify(uncovered)} is carried by ${rescuers.length} verified row(s) the claim does not cite; citing them would settle it`,
      };
    }
    return {
      verdict: "UNSUPPORTED", uncovered, wouldBeCoveredBy: [], droppedQualifiers: dropped,
      reason: `${JSON.stringify(uncovered)} appears in no verified row of the profile`,
    };
  }

  // Every word is accounted for. What remains is whether the sentence
  // says more than the evidence does about who did it.
  const scopeBearing = dropped.filter((q) => SCOPE_BEARING.has(q.replace(/[?()]/g, "").split("|")[0]!));
  if (scopeBearing.length && POSITIONAL_VERBS.test(claim)) {
    return {
      verdict: "HUMAN_REVIEW", uncovered: [], wouldBeCoveredBy: [], droppedQualifiers: dropped,
      reason: `the claim leads with a positional verb and the cited evidence bounds the same work with ${JSON.stringify(scopeBearing)}; `
        + "whether that changes who did what is a judgement, not a rule",
    };
  }

  return {
    verdict: "SUPPORTED", uncovered: [], wouldBeCoveredBy: [], droppedQualifiers: dropped,
    reason: dropped.length
      ? `every substantive word is carried by the cited evidence; ${JSON.stringify(dropped)} is contextual detail in the source rather than a bound on this sentence`
      : "every substantive word is carried by the cited evidence",
  };
}

/** Only SUPPORTED claims may proceed without a person looking. */
export const proceedsAutomatically = (v: ClaimVerdict) => v === "SUPPORTED";
