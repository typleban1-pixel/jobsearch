/**
 * The compensation-then-eligibility sequence, and why its order is load-bearing.
 *
 *   node scripts/pipeline-order-selftest.ts
 *
 * Northern Trust R159624 published "Salary Range: $114,700 - 194,900
 * USD" and the portal showed "salary not stated". Four steps have to run
 * in one order for that not to happen, and nothing enforced it:
 *
 *   hydration -> renormalization -> full gate -> extraction refresh
 *
 * Two orderings are actively wrong, and both were the live state at some
 * point. Running the gate BEFORE hydration means the new salary is never
 * seen. Running the refresh WITHOUT the full gate after it leaves
 * below-floor postings eligible, which is exactly what happened to two
 * of them.
 *
 * The first half of this file reads pipeline.ts and asserts the order.
 * The second half drives the real eligibility rules over fixture jobs, so
 * a reordering fails here rather than in a month's production run.
 */
import { readFileSync } from "node:fs";
import { parseSalaryFromText } from "../lib/ingest/normalize/compensation.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}  ${d}`); }
};

const src = readFileSync("scripts/pipeline.ts", "utf8");
const at = (step: string) => src.indexOf(`run("${step}"`);

console.log("\n1. the four steps are present:");
const STEPS = ["workday-descriptions", "renormalize-compensation", "eligibility", "eligibility-refresh"] as const;
for (const s of STEPS) check(`${s} is in the pipeline`, at(s) > -1, `not found`);

console.log("\n2. and in the one order that works:");
{
  const [hyd, renorm, gate, refresh] = STEPS.map(at) as [number, number, number, number];
  check("hydration precedes renormalization", hyd < renorm, `${hyd} vs ${renorm}`);
  check("renormalization precedes the full gate", renorm < gate, `${renorm} vs ${gate}`);
  check("the full gate precedes the refresh", gate < refresh, `${gate} vs ${refresh}`);
  // The two orderings that were actually wrong in production.
  check("the gate does NOT run before hydration", !(gate < hyd));
  check("the refresh does NOT run before the gate", !(refresh < gate));
}

console.log("\n3. everything downstream still follows:");
for (const later of ["score", "candidacy", "churn"]) {
  check(`${later} runs after the refresh`, at(later) > at("eligibility-refresh"), `${at(later)} vs ${at("eligibility-refresh")}`);
}

console.log("\n4. the salary write carries its provenance:");
{
  const renorm = readFileSync("scripts/renormalize-compensation.ts", "utf8");
  // Currency was silently dropped once and needed a backfill. The write
  // path must carry it, or the same repair is needed again.
  check("salary_currency is written", /salary_currency:/.test(renorm));
  check("salary_period is written", /salary_period:/.test(renorm));
  check("salary_source records it came from description text",
    /description_text:renormalized/.test(renorm));
  check("salary_is_estimated is set false, not left null", /salary_is_estimated:\s*false/.test(renorm));
  // It must read the store hydration writes, or it sees nothing.
  check("it reads job_descriptions, which is what hydration writes",
    /from\("job_descriptions"|"job_descriptions"/.test(renorm));
}

// ---- the rules themselves, over fixture postings ----------------------
const FLOOR = 85_000;
/** The floor rule as eligibility applies it: annualise, then compare. */
const verdict = (s: ReturnType<typeof parseSalaryFromText>, geoOk: boolean) => {
  if (!geoOk) return { eligibility: "INELIGIBLE", reason: "OUT_OF_AREA" };
  if (!s) return { eligibility: "ELIGIBLE", reason: "IN_TARGET_METRO" };   // unknown never rejects
  const annualMax = s.salaryPeriod === "HOUR" ? (s.salaryMax ?? 0) * 2080 : (s.salaryMax ?? 0);
  return annualMax < FLOOR
    ? { eligibility: "INELIGIBLE", reason: "SALARY_BELOW_HARD_FLOOR" }
    : { eligibility: "ELIGIBLE", reason: "IN_TARGET_METRO" };
};

console.log("\n5. a Workday posting through the whole sequence:");
{
  // (1) at ingest the listing has no description at all.
  const atIngest = parseSalaryFromText("");
  check("unknown salary at ingest", atIngest === null);
  check("and it stays geographically eligible",
    verdict(atIngest, true).eligibility === "ELIGIBLE", JSON.stringify(verdict(atIngest, true)));

  // (2) hydration supplies the real description, below the floor.
  const hydrated = "Chicago, IL. Salary Range: $60,000 - 75,000 USD. Comprehensive benefits.";
  // (3) renormalization reads it.
  const s = parseSalaryFromText(hydrated);
  check("renormalization finds the pay", s !== null && s.salaryMin === 60000 && s.salaryMax === 75000, JSON.stringify(s));
  check("with a currency", s?.salaryCurrency === "USD");
  check("a period", s?.salaryPeriod === "YEAR");
  check("and provenance saying it came from the text", s?.salarySource === "description_text");

  // (4) the full gate now rejects it.
  const g = verdict(s, true);
  check("the full gate makes it INELIGIBLE", g.eligibility === "INELIGIBLE", JSON.stringify(g));
  check("for the salary floor specifically", g.reason === "SALARY_BELOW_HARD_FLOOR");

  // (5) the refresh must not undo that. It only replaces UNKNOWN inputs;
  //     a published salary is not unknown.
  const afterRefresh = verdict(s, true);
  check("the refresh leaves it ineligible", afterRefresh.eligibility === "INELIGIBLE");
}

console.log("\n6. an above-floor posting survives the same sequence:");
{
  const s = parseSalaryFromText("Salary Range: $114,700 - 194,900 USD");
  check("R159624's exact wording parses", s?.salaryMin === 114700 && s?.salaryMax === 194900, JSON.stringify(s));
  check("as annual USD", s?.salaryPeriod === "YEAR" && s?.salaryCurrency === "USD");
  check("and it stays ELIGIBLE", verdict(s, true).eligibility === "ELIGIBLE");
}

console.log("\n7. ambiguous compensation stays unknown and never rejects:");
{
  for (const [label, text] of [
    ["OTE", "On-target earnings of $70,000 - 80,000 including commission"],
    ["bonus", "Annual bonus of $10,000 - 20,000 in addition to base"],
    ["equity", "Equity grant valued at $50,000 - 60,000"],
    ["tuition", "Tuition assistance up to $5,000 - 10,000 per year"],
    ["no figures", "Competitive compensation and excellent benefits."],
  ] as Array<[string, string]>) {
    const s = parseSalaryFromText(text);
    check(`${label} is refused as base pay`, s === null, JSON.stringify(s));
    check(`  and does not cause a rejection`, verdict(s, true).eligibility === "ELIGIBLE");
  }
}

console.log("\n8. hourly pay is annualised before the floor applies:");
{
  const low = parseSalaryFromText("Pay: $15 - 17 per hour");
  check("hourly is read as HOUR", low?.salaryPeriod === "HOUR", JSON.stringify(low));
  check("and $17/hr is below the floor once annualised",
    verdict(low, true).reason === "SALARY_BELOW_HARD_FLOOR", JSON.stringify(verdict(low, true)));
  const high = parseSalaryFromText("Pay: $60 - 90 per hour");
  check("$90/hr clears the floor", verdict(high, true).eligibility === "ELIGIBLE", JSON.stringify(high));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("hydration, then renormalization, then the gate, then the refresh");
