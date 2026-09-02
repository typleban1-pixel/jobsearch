/**
 * Grounding checks for employer-facing prose.
 *
 * This is the boundary between "a model wrote something" and "this may be
 * sent to an employer under his name". The model is a PROPOSER. It never
 * decides whether its own output is safe.
 *
 * The single rule: REFRAME EVIDENCE, NEVER CREATE EVIDENCE. Every check
 * below is a mechanical reading of that rule, and every one compares the
 * claim against the specific evidence rows it cites, not against a
 * blacklist. That distinction matters: "led" is not a forbidden word, it
 * is forbidden when the evidence says "contributed to". The same sentence
 * is fine when the evidence says "led".
 *
 * A claim that fails any check is rejected and RECORDED, never silently
 * dropped and never softened until it passes. A guard that quietly lets
 * things through after enough rewording is not a guard.
 */
import { checkClaims, type GuardViolation } from "./claimGuards.ts";
import { toAmericanEnglish } from "./americanEnglish.ts";

export const GROUNDING_VERSION = 1;

export type CheckName =
  | "CITES_EVIDENCE"
  | "NO_NEW_NUMBERS"
  | "METRICS_VERBATIM"
  | "NO_NEW_ENTITIES"
  | "NO_SCOPE_ESCALATION"
  | "NO_PREDICATE_DRIFT"
  | "NO_INTENSITY_ESCALATION"
  | "NO_UNBACKED_CREDENTIALS"
  | "NO_TARGET_TERMINOLOGY"
  | "NO_ROLE_ESCALATION"
  | "NO_QUALIFIER_LOSS"
  | "NO_TEMPORAL_DRIFT"
  | "NO_STATE_ESCALATION"
  | "CLAIM_GUARDS"
  | "AMERICAN_ENGLISH";

export interface CheckResult { check: CheckName; ok: boolean; detail: string }

export interface GroundingInput {
  /** The proposed employer-facing sentence. */
  claim: string;
  /** Frozen rows it claims to rest on. Empty is an automatic failure. */
  evidenceIds: string[];
  /** The exact text of those rows, concatenated. The claim is judged against this and nothing else. */
  sourceText: string;
  /** Approved metric wordings in play, which must appear verbatim if used at all. */
  approvedMetrics?: string[];
  /** Proper nouns the profile independently establishes: employers, institutions, tools. */
  knownEntities?: string[];
  /**
   * Every word the frozen profile uses, anywhere.
   *
   * Supplied so NO_TARGET_TERMINOLOGY can tell a word the candidate
   * genuinely uses from one the posting supplied. Absent, the check
   * falls back to comparing against the cited rows alone, which is the
   * older and stricter behaviour.
   */
  profileVocabulary?: string;
  /**
   * The implementation state the cited evidence declares, when it
   * declares one.
   *
   * Only project evidence carries this today. CURRENT and NONE impose
   * nothing; anything else fixes the wording. See NO_STATE_ESCALATION.
   */
  implementationState?: string;
  /**
   * The posting this resume is aimed at.
   *
   * Supplied so the guard can tell reframing from importing. Tailoring
   * legitimately chooses WHICH true things to say and how plainly to say
   * them; it may not describe past work in the posting's vocabulary when
   * the evidence does not use that vocabulary, because that changes what
   * the work WAS. Absent, the check is skipped and reported as skipped.
   */
  targetJobText?: string;
  /**
   * The wording this claim replaces, when it replaces one.
   *
   * Three defects are invisible without it, because they are not
   * properties of the sentence at all. Dropping "portions of" is only a
   * lie relative to a sentence that had it; "Coordinated" is only an
   * escalation relative to "Collaborated"; past tense is only wrong if
   * the previous wording was present. The evidence alone cannot show any
   * of that, which is why every one of them passed every check.
   *
   * Absent, those three checks report that they were not applicable. The
   * master resume is not a rewrite of anything, so nothing there changes.
   */
  original?: string;
}

export interface GroundingVerdict {
  ok: boolean;
  checks: CheckResult[];
  /** First failure, which is what a reviewer reads. */
  failedCheck: CheckName | null;
  failureDetail: string | null;
}

// ---------------------------------------------------------------- numbers

/** Digits, spelled-out counts, and durations that carry no numeral. */
const NUMERIC_TOKEN = /\b\d[\d,.]*\s*(?:%|percent|k\b|m\b|million|billion)?/gi;
/**
 * Spelled numbers are numbers. "Supervised thirteen staff members" is the
 * same invention as "13", and a check that only reads digits misses the
 * version a model is more likely to write.
 */
const SPELLED_NUMBER =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dozen)\b/gi;
const DURATION_PHRASE =
  /\b(?:over|nearly|almost|more than|about|approximately|roughly)?\s*(?:a\s+)?(?:decade|half[- ]decade|year|years|month|months)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|several|many|numerous|countless)\s+(?:years?|months?|decades?|projects?|clients?|teams?|people|employees|students?)\b/gi;

