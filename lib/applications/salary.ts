/**
 * What to ask for, on this application, for this job.
 *
 * Salary expectation is the one answer on a form that is neither a fact
 * about the person nor a fact about the posting. It is a judgement made
 * against a market, and it is different for every job, which is why it
 * is computed here and never stored as an approved answer. Nothing in
 * this file may reach question_bank: a number that was right for a
 * Chicago analyst role is not a fact, and reusing it on the next
 * application is the exact mistake this replaces.
 *
 * The market reference is the job corpus itself. 1,434 current postings
 * carry a salary range the employer published, none of them estimated,
 * and comparable postings are a better evidence base than a guess about
 * national averages. Where the corpus cannot supply enough comparable
 * postings, this blocks rather than inventing a number.
 *
 * Two failure modes are guarded explicitly because both are expensive
 * and neither announces itself. Answering low to seem agreeable sets the
 * ceiling for the whole negotiation, so the floor is never the automatic
 * answer. Answering high without support gets the application filtered
 * out, so a published range is never exceeded without a stated reason.
 * And the midpoint of a range is not a recommendation, it is an absence
 * of one: position within the band is earned by measured qualification.
 */

export const SALARY_ENGINE_VERSION = 1;

/** One comparable posting, as the engine needs it. */
export interface Comparable {
  jobId: string;
  title: string;
  metro: string | null;
  state: string | null;
  min: number | null;
  max: number | null;
  seniority: string | null;
}

/** What the person will not go below, and what they are aiming at. */
export interface CompensationPreferences {
  hardFloor: number | null;
  targetMin: number | null;
  targetIdeal: number | null;
}

/** What the posting itself says about pay and shape. */
export interface PostingPay {
  publishedMin: number | null;
  publishedMax: number | null;
  isEstimated: boolean;
  mentionsEquity: boolean;
  hasQuotaOrCommission: boolean | null;
  metro: string | null;
  state: string | null;
  remotePolicy: string | null;
  seniority: string | null;
  managesPeople: boolean | null;
  title: string;
}

/** How well the person actually matches what the posting asks for. */
export interface QualificationSignal {
  candidacyVerdict: string;
  hardMet: number;
  hardTotal: number;
  directMatches: number;
  transferableMatches: number;
  /** Where this job's Fit sits in the scored corpus, 0..1. */
  fitPercentile: number | null;
}

/** What the form is actually asking for. */
export type AskShape = "SINGLE_NUMBER" | "RANGE" | "TEXT" | "MINIMUM" | "TOTAL_COMPENSATION";

export interface SalaryRecommendation {
  /** Null when this must go to a person instead. */
  answer: string | null;
  shape: AskShape;
  /** Base salary only, unless the question asked for total compensation. */
  low: number | null;
  high: number | null;
  point: number | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  requiresHumanReview: boolean;
  blocked: string | null;
  reasoning: string[];
  inputsUsed: string[];
  uncertainty: string[];
}

/**
 * What the question is asking for, from its own words.
 *
 * The shape changes the answer, not just its formatting: "minimum
 * acceptable" is a floor and "expectation" is a target, and answering
 * one with the other either underprices the person or reads as a refusal
 * to engage with the question.
 */
export function askShape(question: string, hasOptions: boolean): AskShape {
  const q = question.toLowerCase();
  if (/\b(?:minimum|lowest|least)\b/.test(q)) return "MINIMUM";

  // "not including bonus" contains "including bonus", and reading it as a
  // request for total compensation inverts the question: the employer
  // asked for base and would have been answered with a package. The
  // exclusion is checked first and wins.
  const excludesVariable = /\b(?:not|excluding|excludes|without|before|less)\s+(?:including\s+)?(?:any\s+)?(?:bonus|commission|equity|variable)/.test(q)
    || /\bbase (?:salary|pay|compensation)\b/.test(q);
  if (!excludesVariable
    && /\btotal (?:comp|compensation|package)\b|\bincluding bonus\b|\bon.target earnings\b|\bote\b/.test(q)) {
    return "TOTAL_COMPENSATION";
  }
  if (/\brange\b/.test(q)) return "RANGE";
  if (hasOptions) return "SINGLE_NUMBER";
  return "TEXT";
}

