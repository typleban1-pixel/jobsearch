/**
 * A date that governs a list must hold for every item in the list.
 *
 * "Experience since 2016 spanning ecommerce and email marketing,
 * physical product development, program and project coordination, and
 * video production" is assembled entirely from true parts. 2016 is in
 * the cited college record; every listed domain appears somewhere across
 * the cited rows. Nothing in the system objected, because nothing asked
 * the only question that matters: does 2016 hold for EACH item?
 *
 * It does not. Video production and coordination begin at the college in
 * 2016; ecommerce, email marketing and physical product development
 * begin at Genius One in 2019. A reader who takes "since 2016" to govern
 * the list -- which is the natural reading -- is told something the
 * evidence does not support.
 *
 * The existing guards cannot see this. auditClaim asks whether the words
 * appear in cited rows and they all do. NO_TEMPORAL_DRIFT compares tense
 * between a rewrite and its original, and this line is statically
 * composed so there is no original. Claim guards match forbidden
 * phrases. None of them models a date SCOPING a list.
 *
 * The rule here is deliberately conservative in one direction only: it
 * asks whether at least one cited row that supports an item was already
 * running at the anchor year. If every row supporting an item begins
 * after the anchor, the claim extends the date over ground the evidence
 * does not cover, and that is refused. Ambiguity about whether "since
 * 2016 spanning X" strictly asserts X since 2016 is resolved the way
 * this project resolves every other ambiguity: if a reader can take it
 * that way and the evidence does not support it, it does not ship.
 */

export const TEMPORAL_SCOPE_VERSION = 1;

export interface DatedSource {
  id: string;
  text: string;
  /** ISO date or null. Null means the row states no start. */
  start: string | null;
  end: string | null;
}

export interface TemporalScopeViolation {
  anchor: string;
  anchorYear: number;
  item: string;
  reason: string;
  earliestSupport: number;
}

/**
 * A date that governs what follows it.
 *
 * Only forms that project BACKWARD to a start are anchors. "In 2021 he
 * did X" dates one event and governs nothing; "since 2016" opens a span
 * that everything after it sits inside.
 */
const ANCHORS: Array<{ re: RegExp; year: (m: RegExpMatchArray) => number }> = [
  { re: /\b(?:since|from)\s+((?:19|20)\d{2})\b/i, year: (m) => Number(m[1]) },
  { re: /\b((?:19|20)\d{2})\s*(?:to|through|[-–—])\s*(?:present|now|today)\b/i, year: (m) => Number(m[1]) },
  { re: /\b(?:over|more than|nearly|almost)\s+(\d{1,2})\+?\s+years?\b/i,
    year: (m) => new Date().getUTCFullYear() - Number(m[1]) },
  { re: /\b(\d{1,2})\+\s+years?\b/i, year: (m) => new Date().getUTCFullYear() - Number(m[1]) },
];

/** Words that carry no subject matter and cannot identify a supporting row. */
const EMPTY = new Set([
  "and", "the", "a", "an", "or", "of", "in", "to", "for", "with", "on", "at", "by", "from",
  "as", "that", "this", "which", "into", "through", "across", "including", "spanning",
  "experience", "work", "working", "years", "year", "various", "several", "both", "other",
  "role", "roles", "position", "positions", "including", "such", "well", "also", "plus",
]);

const words = (s: string) => (s.toLowerCase().match(/[a-z0-9+#.-]+/g) ?? [])
  .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
  .filter((w) => w.length > 3 && !EMPTY.has(w));

/** Crude, shared stem so "coordination" finds "coordinated". */
const stem = (w: string) => w
  .replace(/ies$/, "y")
  .replace(/(?:ations?|ions?|ings?|edly|ed|es|s)$/, "")
  .replace(/e$/, "");

/**
 * Two words count as the same subject if their stems share a root.
 *
 * Prefix comparison rather than equality, because the suffix rules above
 * leave "coordinat" against "coordin" often enough to matter. Five
 * characters is the same floor the provenance auditor uses.
 */
const ROOT = 5;
const sameSubject = (a: string, b: string) => {
  if (a === b) return true;
  const n = Math.min(ROOT, a.length, b.length);
  return n >= ROOT && a.slice(0, n) === b.slice(0, n);
};

/**
 * The items a date governs.
 *
 * Everything after the anchor in the same sentence, split on commas and
 * "and". A fragment with no subject-matter word of its own is discarded
 * rather than guessed at: "and" joining two halves of one item must not
 * become two items.
 */
export function governedItems(claim: string, anchorIndex: number): string[] {
  const sentence = claim.slice(anchorIndex);
  const stop = sentence.search(/[.!?](?:\s|$)/);
  // Every anchor form is stripped, not just the first two. Leaving
  // "over 10 years" in the tail made "over" a subject word of the first
  // item, which no row can match, so the item silently escaped.
  let tail = stop === -1 ? sentence : sentence.slice(0, stop);
  for (const a of ANCHORS) tail = tail.replace(a.re, "");
  tail = tail.replace(/^\W+/, "");
  return tail
    .split(/,|\band\b/i)
    // Leading connectives are not part of the item; they would otherwise
    // appear in the message as "spanning ecommerce".
    .map((x) => x.trim().replace(/^(?:spanning|covering|including|across|in|of|from)\s+/i, "").trim())
    .filter((x) => words(x).length > 0);
}

export function checkTemporalScope(claim: string, cited: DatedSource[]): TemporalScopeViolation[] {
  const out: TemporalScopeViolation[] = [];
  for (const a of ANCHORS) {
    const m = claim.match(a.re);
    if (!m || m.index === undefined) continue;
    const anchorYear = a.year(m);
    const items = governedItems(claim, m.index);
    // A date with nothing after it governs nothing.
    if (items.length < 2) continue;

    for (const item of items) {
      const stems = new Set(words(item).map(stem));
      let earliest: number | null = null;
      for (const src of cited) {
        const srcStems = [...new Set(words(src.text).map(stem))];
        // EVERY subject word of the item has to be in this one row.
        //
        // Matching on any single word let "email marketing" be carried
        // by a college record that says "marketing" in a sentence about
        // community partnerships, and the item's distinguishing word --
        // email -- appears nowhere before 2019. A row supports an item
        // when it covers the item, not when it shares a word with it.
        if (![...stems].every((s) => srcStems.some((t) => sameSubject(s, t)))) continue;
        // A row with no start date cannot bound anything, so it is
        // treated as covering the anchor rather than as a violation.
        if (!src.start) { earliest = anchorYear; break; }
        const y = Number(String(src.start).slice(0, 4));
        if (Number.isFinite(y) && (earliest === null || y < earliest)) earliest = y;
      }
      // An item nothing matches produces no temporal opinion.
      //
      // Lexical matching cannot bridge an irregular verb -- a row saying
      // "Taught" does not match an item saying "teaching" under any
      // stemmer worth having -- so treating "no match" as a violation
      // would refuse true lines. It would also duplicate work: whether
      // an item is supported at all is exactly what auditClaim decides,
      // against the same cited rows, and it decides it better. This
      // check owns one question only, which is whether a date reaches
      // further back than the evidence behind the thing it governs.
      if (earliest !== null && earliest > anchorYear) {
        out.push({ anchor: m[0], anchorYear, item, earliestSupport: earliest,
          reason: `"${m[0]}" covers "${item}", but the earliest cited row supporting it starts in ${earliest}` });
      }
    }
  }
  return out;
}