function normalizeNumber(s: string): string {
  // Trailing punctuation is not part of the number. "in 2022." at the end
  // of a sentence was not matching "2022" in the evidence, which rejected
  // a line whose figure was right there in its own source.
  return s.toLowerCase().replace(/[,\s]/g, "").replace(/[.]+$/, "").replace(/\.0+$/, "");
}

// ---------------------------------------------------------------- verbs

/**
 * The escalation ladder, by claimed RESPONSIBILITY.
 *
 * Ranks 1 and 2 are free: paraphrasing "produced" as "delivered" changes
 * the wording, not the claim. Ranks 3 and 4 assert authority over people,
 * relationships or the existence of a thing, and must appear in the
 * evidence VERBATIM as a stem. You do not get to be the one who led it
 * because the evidence mentions leading something else.
 *
 * A first version compared maximum ranks across the whole sentence, which
 * was too coarse: the LCCC evidence contains "created motion graphics",
 * and that licensed "Led a collaboration" because 3 is below 4. Rank is
 * checked per verb now, against the evidence's own words.
 */
const FREE_RANK_CEILING = 2;
const VERB_LADDER: Array<[number, RegExp]> = [
  [1, /\b(?:contribut(?:e|ed|es|ing)|support(?:ed|ing|s)?|assist(?:ed|ing|s)?|help(?:ed|ing|s)?|participat(?:e|ed|ing)|collaborat(?:e|ed|es|ing)|work(?:ed|ing|s)?\s+(?:on|with)|involved)\b/gi],
  [2, /\b(?:execut(?:e|ed|es|ing)|deliver(?:ed|ing|s)?|produc(?:e|ed|es|ing)|build|built|design(?:ed|ing|s)?|develop(?:ed|ing|s)?|implement(?:ed|ing|s)?|perform(?:ed|ing|s)?|prepar(?:e|ed|ing)|teach|taught|translat(?:e|ed|ing)|maintain(?:ed|ing|s)?|coordinat(?:e|ed|es|ing)|handl(?:e|ed|es|ing)|ran|run)\b/gi],
  [3, /\b(?:manag(?:e|ed|es|ing)|led|lead(?:s|ing)?|own(?:ed|ing|s)?|direct(?:ed|ing|s)?|head(?:ed|ing|s)?|drove|driv(?:e|es|ing)|spearhead(?:ed|ing|s)?|oversaw|overs(?:ee|eeing|ees)|champion(?:ed|ing|s)?|orchestrat(?:e|ed|ing)|supervis(?:e|ed|es|ing))\b/gi],
  [4, /\b(?:found(?:ed|ing|s)?|establish(?:ed|ing|es)?|launch(?:ed|ing|es)?|originat(?:e|ed|ing)|invent(?:ed|ing|s)?|pioneer(?:ed|ing|s)?|architect(?:ed|ing)|conceiv(?:e|ed|ing)|instituted|creat(?:e|ed|es|ing))\b/gi],
];

/** Stems at or above the ceiling, which the evidence must also contain. */
function responsibilityVerbs(text: string): Array<{ rank: number; verb: string }> {
  const out: Array<{ rank: number; verb: string }> = [];
  for (const [rank, re] of VERB_LADDER) {
    if (rank <= FREE_RANK_CEILING) continue;
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) out.push({ rank, verb: m[0].toLowerCase() });
  }
  return out;
}

/**
 * "supervised" and "supervise" are the same claim.
 *
 * Short verbs keep their whole form: stripping "ed" from "led" leaves
 * "l", which matches nothing and reads as nonsense in a rejection
 * message a person has to act on.
 */
function verbStem(v: string): string {
  const w = v.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 4) return w;
  return w.replace(/(?:ed|ing|es|s)$/, "");
}

/**
 * What the verb was done TO.
 *
 * A verb check alone is not enough. The LCCC evidence says "Managed
 * day-to-day lab operations", which made "Managed cross-department
 * projects" pass: the word "managed" was present, so the claim looked
 * grounded. It was not. The evidence applies "coordinated" to
 * cross-department projects and "managed" to lab operations, and the
 * rewrite swapped which verb governed which object, which is precisely
 * an escalation.
 *
 * So responsibility is checked as a PREDICATE: the verb together with its
 * object. Not a parser, and not trying to be. It takes the words
 * following the verb up to the next clause boundary, drops function
 * words, and asks whether the evidence applies THAT verb to those things.
 *
 * Narrowing is allowed, widening is not. "Managed day-to-day lab
 * operations" may become "managed lab operations" or "managed
 * operations", because every content word is still one the evidence
 * attached to that verb. It may not become "managed projects".
 */
const OBJECT_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "with", "by", "from",
  "across", "over", "into", "that", "which", "this", "these", "those", "its", "their", "his",
  "our", "all", "both", "day", "end", "up", "as", "is", "was", "were", "be", "been", "including",
  "such", "other", "more", "most", "some", "any", "new", "own", "while", "through", "throughout",
]);

/**
 * Where the object ends.
 *
 * Not at every comma, and not at every "and". "college programs,
 * marketing, community partnerships, and outreach" is one list and one
 * object; cutting at the first comma lost most of it and let "Managed
 * community partnerships" pass because the evidence's coordinated-object
 * looked shorter than it was.
 *
 * A new clause starts at sentence punctuation, or at "and" followed by
 * another action. "and outreach" continues a list; "and maintained"
 * starts a new predicate.
 */
