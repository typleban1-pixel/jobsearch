/**
 * What to ask for, and when to refuse to say.
 *
 * The cases below are the mistakes this engine is built to not make.
 * Two of them it did make on the first run against a real posting: it
 * read "not including bonus" as a request for total compensation,
 * because the phrase contains "including bonus"; and it let a $350,000
 * commission role into a band for an analyst job, which moved the
 * recommendation by tens of thousands of dollars.
 */
import { recommendSalary, askShape, titleLevel, bandPosition, MIN_COMPARABLES,
         type Comparable, type QualificationSignal } from "../lib/applications/salary.ts";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};

console.log("\nreading the question");
check("'not including bonus' is a base-salary question",
  askShape("What are your Salary Expectations (not including bonus)?", false) !== "TOTAL_COMPENSATION",
  askShape("What are your Salary Expectations (not including bonus)?", false));
check("'excluding bonus' likewise", askShape("Desired base, excluding bonus", false) !== "TOTAL_COMPENSATION");
check("'total compensation' really is one", askShape("What is your expected total compensation?", false) === "TOTAL_COMPENSATION");
check("'including bonus' really is one", askShape("Expected pay including bonus", false) === "TOTAL_COMPENSATION");
check("'minimum acceptable' is a floor question", askShape("Minimum acceptable salary?", false) === "MINIMUM");
check("'salary range' asks for a range", askShape("What is your desired salary range?", false) === "RANGE");
check("a dropdown asks for one number", askShape("Salary expectation", true) === "SINGLE_NUMBER");

console.log("\nlevels, so unlike roles stay out of a band");
check("a director is not a base role", titleLevel("Director of Strategy & Analytics") === "EXECUTIVE");
check("a manager is not a base role", titleLevel("Engineering Manager") === "MANAGER");
check("a senior is its own level", titleLevel("Senior Data Analyst") === "SENIOR");
check("an analyst is a base role", titleLevel("Menu Strategy Analyst") === "BASE");
check("a VP is executive", titleLevel("VP, Marketing") === "EXECUTIVE");

console.log("\nposition in the band is earned, not assumed");
const strong: QualificationSignal = { candidacyVerdict: "APPLICATION_CANDIDATE", hardMet: 4, hardTotal: 4,
  directMatches: 4, transferableMatches: 1, fitPercentile: 1 };
const weak: QualificationSignal = { candidacyVerdict: "STRETCH", hardMet: 1, hardTotal: 4,
  directMatches: 1, transferableMatches: 0, fitPercentile: 0.2 };
check("a strong match sits higher than a weak one",
  bandPosition(strong).position > bandPosition(weak).position,
  `${bandPosition(strong).position} vs ${bandPosition(weak).position}`);
check("even a perfect match does not reach the top of the band",
  bandPosition(strong).position <= 0.70, String(bandPosition(strong).position));
check("a weak match does not fall to the floor of the band",
  bandPosition(weak).position >= 0.15, String(bandPosition(weak).position));

const comps = (n: number, lo: number, hi: number): Comparable[] =>
  Array.from({ length: n }, (_, i) => ({ jobId: `j${i}`, title: "Analyst", metro: "M", state: "S",
    min: lo + (i % 5) * 1000, max: hi + (i % 5) * 1000, seniority: null }));

const prefs = { hardFloor: 85000, targetMin: 100000, targetIdeal: 115000 };
const posting = { publishedMin: null, publishedMax: null, isEstimated: false, mentionsEquity: false,
  hasQuotaOrCommission: null, metro: "M", state: "S", remotePolicy: null, seniority: null,
  managesPeople: false, title: "Analyst" };
const run = (over: any = {}) => recommendSalary({
  question: "What are your salary expectations?", hasOptions: false,
  posting, comparables: comps(20, 90000, 120000), preferences: prefs,
  qualification: strong, comparableBasis: "test", ...over,
});

console.log("\nrefusing rather than guessing");
check(`fewer than ${MIN_COMPARABLES} comparables blocks`,
  Boolean(run({ comparables: comps(4, 90000, 120000) }).blocked));
check("a wildly spread set blocks",
  Boolean(run({ comparables: [...comps(10, 40000, 50000), ...comps(10, 300000, 400000)] }).blocked));

console.log("\none extreme posting does not set the band");
const clean = run({ comparables: comps(20, 90000, 120000) });
const withOutlier = run({ comparables: [...comps(20, 90000, 120000),
  { jobId: "x", title: "Seller", metro: "M", state: "S", min: 350000, max: 350000, seniority: null }] });
check("an outlier is trimmed rather than averaged in",
  clean.point === withOutlier.point, `${clean.point} vs ${withOutlier.point}`);
check("and the trim is stated in the reasoning",
  withOutlier.reasoning.some((r) => /outlying posting/.test(r)), JSON.stringify(withOutlier.reasoning));

console.log("\nthe answer is never simply a stored preference");
const r = run();
check("it is not the floor", r.point !== prefs.hardFloor, String(r.point));
check("it is not the target", r.point !== prefs.targetIdeal, String(r.point));
check("it is not the plain median of the band",
  r.reasoning.some((x) => /% between the 25th and 75th/.test(x)), JSON.stringify(r.reasoning));
check("a person always sees it first", r.requiresHumanReview === true);

console.log("\na published range is respected");
const published = run({ posting: { ...posting, publishedMin: 100000, publishedMax: 140000 } });
check("the ask sits inside the published range",
  published.point! >= 100000 && published.point! <= 140000, String(published.point));
check("and is not the midpoint by default", published.point !== 120000, String(published.point));
const tooLow = run({ posting: { ...posting, publishedMin: 50000, publishedMax: 70000 } });
check("a range topping out below the floor blocks rather than asking above it",
  Boolean(tooLow.blocked), JSON.stringify(tooLow.answer));

console.log("\nvariable pay is never counted toward a base figure");
const equity = run({ posting: { ...posting, mentionsEquity: true } });
check("equity is flagged as not included",
  equity.uncertainty.some((u) => /equity/.test(u)), JSON.stringify(equity.uncertainty));
const commission = run({ posting: { ...posting, hasQuotaOrCommission: true } });
check("commission is flagged as a different question",
  commission.uncertainty.some((u) => /commission/.test(u)));

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
