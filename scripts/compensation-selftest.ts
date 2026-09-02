/**
 * Reading pay out of a posting, and refusing to read the wrong thing.
 *
 * Every case here is a way a dollar figure can appear near compensation
 * language without being base salary, plus the one case that started
 * this: Home Chef published "Illinois Pay Range \n $60,000 — $75,000
 * USD" and the parser threw it away, because the label window reached
 * back past the label into a benefits sentence and found "401k match".
 *
 * The consequence was not a missing field. The job became salary-
 * unknown, unknown salary correctly survives the hard floor, and a role
 * whose published maximum was $10,000 below the floor was scored,
 * judged APPLICATION_CANDIDATE and prepared into a real application.
 * That is why these cases are worth having.
 */
import { parseSalaryFromText, labelFor } from "../lib/ingest/normalize/compensation.ts";
import { compareToFloor } from "../lib/scoring/salary.ts";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};
const parse = (t: string) => parseSalaryFromText(t);
const isBase = (t: string, lo: number, hi: number, period = "YEAR") => {
  const r = parse(t);
  return Boolean(r && r.salaryMin === lo && r.salaryMax === hi && r.salaryPeriod === period);
};

console.log("\nthe posting that exposed this");
const HOME_CHEF = "Home Chef provides a comprehensive benefits package, including healthcare coverage, "
  + "401k match, and paid time off.\n\nIllinois Pay Range\n$60,000 — $75,000 USD\n\nTo view the Cal";
check("the Illinois Pay Range is read as base salary", isBase(HOME_CHEF, 60000, 75000), JSON.stringify(parse(HOME_CHEF)));
check("and the label is the pay-range line, not the benefits sentence",
  /pay range/i.test(labelFor(HOME_CHEF, HOME_CHEF.indexOf("$60,000"))),
  JSON.stringify(labelFor(HOME_CHEF, HOME_CHEF.indexOf("$60,000"))));
{
  const r = parse(HOME_CHEF)!;
  const v = compareToFloor({ salaryMin: r.salaryMin, salaryMax: r.salaryMax, period: r.salaryPeriod,
    isEstimated: false, floor: 85000 });
  check("and an $85,000 floor excludes it", v.verdict === "BELOW_FLOOR", v.detail);
}

console.log("\nmoney that is not base salary");
check("equity grants are refused", parse("Compensation. New hire equity: $32,000-$48,000 Annual Refresh.") === null);
check("signing bonuses are refused", parse("Signing bonus: $10,000 - $20,000 salary") === null);
check("annual bonuses are refused", parse("Annual bonus: $10,000 - $20,000 salary") === null);
check("commission is refused", parse("Salary plus commission: $40,000 - $60,000") === null);
check("OTE is refused", parse("Compensation: OTE $120,000 - $150,000") === null);
check("on-target earnings are refused", parse("On-target earnings $120,000 - $150,000 salary") === null);
check("total compensation is refused", parse("Total compensation: $180,000 - $220,000") === null);
check("401k match is refused", parse("401k match: $5,000 - $8,000 compensation") === null);
check("stipends are refused", parse("Wellness stipend: $1,000 - $2,000 annual salary") === null);
check("RSUs are refused", parse("RSUs valued at $50,000 - $90,000 compensation") === null);

console.log("\nmoney that is base salary");
check("a plain base range", isBase("Base salary range: $95,000 - $120,000 USD", 95000, 120000));
check("an en dash", isBase("Salary range: $95,000 – $120,000", 95000, 120000));
check("an em dash", isBase("Salary range: $95,000 — $120,000", 95000, 120000));
check("the word to", isBase("Salary range: $95,000 to $120,000", 95000, 120000));
check("k notation", isBase("Salary: $90k - $110k", 90000, 110000));
check("a label after an unrelated sentence about equity",
  isBase("We offer equity. Base pay range $60,000 - $75,000 per year.", 60000, 75000),
  "a previous sentence must not label this number");

console.log("\nhourly pay is read and annualized, not confused with a yearly figure");
check("an hourly range parses as hourly", isBase("Pay range: $22.00 - $28.00 per hour", 22, 28, "HOUR"));
check("a low hourly range parses", isBase("Compensation: $16 - $19 hourly", 16, 19, "HOUR"));
{
  const r = parse("Pay range: $21 - $24 per hour")!;
  const v = compareToFloor({ salaryMin: r.salaryMin, salaryMax: r.salaryMax, period: r.salaryPeriod,
    isEstimated: false, floor: 85000 });
  check("an hourly maximum annualizes below the floor and excludes",
    v.verdict === "BELOW_FLOOR" && v.annualizedMax === 49920, `${v.verdict} ${v.annualizedMax}`);
}

console.log("\nunrelated dollar amounts stay unread");
check("customer savings are not a salary", parse("Our customers save $1,000 - $2,000 annually on salary software") === null);
check("per-seat pricing is not a salary", parse("Salary software costs $5 - $9 per seat") === null);
check("a revenue figure is not a salary", parse("We grew from $2,000,000 - $9,000,000 in annual revenue") === null);
check("text with no compensation language is not a salary", parse("Between $60,000 and $75,000 widgets shipped") === null);

console.log("\nunknown salary still survives, which is the other half of the rule");
check("a posting with no figures yields nothing", parse("A great role on a growing team.") === null);
{
  const v = compareToFloor({ salaryMin: null, salaryMax: null, period: null, isEstimated: false, floor: 85000 });
  check("and an unknown salary is INDETERMINATE, never below the floor", v.verdict === "INDETERMINATE", v.verdict);
}
{
  const v = compareToFloor({ salaryMin: 50000, salaryMax: 60000, period: "YEAR", isEstimated: true, floor: 85000 });
  check("an aggregator estimate never excludes a job", v.verdict === "INDETERMINATE", v.verdict);
}
{
  const v = compareToFloor({ salaryMin: 90000, salaryMax: null, period: "YEAR", isEstimated: false, floor: 85000 });
  check("a stated minimum above the floor clears it without a maximum",
    v.verdict === "AT_OR_ABOVE_FLOOR", v.verdict);
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