const LADDER_VERB_WORD =
  /^(?:contribut|support|assist|help|participat|execut|deliver|produc|build|built|design|develop|implement|perform|prepar|teach|taught|translat|maintain|coordinat|handl|manag|led|lead|own|direct|head|drove|driv|spearhead|oversaw|overs|champion|orchestrat|supervis|found|establish|launch|originat|invent|pioneer|architect|conceiv|institut|creat)/i;

function clauseAfter(text: string): string {
  const sentence = text.split(/[.;:]/)[0] ?? "";
  const words = sentence.split(/\s+/);
  const out: string[] = [];
  for (const [i, w] of words.entries()) {
    if (/^and$/i.test(w.replace(/[^a-z]/gi, "")) && LADDER_VERB_WORD.test(words[i + 1] ?? "")) break;
    out.push(w);
  }
  return out.join(" ");
}

/** The content words a verb governs, from the verb to the next clause boundary. */
function objectWords(text: string, verbIndex: number, verbLength: number): Set<string> {
  const after = text.slice(verbIndex + verbLength);
  const clause = clauseAfter(after);
  const words = clause
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map((w) => w.replace(/-+$/, ""))
    .filter((w) => w.length > 2 && !OBJECT_STOPWORDS.has(w));
  // Singular and plural are the same object.
  return new Set(words.map((w) => (w.length > 4 ? w.replace(/s$/, "") : w)));
}

/** Every (responsibility verb, object) pair a text asserts. */
function predicates(text: string, minRank = FREE_RANK_CEILING + 1): Array<{ stem: string; verb: string; object: Set<string> }> {
  const out: Array<{ stem: string; verb: string; object: Set<string> }> = [];
  for (const [rank, re] of VERB_LADDER) {
    if (rank < minRank) continue;
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      out.push({
        stem: verbStem(m[0]),
        verb: m[0].toLowerCase(),
        object: objectWords(text, m.index ?? 0, m[0].length),
      });
    }
  }
  return out;
}

// ------------------------------------------------------------- intensity

/**
 * Words that assert depth rather than activity.
 *
 * "Expert in Shopify" is a different claim from "Built stores on
 * Shopify", and the profile records skill LEVELS deliberately: a
 * CAPABLE skill is not expertise. Intensity may not exceed the evidence's
 * own intensity, for the same reason a verb may not.
 */
const INTENSITY_MARKER =
  /\b(?:expert|expertise|mastery|mastered|authority|deep\s+(?:knowledge|expertise|experience)|extensive\s+experience|specialist\s+in|seasoned|world[- ]class|best[- ]in[- ]class|renowned|highly\s+skilled|advanced\s+proficiency)\b/gi;

// ----------------------------------------------------------- credentials

/**
 * Vocabulary that asserts a qualification rather than an activity.
 *
 * Doing FDM printing and parametric CAD is verified. "Mechanical
 * engineer" is a professional identity nobody has verified, and the two
 * are one adjective apart in a resume bullet.
 */
const CREDENTIAL_VOCABULARY =
  /\b(?:licensed|certified|accredited|chartered|board[- ]certified|registered|credentialed|qualified\s+(?:as|in)|degree\s+in|majored\s+in|(?:mechanical|electrical|civil|chemical|structural|aerospace|software|clinical|biomedical)\s+engineer(?:ing)?|professional\s+engineer)\b/gi;

// -------------------------------------------------------------- entities

const ENTITY_STOPWORDS = new Set([
  "I", "A", "An", "The", "And", "Or", "But", "For", "With", "At", "In", "On", "To", "Of", "By",
  "Built", "Led", "Managed", "Designed", "Developed", "Created", "Delivered", "Produced",
  "Coordinated", "Supported", "Executed", "Worked", "Taught", "Translated", "Maintained",
  "Contributed", "Coordinating", "Generalist", "Experience", "Senior", "Staff", "Principal",
  "Adobe", "Creative", "Suite", "US", "U.S.", "American", "English",
]);

/** Capitalised tokens that are not sentence-initial and not ordinary words. */
function entitiesIn(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = sentence.trim().split(/\s+/);
    for (const [i, raw] of words.entries()) {
      const w = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.]+$/g, "");
      if (!w || !/^[A-Z]/.test(w)) continue;
      if (i === 0) continue;                       // sentence-initial capital is grammar
      if (ENTITY_STOPWORDS.has(w)) continue;
      if (/^[A-Z]$/.test(w)) continue;
      out.push(w);
    }
  }
  return [...new Set(out)];
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// ------------------------------------------------- posting vocabulary

/**
 * Words too ordinary to carry a domain. Sharing one of these with a
 * posting says nothing at all.
 */