/**
 * Roughly how senior a title is, for deciding what compares with what.
 *
 * Crude on purpose, and used only to keep unlike things out of a band.
 * A "Director of Strategy & Analytics" at $147k-$203k shares the word
 * "strategy" with "Menu Strategy Analyst" and pays for a different job;
 * one of them in a set of eight moved the 75th percentile by forty
 * thousand dollars. Comparing a role only against its own level is what
 * stops a token match from becoming a pay claim.
 */
export type TitleLevel = "EXECUTIVE" | "MANAGER" | "SENIOR" | "BASE";

export function titleLevel(title: string): TitleLevel {
  const t = ` ${String(title).toLowerCase().replace(/[^a-z0-9 ]+/g, " ")} `;
  if (/\b(?:chief|cxo|ceo|cto|coo|cfo|cmo|vp|vice president|svp|evp|head of|director|dir)\b/.test(t)) return "EXECUTIVE";
  if (/\b(?:manager|mgr|supervisor|principal|staff|lead)\b/.test(t)) return "MANAGER";
  if (/\b(?:senior|sr|iii|iv)\b/.test(t)) return "SENIOR";
  return "BASE";
}

const percentile = (sorted: number[], p: number): number => {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
};

const round = (n: number): number => Math.round(n / 1000) * 1000;
const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;

/**
 * How far up the band this application has earned.
 *
 * Deliberately not a midpoint. The band describes what the market pays
 * for the role; where inside it a particular candidate sits is a claim
 * about that candidate, and it is built from the same measured signals
 * that decided candidacy rather than from optimism. The result is capped
 * well short of the top: nothing in this profile establishes that he is
 * the strongest applicant a posting will see.
 */
export function bandPosition(q: QualificationSignal): { position: number; because: string[] } {
  const because: string[] = [];
  // A candidate meeting most hard requirements starts below the middle.
  // The band's upper half is for people the posting is clearly aimed at.
  let position = 0.30;
  because.push("starts at 0.30 of the band: meeting the requirements earns the market rate, not a premium");

  const ratio = q.hardTotal > 0 ? q.hardMet / q.hardTotal : 0;
  const fromHard = (ratio - 0.5) * 0.30;
  position += fromHard;
  because.push(`${q.hardMet} of ${q.hardTotal} hard requirements met (${(ratio * 100).toFixed(0)}%), ${fromHard >= 0 ? "+" : ""}${fromHard.toFixed(2)}`);

  const fromDirect = Math.min(q.directMatches, 4) * 0.03;
  position += fromDirect;
  because.push(`${q.directMatches} direct evidence matches, +${fromDirect.toFixed(2)}`);

  if (q.fitPercentile !== null) {
    const fromFit = (q.fitPercentile - 0.5) * 0.12;
    position += fromFit;
    because.push(`Fit sits at the ${(q.fitPercentile * 100).toFixed(0)}th percentile of the scored corpus, ${fromFit >= 0 ? "+" : ""}${fromFit.toFixed(2)}`);
  }

  if (q.candidacyVerdict === "STRETCH") {
    position -= 0.08;
    because.push("candidacy is STRETCH rather than a clear match, -0.08");
  }

  const clamped = Math.max(0.15, Math.min(0.70, position));
  if (clamped !== position) because.push(`clamped to ${clamped.toFixed(2)}: the band's extremes are not claims this evidence supports`);
  return { position: clamped, because };
}

export interface RecommendInput {
  question: string;
  hasOptions: boolean;
  posting: PostingPay;
  comparables: Comparable[];
  preferences: CompensationPreferences;
  qualification: QualificationSignal;
  /** How the comparable set was chosen, for the audit trail. */
  comparableBasis: string;
}

