/**
 * Two bullets that say the same thing in different words.
 *
 * The existing check compares normalized text, which catches a bullet
 * repeated verbatim and nothing else. What reached a real resume was
 * this pair, in one role:
 *
 *   Executed marketing, product, ecommerce, creative, and operational
 *   initiatives based on company priorities, moving projects from
 *   conception through implementation.
 *
 *   Execute digital marketing, ecommerce, product ideation, and
 *   operational initiatives aligned with company priorities.
 *
 * Both were grounded, both were true, both came from the same employment
 * record, and a recruiter reading them learns the same thing twice. The
 * wording differs enough that no text comparison would ever pair them.
 *
 * So the comparison is on content words. It is deliberately blunt and
 * deliberately conservative, because the opposite error is worse: two
 * genuinely different accomplishments that happen to cite one employment
 * record must both survive, and a system that quietly deletes one of
 * them is destroying the resume to tidy it.
 */
import type { ResumeLine } from "./resume.ts";

export const REDUNDANCY_VERSION = 1;

/**
 * Function words only.
 *
 * The first version of this list also removed "initiatives",
 * "priorities", "company" and "aligned", on the reasoning that they are
 * vague. That was wrong: vague words are exactly what two restatements
 * of the same responsibility have in common, and stripping them made
 * the real duplicate pair look distinct. What is filtered here is
 * grammar, not weak vocabulary.
 */
const NOISE = new Set([
  "the", "a", "an", "and", "or", "of", "in", "to", "for", "with", "on", "at", "by", "from",
  "as", "that", "this", "which", "into", "through", "across", "including", "while", "when",
  "was", "were", "is", "are", "be", "been", "being", "its", "their", "our",
  "other", "various", "several", "both", "also", "well", "more", "most", "over",
]);

/**
 * Content words, loosely stemmed.
 *
 * "Executed" and "Execute" are the same word for this purpose, and so
 * are "workflow" and "workflows". The stemming is crude on purpose: it
 * only has to bring obvious variants together, and anything cleverer
 * would start merging words that mean different things.
 */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 3) continue;
    let w = raw;
    if (w.length > 5) w = w.replace(/(?:ing|ed|es|s)$/, "");
    else if (w.length > 4) w = w.replace(/s$/, "");
    if (NOISE.has(w) || NOISE.has(raw)) continue;
    out.add(w);
  }
  return out;
}

/**
 * How much of the smaller bullet is contained in the larger.
 *
 * Containment rather than similarity: the failure is one bullet being a
 * shorter restatement of another, and that shows as the short one
 * disappearing inside the long one rather than as the two being equally
 * alike.
 */
export function containment(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (!small.size) return 0;
  let shared = 0;
  for (const w of small) if (large.has(w)) shared++;
  return shared / small.size;
}

export function sharedCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/**
 * The bar for calling two bullets the same bullet.
 *
 * Both conditions have to hold. The ratio alone would pair two short
 * bullets over three shared words; the count alone would pair two long
 * bullets that share some vocabulary and say different things.
 *
 * The numbers come from the documents this went wrong on. The real
 * duplicate pair shares 7 content words, 64% of the shorter bullet. The
 * closest legitimate pair in the same resume, two creative-production
 * bullets both ending "using Adobe Creative Suite", shares 6 words but
 * only 43%, because each says a great deal the other does not. The line
 * sits between them, nearer the second, so the cost of being wrong falls
 * on keeping a repetition rather than on deleting an accomplishment.
 */
export const CONTAINMENT_THRESHOLD = 0.55;
export const MIN_SHARED_WORDS = 5;

export function saysTheSameThing(a: string, b: string): { redundant: boolean; shared: number; ratio: number } {
  const wa = contentWords(a), wb = contentWords(b);
  const shared = sharedCount(wa, wb);
  const ratio = containment(wa, wb);
  return { redundant: shared >= MIN_SHARED_WORDS && ratio >= CONTAINMENT_THRESHOLD, shared, ratio };
}

/**
 * Which of two restatements to keep.
 *
 * The more informative one, measured as distinct content words: between
 * the pair above, the first says everything the second says and adds
 * that projects moved from conception through implementation. Ties go to
 * the earlier bullet, so the outcome does not depend on ordering
 * elsewhere.
 */
function moreInformative(a: ResumeLine, b: ResumeLine): ResumeLine {
  const ca = contentWords(a.text).size, cb = contentWords(b.text).size;
  if (ca !== cb) return ca > cb ? a : b;
  if (a.text.length !== b.text.length) return a.text.length > b.text.length ? a : b;
  return a;
}

export interface RedundancyDrop { line: string; why: string }

/**
 * Collapses restatements within one list of bullets.
 *
 * Scoped to a single role deliberately. Two roles describing similar
 * work are two different periods of a life, and collapsing across them
 * would erase one of them from the record rather than tidy a repetition.
 */
export function collapseRedundant(lines: ResumeLine[]): { lines: ResumeLine[]; dropped: RedundancyDrop[] } {
  const kept: ResumeLine[] = [];
  const dropped: RedundancyDrop[] = [];

  for (const line of lines) {
    let replaced = false;
    for (let i = 0; i < kept.length; i++) {
      const verdict = saysTheSameThing(kept[i]!.text, line.text);
      if (!verdict.redundant) continue;

      const winner = moreInformative(kept[i]!, line);
      const loser = winner === kept[i]! ? line : kept[i]!;
      dropped.push({
        line: loser.text,
        why: `it says the same thing as another bullet in this role, sharing ${verdict.shared} content words `
           + `(${Math.round(verdict.ratio * 100)}% of the shorter one); the fuller wording was kept`,
      });
      kept[i] = winner;
      replaced = true;
      break;
    }
    if (!replaced) kept.push(line);
  }

  return { lines: kept, dropped };
}