const PHRASE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "to", "for", "with", "on", "at", "by", "from",
  "as", "that", "this", "which", "their", "our", "your", "his", "her", "its", "it", "be",
  "is", "are", "was", "were", "will", "would", "can", "may", "across", "through", "into",
  "including", "such", "other", "more", "than", "over", "under", "within", "while", "when",
  "you", "we", "they", "role", "work", "working", "team", "teams", "experience", "years",
  "who", "whom", "whose", "what", "where", "how", "why", "there", "here", "them", "then",
  "also", "both", "each", "every", "any", "all", "some", "not", "but", "so", "if", "very",
]);

/**
 * One normal form for a word, whatever its inflection.
 *
 * Every false refusal in the first measurement was a normalization
 * failure rather than a judgement failure: "coordinated" in a claim did
 * not match "coordinating" in the evidence, and "deadlines" in a claim
 * did not match "deadline" in the vocabulary list. A rule about words is
 * only as good as its agreement about what a word is.
 */
export const stem = (w: string): string =>
  w.length > 4
    // The trailing "e" matters: the evidence says "Coordinate with the
    // owner" while a claim says "coordinated", and without stripping it
    // those are two different words and the claim reads as unsupported.
    ? w.replace(/ies$/, "y").replace(/(?:ings?|edly|ed|es|s)$/, "").replace(/e$/, "")
    : w;

export const contentTokens = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !PHRASE_STOPWORDS.has(w))
    .map(stem)
    .filter((w) => w.length > 2 && !STEMMED_STOPWORDS.has(w));

/**
 * Words that bound a claim, and whose removal widens it.
 *
 * Deliberately short. Every entry is a word whose only job is to limit
 * what is being claimed, so losing one is never neutral editing.
 */
export const QUALIFIERS = [
  "portions?", "part(?:s)? of", "some", "several", "approximately", "about", "roughly",
  "assisted", "supported", "contributed", "helped", "participated",
  "owner", "small", "multiple", "part[- ]time", "primarily", "occasionally",
  "substantial(?:ly)?", "hands[- ]on role", "a role in", "alongside", "under",
];

/** A sentence that opens in the present, and one that opens in the past. */
const PRESENT_TENSE_LEAD = /^(?:execute|deliver|maintain|contribute|run|manage|coordinate|support|build|design|develop|lead|own|produce|write|handle|teach)\b/i;
const PAST_TENSE_LEAD = /^(?:\w+ed|ran|led|built|taught|wrote|drove|oversaw|made|took|held|began|won|grew|sold)\b/i;

/**
 * General resume and business vocabulary.
 *
 * Sharing one of these with a posting proves nothing: every posting and
 * every resume contains them. They are excluded from the substantive
 * check below so that ordinary reframing does not have to copy the
 * evidence word for word, which is the whole point of reframing.
 */
export const GENERAL_VOCABULARY = new Set([
  "team", "teams", "project", "projects", "work", "working", "worked", "role", "roles",
  "experience", "experienced", "initiative", "initiatives", "priority", "priorities",
  "objective", "objectives", "goal", "goals", "deliver", "delivery", "delivered",
  "planning", "plan", "plans", "execution", "execute", "executed", "process", "processes",
  "stakeholder", "stakeholders", "cross", "functional", "internal", "external",
  "business", "company", "organization", "department", "departments", "partner", "partners",
  "customer", "customers", "client", "clients", "user", "users", "people", "staff",
  "day", "days", "week", "month", "year", "years", "time", "new", "other", "various",
  "support", "supporting", "responsible", "responsibility", "collaboration", "collaborate",
  "communication", "communications", "detail", "details", "quality", "results", "impact",
  "concurrent", "shifting", "deadline", "deadlines", "complex", "fast", "paced",
  "level", "high", "strong", "excellent", "ability", "skills", "knowledge",
  "development", "developing", "manage", "management", "managing",
  "deadline", "deadlines", "part", "parts", "professional", "technical",
  "emerging", "trend", "trends", "industry", "reach", "reached", "reaching", "audience",
  "effort", "efforts", "initiative", "initiatives", "activity", "activities",
  "implement", "implementation", "implemented", "implementing", "solution", "solutions",
]);

/** The same two lists, in the normal form the comparison uses. */
const STEMMED_STOPWORDS = new Set([...PHRASE_STOPWORDS].map(stem));
export const STEMMED_GENERAL = new Set([...GENERAL_VOCABULARY].map(stem));

/**
 * Phrases the claim took from the posting rather than from the evidence.
 *
 * Two content words is the shortest phrase that can name a domain
 * ("legal operations", "revenue operations", "clinical trials"), and a
 * two-word phrase shared with the posting but absent from the evidence
 * is the posting supplying the description. Longer phrases are reported
 * in preference to their own fragments, so the message names the whole
 * thing that was imported.
 */
