/**
 * The ways a resume gets better at screening without getting truer.
 *
 * Everything here is a specific, named failure mode, because a screening
 * evaluator creates pressure in exactly one direction: whatever it
 * rewards, the next draft will contain more of. Left alone, that
 * pressure produces a document that scores well and says things the
 * evidence does not support, which is the outcome this entire system is
 * built to avoid.
 *
 * These checks are additive. The existing grounding guards still decide
 * whether a sentence is supported at all; this decides whether a
 * revision is a REFRAMING or a promotion. A rewrite that survives
 * grounding can still fail here, for the same reason a true sentence can
 * still be a different claim from the one the evidence supports.
 */

export const GAMING_VERSION = 1;

export interface RevisionCandidate {
  /** The line as it stands. */
  before: string;
  /** The line as the revision would have it. */
  after: string;
  /** The posting text, for phrase-copying checks. */
  jobText: string;
}

export interface GamingVerdict {
  ok: boolean;
  /** Every reason it was refused, not just the first. */
  problems: string[];
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);

/**
 * Language that turns taking part into being in charge.
 *
 * Two of these words are only sometimes a claim of authority, and
 * matching them blindly refused sentences that claimed nothing:
 *
 *   "the processes that ran between them"        ran, intransitive
 *   "the migration that ran across three teams"  ran, intransitive
 *   "which led to a shorter review cycle"        led to, a result
 *
 * So they are matched in context instead. "Ran" is a claim of authority
 * when it takes an object introduced by a determiner, as in "ran the
 * program" or "ran a team", and is ordinary English when a preposition
 * follows. "Led" is a claim of authority except in "led to", which
 * describes a consequence and not a person.
 *
 * Everything else on the list is unambiguous and stays unconditional:
 * nobody writes "owned" or "spearheaded" by accident.
 */
const OWNERSHIP_PLAIN = /\b(owned|ownership of|leading|headed|directed|managed|drove|spearheaded|founded|established|architected|oversaw|responsible for the entire)\b/i;
// The trailing boundary matters: without it the alternative "a" matches
// the first letter of "across", and "ran across three teams" is read as
// running something called across.
const RAN_AS_AUTHORITY = /\bran\s+(?:the|a|an|our|its|their|his|her|my|all|both|day[- ]to[- ]day|point)\b/i;
const LED_AS_AUTHORITY = /\bled\b(?!\s+to\b)/i;
const OWNERSHIP_RE = [OWNERSHIP_PLAIN, RAN_AS_AUTHORITY, LED_AS_AUTHORITY];
const OWNERSHIP = { test: (s: string) => OWNERSHIP_RE.some((r) => r.test(s)) };
const COLLABORATION = /\b(supported|assisted|contributed|participated|collaborated|helped|worked with|part of|coordinated with)\b/i;
const SENIORITY = /\b(senior|staff|principal|lead|head of|director|vp|vice president|chief|executive|manager of)\b/i;
const EXPERTISE = /\b(expert|expertise|deep expertise|specialist in|authority on|mastery|extensive experience|highly experienced|seasoned)\b/i;
const CREDENTIAL = /\b(certified|certification|licensed|accredited|credentialed|pmp|cpa|cfa|six sigma|scrum master|aws certified)\b/i;
// Durations count whether they are written as digits or as words: "five
// years" asserts exactly what "5 years" does.
const YEAR_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty";
const YEARS = new RegExp(`\\b(\\d+|${YEAR_WORDS})\\+?\\s*(?:\\+\\s*)?years?\\b`, "i");
// A percentage needs no trailing word boundary: "40%." has none, and
// requiring one is how a metric slips through unnoticed.
const PERCENT = /\b\d[\d,.]*\s*%/;
const NUMBERS = /\b\d[\d,.]*\s*(?:percent|x|k|m|bn|million|billion|hours?|days?|weeks?|months?|clients?|customers?|users?|accounts?|people|reports?)\b/i;

/**
 * The longest run of words the revision took verbatim from the posting.
 *
 * Some overlap is unavoidable and correct: if the posting says "vendor
 * management" and the work was vendor management, the resume should say
 * vendor management. A long exact phrase is different. It is the posting
 * talking, not the candidate, and it is what keyword matching rewards.
 */
export function longestCopiedPhrase(after: string, jobText: string): { length: number; phrase: string } {
  const a = words(after), j = words(jobText);
  if (!a.length || !j.length) return { length: 0, phrase: "" };

  const jobPhrases = new Set<string>();
  for (let n = 4; n <= 12; n++) {
    for (let i = 0; i + n <= j.length; i++) jobPhrases.add(j.slice(i, i + n).join(" "));
  }
  let best = { length: 0, phrase: "" };
  for (let n = 12; n >= 4; n--) {
    for (let i = 0; i + n <= a.length; i++) {
      const p = a.slice(i, i + n).join(" ");
      if (jobPhrases.has(p) && n > best.length) best = { length: n, phrase: p };
    }
    if (best.length) break;
  }
  return best;
}