/** The minimum comparable postings before a band means anything. */
export const MIN_COMPARABLES = 8;
/** Above this spread the comparables are not describing one job. */
export const MAX_RELATIVE_SPREAD = 0.75;

export function recommendSalary(input: RecommendInput): SalaryRecommendation {
  const { posting, comparables, preferences, qualification } = input;
  const shape = askShape(input.question, input.hasOptions);
  const reasoning: string[] = [];
  const inputsUsed: string[] = [];
  const uncertainty: string[] = [];

  const base = (): SalaryRecommendation => ({
    answer: null, shape, low: null, high: null, point: null,
    confidence: "LOW", requiresHumanReview: true, blocked: null,
    reasoning, inputsUsed, uncertainty,
  });

  // 1. A published range is the strongest evidence there is, because the
  //    employer is telling you what they will pay.
  if (posting.publishedMin || posting.publishedMax) {
    const lo = posting.publishedMin ?? posting.publishedMax!;
    const hi = posting.publishedMax ?? posting.publishedMin!;
    inputsUsed.push(`the employer's published range ${usd(lo)} to ${usd(hi)}${posting.isEstimated ? " (marked estimated)" : ""}`);
    const { position, because } = bandPosition(qualification);
    reasoning.push(...because);
    const point = round(lo + (hi - lo) * position);
    reasoning.push(`${(position * 100).toFixed(0)}% into the published range gives ${usd(point)}, not the midpoint`);

    if (preferences.hardFloor && point < preferences.hardFloor) {
      if (hi < preferences.hardFloor) {
        return { ...base(), blocked:
          `the whole published range tops out at ${usd(hi)}, below the ${usd(preferences.hardFloor)} floor. `
          + "Asking inside it would commit to less than the stated minimum, and asking above it needs a reason this system does not have." };
      }
      reasoning.push(`raised to the ${usd(preferences.hardFloor)} floor, which the range does reach`);
      return finish(preferences.hardFloor, lo, hi, "MEDIUM");
    }
    return finish(point, lo, hi, "HIGH");

    function finish(p: number, rangeLo: number, rangeHi: number, conf: "HIGH" | "MEDIUM"): SalaryRecommendation {
      const spread = Math.max(3000, Math.round((rangeHi - rangeLo) * 0.12));
      return {
        answer: shape === "MINIMUM" ? usd(p)
          : shape === "RANGE" ? `${usd(round(p - spread))} to ${usd(round(p + spread))}`
          : usd(p),
        shape, low: round(p - spread), high: round(p + spread), point: p,
        confidence: posting.isEstimated ? "MEDIUM" : conf,
        requiresHumanReview: true, blocked: null, reasoning, inputsUsed, uncertainty,
      };
    }
  }

  // 2. No published range. Build one from comparable postings that do
  //    publish, and refuse if there are not enough of them.
  inputsUsed.push(`${comparables.length} comparable postings with employer-published ranges (${input.comparableBasis})`);
  if (comparables.length < MIN_COMPARABLES) {
    return { ...base(), blocked:
      `only ${comparables.length} comparable postings publish a range, below the ${MIN_COMPARABLES} needed for a band to mean anything. `
      + "A number from this little evidence would be a guess presented as a recommendation." };
  }

  const raw = comparables
    .map((c) => (c.min && c.max ? (c.min + c.max) / 2 : c.min ?? c.max ?? NaN))
    .filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

  // One extreme posting must not set the band. A $350,000 commission
  // role in a set of nineteen moved the 75th percentile by forty
  // thousand dollars, which is the whole recommendation. Values beyond
  // 1.5 interquartile ranges are dropped and reported, never silently.
  const q1 = percentile(raw, 0.25), q3 = percentile(raw, 0.75);
  const fence = 1.5 * (q3 - q1);
  const mids = raw.filter((n) => n >= q1 - fence && n <= q3 + fence);
  const trimmed = raw.length - mids.length;
  if (trimmed > 0) {
    reasoning.push(`${trimmed} outlying posting${trimmed === 1 ? "" : "s"} dropped as more than 1.5 interquartile ranges from the middle`);
  }
  if (mids.length < MIN_COMPARABLES) {
    return { ...base(), blocked:
      `after dropping ${trimmed} outlier${trimmed === 1 ? "" : "s"}, only ${mids.length} comparable postings remain, `
      + `below the ${MIN_COMPARABLES} needed. The set was not describing one market.` };
  }

  const p25 = percentile(mids, 0.25), p50 = percentile(mids, 0.5), p75 = percentile(mids, 0.75);
  const spread = (p75 - p25) / p50;
  reasoning.push(`comparable band: 25th ${usd(p25)}, median ${usd(p50)}, 75th ${usd(p75)}`);

  if (spread > MAX_RELATIVE_SPREAD) {
    return { ...base(), blocked:
      `the comparable postings disagree too much to describe one market (interquartile spread ${(spread * 100).toFixed(0)}% of the median). `
      + "They are not all the same job, and averaging them would hide that." };
  }
  if (spread > 0.4) uncertainty.push(`comparables are widely spread (${(spread * 100).toFixed(0)}% of median), so the band is soft`);

  const { position, because } = bandPosition(qualification);
  reasoning.push(...because);
  let point = round(p25 + (p75 - p25) * position);
  reasoning.push(`${(position * 100).toFixed(0)}% between the 25th and 75th gives ${usd(point)}`);

  // 3. Preferences are constraints on the answer, not the answer.
  if (preferences.hardFloor) {
    inputsUsed.push(`stated floor ${usd(preferences.hardFloor)}`);
    if (point < preferences.hardFloor) {
      point = preferences.hardFloor;
      reasoning.push(`raised to the stated floor of ${usd(preferences.hardFloor)}`);
      uncertainty.push("the market band sits below the stated floor, so this ask is set by the floor rather than by the market");
    }
  }
  if (preferences.targetIdeal) inputsUsed.push(`stated target ${usd(preferences.targetIdeal)}`);
  if (preferences.targetMin && point < preferences.targetMin) {
    uncertainty.push(`${usd(point)} is below the ${usd(preferences.targetMin)} target: the market for this role and place supports less than the target does`);
  }

  // 4. Shape the answer to the question that was actually asked.
  if (shape === "TOTAL_COMPENSATION") {
    uncertainty.push("the question asks for total compensation; only base salary is computed here, and equity or bonus is not added");
  }
  if (posting.mentionsEquity) uncertainty.push("the posting mentions equity, which is not counted toward this base figure");
  if (posting.hasQuotaOrCommission) uncertainty.push("the role carries commission, so base and on-target earnings differ and the question may mean either");
  if (/not including bonus|excluding bonus|base salary/i.test(input.question)) {
    reasoning.push("the question excludes bonus, so this is a base-salary figure and no variable pay is counted toward it");
  }

  const halfWidth = Math.max(4000, Math.round((p75 - p25) * 0.10));
  const confidence: SalaryRecommendation["confidence"] =
    comparables.length >= 25 && spread <= 0.3 ? "HIGH"
    : comparables.length >= 12 && spread <= 0.5 ? "MEDIUM" : "LOW";

  return {
    answer: shape === "MINIMUM" ? usd(point)
      : shape === "RANGE" ? `${usd(round(point - halfWidth))} to ${usd(round(point + halfWidth))}`
      : usd(point),
    shape,
    low: round(point - halfWidth), high: round(point + halfWidth), point,
    confidence,
    // Always. A salary number goes out under the user's name and is the
    // one answer on the form that is a negotiating position rather than
    // a fact, so a person sees it before it is sent.
    requiresHumanReview: true,
    blocked: null, reasoning, inputsUsed, uncertainty,
  };
}