/**
 * Words and phrases the claim took from the posting rather than from the
 * candidate.
 *
 * `profileText` is the whole frozen profile, and it is what separates
 * IMPORTING from REMEMBERING. The check used to compare only against the
 * rows a claim cites, so any word the candidate has verifiably used
 * elsewhere read as the employer's. Measured on Candidate #3, that
 * refused all three RentPup rewrites over the single word "design",
 * which appears in twenty-one v11 rows -- including the employment
 * record "Design, prototype, test, and refine physical products" -- and
 * in none of the posting's themes. The refusal message asserted the word
 * "appears nowhere in the evidence", which was false.
 *
 * auditClaim already draws this distinction: "appears nowhere in the
 * profile" is fatal, "sits in rows the claim does not cite" is not. This
 * gives the guard the same two-level test.
 *
 * The two levels are deliberately different:
 *
 *   PHRASES  excused only if the same contiguous phrase appears in the
 *            profile. Scattered words do not excuse a phrase, because a
 *            phrase is a formulation and the posting's formulations may
 *            not be borrowed.
 *   WORDS    excused if the word appears anywhere in the profile. A word
 *            the candidate demonstrably uses about their own work is
 *            their vocabulary, wherever it sits.
 *
 * This licenses VOCABULARY and nothing else. Whether the claim may
 * assert the predicate remains the business of NO_SCOPE_ESCALATION,
 * NO_PREDICATE_DRIFT, NO_ROLE_ESCALATION, NO_NEW_ENTITIES,
 * NO_NEW_NUMBERS, NO_UNBACKED_CREDENTIALS and the provenance audit,
 * every one of which still judges the claim against its CITED rows only.
 */
export function importedPhrases(
  claim: string, sourceText: string, jobText: string, profileText = "",
): string[] {
  const claimWords = contentTokens(claim);
  const source = new Set(contentTokens(sourceText));
  const profileWords = contentTokens(profileText);
  const profileVocab = new Set(profileWords);
  const profilePhrases = new Set<string>();
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= profileWords.length; i++) profilePhrases.add(profileWords.slice(i, i + n).join(" "));
  }
  const job = new Set<string>();
  const jobWords = contentTokens(jobText);
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= jobWords.length; i++) job.add(jobWords.slice(i, i + n).join(" "));
  }

  const found: string[] = [];
  for (let n = 4; n >= 2; n--) {
    for (let i = 0; i + n <= claimWords.length; i++) {
      const window = claimWords.slice(i, i + n);
      // Every word of it has to be absent from the evidence. A phrase
      // half of which the evidence already uses is the claim's own.
      if (window.some((w) => source.has(w))) continue;
      const phrase = window.join(" ");
      if (!job.has(phrase)) continue;
      // The candidate has used this exact formulation about their own
      // work, so it is theirs as much as the employer's.
      if (profilePhrases.has(phrase)) continue;
      if (found.some((f) => f.includes(phrase))) continue;
      found.push(phrase);
    }
  }

  // Single substantive words, because a phrase rule is trivially evaded.
  //
  // "Developed pricing strategy and go-to-market initiatives" passed the
  // phrase check for a posting that says "Delivering Pricing,
  // Go-to-Market, or Product recommendations": no two-word window
  // matched, and the cited evidence row contains none of those words in
  // any field. The concept came from the posting, and the phrasing
  // difference is not a defence.
  //
  // Only substantive words count. General resume vocabulary is shared by
  // every posting and every resume, and refusing on it would force the
  // rewrite to copy the evidence word for word.
  const jobSingles = new Set(jobWords.filter((w) => !STEMMED_GENERAL.has(w)));
  for (const w of new Set(claimWords)) {
    if (source.has(w) || STEMMED_GENERAL.has(w)) continue;
    // Established somewhere in the frozen profile: the candidate's own
    // word, not the posting's.
    if (profileVocab.has(w)) continue;
    if (!jobSingles.has(w)) continue;
    if (found.some((f) => f.split(" ").includes(w))) continue;
    found.push(w);
  }
  return found;
}

// ------------------------------------------------------------------ main