/** How many words the revision added, and how many of them came from the posting. */
export function keywordDensity(before: string, after: string, jobText: string): { added: number; fromJob: number } {
  const b = new Set(words(before));
  const jobTerms = new Set(words(jobText).filter((w) => w.length > 3));
  const added = words(after).filter((w) => !b.has(w));
  return { added: added.length, fromJob: added.filter((w) => jobTerms.has(w)).length };
}

/** The longest exact phrase a revision may take from the posting. */
export const MAX_COPIED_PHRASE_WORDS = 5;

/**
 * Judges one proposed rewrite.
 *
 * Each check compares AFTER against BEFORE rather than reading AFTER on
 * its own. "Led the migration" is a fine sentence when the evidence says
 * he led it; it is a promotion when the line it replaces said he
 * supported it. The difference between the two drafts is the thing being
 * judged.
 */
export function checkForGaming(c: RevisionCandidate): GamingVerdict {
  const problems: string[] = [];
  const { before, after, jobText } = c;

  const copied = longestCopiedPhrase(after, jobText);
  if (copied.length > MAX_COPIED_PHRASE_WORDS) {
    problems.push(`it copies ${copied.length} consecutive words from the posting (${JSON.stringify(copied.phrase)}), `
      + "which is the posting describing itself rather than the candidate describing their work");
  }

  const density = keywordDensity(before, after, jobText);
  if (density.added >= 4 && density.fromJob / density.added > 0.6) {
    problems.push(`${density.fromJob} of ${density.added} added words come straight from the posting, which reads as keyword stuffing`);
  }

  if (OWNERSHIP.test(after) && !OWNERSHIP.test(before)) {
    problems.push("it introduces ownership or leadership language the earlier line did not have; taking part in something and running it are different claims");
  }
  if (COLLABORATION.test(before) && OWNERSHIP.test(after) && !COLLABORATION.test(after)) {
    problems.push("collaboration became leadership; the evidence describes contributing to the work, not directing it");
  }
  if (SENIORITY.test(after) && !SENIORITY.test(before)) {
    problems.push("it introduces a seniority level the earlier line did not state");
  }
  if (EXPERTISE.test(after) && !EXPERTISE.test(before)) {
    problems.push("it asserts expertise or depth the earlier line did not claim");
  }
  if (CREDENTIAL.test(after) && !CREDENTIAL.test(before)) {
    problems.push("it introduces a credential or certification; those come from the education and credential records, never from a rewrite");
  }

  const yearsBefore = before.match(YEARS), yearsAfter = after.match(YEARS);
  if (yearsAfter && !yearsBefore) {
    problems.push(`it introduces a duration (${yearsAfter[0]}) the earlier line did not state`);
  } else if (yearsAfter && yearsBefore && yearsAfter[1] !== yearsBefore[1]) {
    problems.push(`it changes a duration from ${yearsBefore[0]} to ${yearsAfter[0]}`);
  }

  // Any figure that was not already there. Approved metrics reach the
  // resume through the metrics table, with their approved wording; they
  // are never produced by a rewrite.
  const figuresBefore = (before.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[.,]$/, ""));
  const figuresAfter = (after.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[.,]$/, ""));
  const newFigures = figuresAfter.filter((n) => !figuresBefore.includes(n));
  if (newFigures.length && (NUMBERS.test(after) || PERCENT.test(after))) {
    problems.push(`it introduces ${newFigures.join(", ")}, and a metric that was not already approved cannot appear in a rewrite`);
  }

  return { ok: problems.length === 0, problems };
}

/**
 * The parts of a document a revision may not touch at all.
 *
 * Bullet wording is what tailoring is for. A job title, an employer, a
 * date, a degree: those are records, and no screening finding is a
 * reason to change one.
 */
export interface StructuralComparison {
  beforeTitles: string[]; afterTitles: string[];
  beforeEmployers: string[]; afterEmployers: string[];
  beforeDates: string[]; afterDates: string[];
  beforeEducation: string[]; afterEducation: string[];
}

export function checkStructureUnchanged(s: StructuralComparison): GamingVerdict {
  const problems: string[] = [];
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

  if (!same(s.beforeTitles, s.afterTitles)) {
    problems.push(`a job title changed (${s.beforeTitles.join(" / ")} became ${s.afterTitles.join(" / ")}); titles are records, not wording`);
  }
  if (!same(s.beforeEmployers, s.afterEmployers)) problems.push("an employer changed");
  if (!same(s.beforeDates, s.afterDates)) problems.push("an employment date changed");
  if (!same(s.beforeEducation, s.afterEducation)) {
    problems.push("an education entry changed; credentials come from the education records");
  }
  return { ok: problems.length === 0, problems };
}