export function checkGrounding(input: GroundingInput): GroundingVerdict {
  const { claim, evidenceIds, sourceText } = input;
  const metrics = input.approvedMetrics ?? [];
  const known = input.knownEntities ?? [];
  const checks: CheckResult[] = [];
  const add = (check: CheckName, ok: boolean, detail: string) => checks.push({ check, ok, detail });

  // 1. A claim nobody can trace is not a claim, it is an assertion.
  add("CITES_EVIDENCE", evidenceIds.length > 0 && sourceText.trim().length > 0,
    evidenceIds.length === 0 ? "cites no evidence row" : `cites ${evidenceIds.length} row(s)`);

  const haystack = `${sourceText} ${metrics.join(" ")}`;
  const haystackNums = new Set([
    ...(haystack.match(NUMERIC_TOKEN) ?? []).map(normalizeNumber),
    ...(haystack.match(SPELLED_NUMBER) ?? []).map(normalizeNumber),
  ]);
  const haystackDurations = new Set((haystack.match(DURATION_PHRASE) ?? []).map((s) => s.toLowerCase().trim()));

  // 2. Every number must already exist in the evidence. This is what stops
  //    "grew the team" becoming "grew the team by 40%".
  const claimNums = [
    ...(claim.match(NUMERIC_TOKEN) ?? []).map(normalizeNumber),
    ...(claim.match(SPELLED_NUMBER) ?? []).map(normalizeNumber),
  ];
  const inventedNums = claimNums.filter((n) => !haystackNums.has(n));
  const claimDurations = (claim.match(DURATION_PHRASE) ?? []).map((s) => s.toLowerCase().trim());
  const inventedDurations = claimDurations.filter((d) => !haystackDurations.has(d));
  add("NO_NEW_NUMBERS", inventedNums.length === 0 && inventedDurations.length === 0,
    inventedNums.length || inventedDurations.length
      ? `not in the evidence: ${[...inventedNums, ...inventedDurations].join(", ")}`
      : "every figure appears in the cited evidence");

  // 3. An approved metric's wording was negotiated once. Tailoring chooses
  //    whether to use it, never how it reads.
  // A metric is recognised by a figure that is DISTINCTIVE to it: one the
  // cited evidence does not itself contain. Without that qualifier the
  // check fires on the evidence's own words, because "Supervised three
  // staff members" shares "three" with the approved metric about three
  // student employees. Restating the evidence is not altering a metric.
  const sourceFigures = new Set([
    ...(sourceText.match(NUMERIC_TOKEN) ?? []),
    ...(sourceText.match(SPELLED_NUMBER) ?? []),
  ].map(normalizeNumber));
  const claimFigures = new Set([
    ...(claim.match(NUMERIC_TOKEN) ?? []),
    ...(claim.match(SPELLED_NUMBER) ?? []),
  ].map(normalizeNumber));
  const metricTouched = metrics.filter((m) => {
    const distinctive = [
      ...(m.match(NUMERIC_TOKEN) ?? []),
      ...(m.match(SPELLED_NUMBER) ?? []),
    ].map(normalizeNumber).filter((f) => f.length >= 2 && !sourceFigures.has(f));
    return distinctive.some((f) => claimFigures.has(f));
  });
  const metricAltered = metricTouched.filter((m) => !claim.includes(m.trim().replace(/\.$/, "")));
  add("METRICS_VERBATIM", metricAltered.length === 0,
    metricAltered.length ? `approved wording altered: "${metricAltered[0]!.slice(0, 70)}"` : "approved metrics unaltered or unused");

  // 4. No employer, client, institution or tool the evidence does not name.
  // Every word of the evidence and of the known-entity list, including
  // the halves of "CAD/Onshape" and "Genius One", so a legitimate claim
  // is not rejected for splitting a token the evidence joined.
  const allowed = new Set<string>();
  const addTokens = (text: string) => {
    for (const w of text.split(/[\s/,;()–—-]+/)) if (w) allowed.add(squash(w));
  };
  addTokens(sourceText);
  for (const k of known) { allowed.add(squash(k)); addTokens(k); }
  for (const e of entitiesIn(sourceText)) allowed.add(squash(e));
  // "AI-assisted" and "AI assisted" are the same entity. The allowance
  // list splits hyphens, so the claim side must too, or a legitimate
  // compound is reported as an invention.
  const newEntities = entitiesIn(claim).filter((e) => {
    if (allowed.has(squash(e))) return false;
    const parts = e.split(/[-–—/]/).map(squash).filter(Boolean);
    return !(parts.length > 1 && parts.every((p) => allowed.has(p)));
  });
  add("NO_NEW_ENTITIES", newEntities.length === 0,
    newEntities.length ? `not named in the evidence: ${newEntities.join(", ")}` : "names only entities the evidence names");

  // 5. A claim of authority must be a claim the evidence itself makes.
  const sourceResponsibility = responsibilityVerbs(sourceText);
  const sourceStems = new Set(sourceResponsibility.map((v) => verbStem(v.verb)));
  const sourceVerbWords = new Set(sourceResponsibility.map((v) => v.verb));
  const unsupportedVerbs = responsibilityVerbs(claim)
    .filter((v) => !sourceStems.has(verbStem(v.verb)))
    .map((v) => v.verb);
  add("NO_SCOPE_ESCALATION", unsupportedVerbs.length === 0,
    unsupportedVerbs.length
      ? `"${unsupportedVerbs[0]}" claims authority the evidence does not: the evidence says ${sourceVerbWords.size ? [...sourceVerbWords].map((s) => `"${s}"`).join(", ") : "no such thing"}`
      : "claims no authority beyond the evidence");

  // 5b. And it must be the same thing the evidence claims authority over.
  //
  // An approved metric is verified, employer-safe wording by definition,
  // so it counts as evidence here exactly as it does for figures.
  const scopeSource = `${sourceText} ${metrics.join(" ")}`;
  const sourcePredicates = predicates(scopeSource);
  // Every rank, because the point is to notice when an object the
  // evidence gave to a LOWER verb gets promoted to a higher one.
  const allSourcePredicates = predicates(scopeSource, 1);
  const scopeWords = new Set(
    scopeSource.toLowerCase().split(/[^a-z0-9-]+/)
      .map((w) => (w.length > 4 ? w.replace(/s$/, "") : w)).filter(Boolean),
  );
  const drifted: string[] = [];
  for (const p of predicates(claim)) {
    if (!sourceStems.has(p.stem)) continue;          // already caught by check 5
    if (p.object.size === 0) continue;               // no object stated, nothing to widen
    const supported = new Set<string>();
    for (const sp of sourcePredicates) {
      if (sp.stem !== p.stem) continue;
      for (const w of sp.object) supported.add(w);
    }
    // A word is DRIFT when the evidence hands it to a different verb:
    // that is responsibility being re-attached, which is the escalation.
    // A word the evidence merely mentions, such as the platform the work
    // ran on, is not: naming it does not enlarge what was managed.
    const added = [...p.object].filter((w) => !supported.has(w));
    const reattached = added.filter((w) =>
      allSourcePredicates.some((sp) => sp.stem !== p.stem && sp.object.has(w)));
    const foreign = added.filter((w) => !scopeWords.has(w));
    if (reattached.length > 0 || foreign.length > 0) {
      const why = reattached.length
        ? `the evidence gives "${reattached[0]}" to a different action`
        : `"${foreign[0]}" appears nowhere in the evidence`;
      drifted.push(`"${p.verb} ${[...p.object].join(" ")}": ${why}`);
    }
  }
  add("NO_PREDICATE_DRIFT", drifted.length === 0,
    drifted.length ? `the verb is supported but its object is not: ${drifted[0]}` : "authority is claimed over what the evidence says it was claimed over");

  // 6. Nor may claimed depth.
  INTENSITY_MARKER.lastIndex = 0;
  const claimIntensity = claim.match(INTENSITY_MARKER) ?? [];
  INTENSITY_MARKER.lastIndex = 0;
  const sourceIntensity = new Set((sourceText.match(INTENSITY_MARKER) ?? []).map((s) => s.toLowerCase()));
  const newIntensity = claimIntensity.filter((m) => !sourceIntensity.has(m.toLowerCase()));
  add("NO_INTENSITY_ESCALATION", newIntensity.length === 0,
    newIntensity.length ? `asserts depth the evidence does not: ${newIntensity.join(", ")}` : "claims no depth beyond the evidence");

  // 7. Doing the work is not holding the qualification.
  CREDENTIAL_VOCABULARY.lastIndex = 0;
  const claimCreds = claim.match(CREDENTIAL_VOCABULARY) ?? [];
  CREDENTIAL_VOCABULARY.lastIndex = 0;
  const sourceCreds = new Set((sourceText.match(CREDENTIAL_VOCABULARY) ?? []).map((s) => s.toLowerCase()));
  const newCreds = claimCreds.filter((c) => !sourceCreds.has(c.toLowerCase()));
  add("NO_UNBACKED_CREDENTIALS", newCreds.length === 0,
    newCreds.length ? `asserts a qualification the evidence does not: ${newCreds.join(", ")}` : "asserts no unbacked qualification");

  // 7b. Describing the past in the posting's words.
  //
  // The defect: evidence saying "taught and mentored 250+ students"
  // became "mentored over 250 students in technical concepts and
  // professional workflows applicable to legal operations" for a legal
  // operations posting. Every earlier check passed. The numbers were
  // right, the verb was supported, no proper noun appeared, and the
  // added words were lower case so nothing read them as entities. The
  // object of a non-authority verb was simply never constrained, and so
  // a qualifier could be appended freely.
  //
  // What makes that sentence wrong is not that it is vague, it is that
  // "legal operations" came from the JOB. The workflows he taught were
  // whatever they were; calling them legal operations workflows makes a
  // claim about history that only the posting supports.
  //
  // The rule is narrow on purpose. A single shared word proves nothing:
  // postings and resumes both say "operations". A phrase of two or more
  // content words that appears in the posting, and nowhere in the
  // evidence, is the posting talking about the candidate's past.
  // The wording being replaced counts as already-said, because it is
  // itself verified against this evidence. The question is what the
  // REWRITE introduces, not what the resume already contained.
  const alreadySaid = `${sourceText} ${input.original ?? ""}`;
  const imported = input.targetJobText
    ? importedPhrases(claim, alreadySaid, `${input.targetJobText} ${metrics.join(" ")}`, input.profileVocabulary ?? "")
    : [];
  add("NO_TARGET_TERMINOLOGY", imported.length === 0,
    !input.targetJobText
      ? "no target posting supplied, so nothing was compared"
      : imported.length
        ? `"${imported[0]}" comes from the posting and appears nowhere in the profile; the posting's words cannot describe past work`
        : "describes the work in the evidence's own terms");

  // 7c. A verb that claims more of the work than the last wording did.
  //
  // "Collaborated cross-functionally with marketing" became "Coordinated
  // across marketing", and every check passed: coordinate sits at rank 2,
  // which is free, so the evidence never had to contain it. Free is the
  // right rank for a synonym swap and the wrong one for a promotion, and
  // the difference only exists relative to what the line said before.
  // The rank of the verb the sentence LEADS with, not the highest rank
  // anywhere in it.
  //
  // Taking the maximum hid the defect it was written for: "Collaborated
  // cross-functionally ... and run projects" contains "run" at rank 2,
  // so rewriting the leading verb from "Collaborated" (1) to
  // "Coordinated" (2) was not an increase by that measure. The leading
  // verb is the one the claim is about.
  const leadRank = (text: string) => {
    let bestPos = Infinity, bestRank = 0;
    for (const [rank, re] of VERB_LADDER) {
      re.lastIndex = 0;
      const m = re.exec(text);
      re.lastIndex = 0;
      if (m && m.index < bestPos) { bestPos = m.index; bestRank = rank; }
    }
    return bestRank;
  };
  const escalatedVerbs: string[] = [];
  if (input.original) {
    const originalRank = leadRank(input.original);
    const sourceWords = new Set(scopeSource.toLowerCase().split(/[^a-z0-9]+/));
    const claimLead = leadRank(claim);
    for (const [rank, re] of VERB_LADDER) {
      if (rank <= originalRank || rank !== claimLead) continue;
      re.lastIndex = 0;
      for (const m of claim.matchAll(re)) {
        const verb = m[0].toLowerCase();
        // The evidence may still license it: a promotion the evidence
        // states in its own words is a promotion the resume may print.
        const stem = verbStem(verb);
        if ([...sourceWords].some((w) => verbStem(w) === stem)) continue;
        escalatedVerbs.push(verb);
      }
      re.lastIndex = 0;
    }
  }
  add("NO_ROLE_ESCALATION", escalatedVerbs.length === 0,
    !input.original
      ? "no earlier wording supplied, so nothing was compared"
      : escalatedVerbs.length
        ? `"${escalatedVerbs[0]}" claims more of the work than the wording it replaces, and the evidence does not use that word`
        : "claims no more of the work than the wording it replaces");

  // 7d. Language that bounds a claim, quietly removed.
  //
  // "Personally edited portions of the show" and "Edited the show" are
  // different claims, and the second is the first with one word taken
  // out. The same manoeuvre removed "the owner" from a coordination
  // claim and "multiple brands" from a breadth claim. Only bounding
  // words are checked: dropping an ordinary adjective is editing.
  const droppedQualifiers = input.original
    ? QUALIFIERS.filter((q) => {
        const re = new RegExp(`\\b${q}\\b`, "i");
        return re.test(input.original!) && !re.test(claim);
      })
    : [];
  add("NO_QUALIFIER_LOSS", droppedQualifiers.length === 0,
    !input.original
      ? "no earlier wording supplied, so nothing was compared"
      : droppedQualifiers.length
        ? `"${droppedQualifiers[0]}" bounded the earlier wording and is gone, which widens the claim`
        : "every bounding word survived");

  // 7d-bis. Work that is paused, partial or conditional, described as
  // though it were running.
  //
  // "RentPup has a filing-assistance workflow built end to end ... The
  // customer-facing request path was deliberately switched off in August
  // 2026 pending legal review" is a true and creditable thing to have
  // built. "Built an end-to-end filing-assistance workflow" is also
  // true, reads as a live service, and is what a rewrite produces every
  // time. The pause is a whole clause rather than one of the bounding
  // words NO_QUALIFIER_LOSS knows about, so that check does not see it
  // go.
  //
  // The rule is therefore absolute rather than clever: evidence that
  // declares itself anything other than CURRENT may be stated in its own
  // words or not at all. There is no judgement in it to get wrong, and
  // an unstated claim fails rather than passes.
  const state = input.implementationState ?? "";
  const fixedWording = state !== "" && state !== "CURRENT" && state !== "NONE";
  const verbatim = !fixedWording || !input.original || claim.trim() === input.original.trim();
  add("NO_STATE_ESCALATION", verbatim,
    !fixedWording
      ? "the cited evidence declares no limiting implementation state"
      : verbatim
        ? `the evidence is ${state} and the wording is unchanged from it`
        : `the evidence is ${state}, so its own wording is the only wording allowed; a rewrite drops the limitation that makes it honest`);

  // 7e. Work that is still happening, described as finished.
  const wasPresent = input.original ? PRESENT_TENSE_LEAD.test(input.original.trim()) : false;
  const nowPast = PAST_TENSE_LEAD.test(claim.trim());
  add("NO_TEMPORAL_DRIFT", !(wasPresent && nowPast),
    !input.original
      ? "no earlier wording supplied, so nothing was compared"
      : wasPresent && nowPast
        ? "the earlier wording is present tense and this is past tense; a current role described in the past reads as finished"
        : "tense is unchanged");

  // 8. The standing prohibitions, which outrank any evidence.
  const violations: GuardViolation[] = checkClaims(claim);
  add("CLAIM_GUARDS", violations.length === 0,
    violations.length ? `[${violations[0]!.subject}] "${violations[0]!.matched}": ${violations[0]!.reason.slice(0, 90)}` : "no forbidden claim");

  // 9. Rendering rules, applied to the sentence that would be sent.
  const normalized = toAmericanEnglish(claim, { protect: known });
  add("AMERICAN_ENGLISH", normalized.text === claim && !claim.includes("—"),
    normalized.text === claim ? "already American English, no em dash" : `would be rewritten: ${normalized.changes.slice(0, 2).map((c) => `${c.from} -> ${c.to}`).join(", ")}`);

  const failed = checks.find((c) => !c.ok) ?? null;
  return {
    ok: failed === null,
    checks,
    failedCheck: failed?.check ?? null,
    failureDetail: failed?.detail ?? null,
  };
}
