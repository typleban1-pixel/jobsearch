/**
 * The salary expectation rules, without a database.
 *   node scripts/salary-expectation-selftest.ts
 */
import { salaryExpectation, pickSalaryOption, annualize } from "../lib/applications/salaryExpectation.ts";

let bad = 0;
const ok = (c: boolean, what: string, extra = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${extra ? " -- " + extra : ""}`); if (!c) bad++; };
const PROFILE = { floor: 85_000, min: 100_000, ideal: 115_000 };
const posting = (min: number | null, max: number | null, period = "YEAR", metro: string | null = "Chicagoland", remotePolicy: string | null = null) =>
  ({ salaryMin: min, salaryMax: max, salaryPeriod: period, metro, remotePolicy });
const fit = (matchScore: number | null, verdict: string | null, hardMet = 2, hardTotal = 4, provisional = false) =>
  ({ matchScore, matchProvisional: provisional, candidacyVerdict: verdict, hardMet, hardTotal });
const val = (r: any) => ("value" in r ? r.value : `BLOCK: ${r.block}`);

console.log("posted range");
ok(val(salaryExpectation(PROFILE, posting(97_000, 129_000), fit(50, "STRETCH", 2, 4))) === "$113,000", "middle of $97k–$129k for an ordinary stretch", val(salaryExpectation(PROFILE, posting(97_000, 129_000), fit(50, "STRETCH", 2, 4))));
ok(val(salaryExpectation(PROFILE, posting(97_000, 129_000), fit(67, "STRETCH", 2, 4))) === "$119,000", "a confident 60+ match asks in the upper part even as a stretch");
ok(val(salaryExpectation(PROFILE, posting(97_000, 129_000), fit(72, "APPLICATION_CANDIDATE"))) === "$119,000", "upper part for a strong match", val(salaryExpectation(PROFILE, posting(97_000, 129_000), fit(72, "APPLICATION_CANDIDATE"))));
ok(val(salaryExpectation(PROFILE, posting(97_000, 129_000), fit(31, "STRETCH", 1, 5))) === "$110,000", "lower part for a thin stretch, but never under the $100k minimum", val(salaryExpectation(PROFILE, posting(97_000, 129_000), fit(31, "STRETCH", 1, 5))));
ok(val(salaryExpectation(PROFILE, posting(160_000, 205_000), fit(30, "STRETCH", 1, 6))) === "$178,000", "a rich range is answered inside the range, not at the profile ideal", val(salaryExpectation(PROFILE, posting(160_000, 205_000), fit(30, "STRETCH", 1, 6))));
ok(val(salaryExpectation(PROFILE, posting(88_000, 96_000), fit(50, "STRETCH"))) === "$96,000", "a range topping out under the minimum asks for its top", val(salaryExpectation(PROFILE, posting(88_000, 96_000), fit(50, "STRETCH"))));
ok(/BLOCK/.test(val(salaryExpectation(PROFILE, posting(60_000, 80_000), fit(50, "STRETCH")))), "a range under the floor gets no figure");
ok(val(salaryExpectation(PROFILE, posting(50, 60, "HOUR"), fit(50, "STRETCH"))) === "$114,000", "an hourly range is read as annual", val(salaryExpectation(PROFILE, posting(50, 60, "HOUR"), fit(50, "STRETCH"))));
ok(annualize(9_000, "MONTH") === 108_000, "a monthly figure is read as annual");

console.log("\nno range");
ok(val(salaryExpectation(PROFILE, posting(null, null, "YEAR", "Chicagoland"), fit(40, "STRETCH"))) === "$115,000", "Chicagoland without a range: the ideal");
ok(val(salaryExpectation(PROFILE, posting(null, null, "YEAR", null, "REMOTE"), fit(40, "STRETCH"))) === "$115,000", "remote without a range: the ideal");
ok(val(salaryExpectation(PROFILE, posting(null, null, "YEAR", null, "HYBRID"), fit(40, "STRETCH"))) === "$100,000 to $115,000", "elsewhere without a range: the min-to-ideal span");
ok(val(salaryExpectation(PROFILE, null, null)) === "$115,000", "no posting facts at all: the ideal");
ok(/BLOCK/.test(val(salaryExpectation({ floor: 85_000, min: null, ideal: null }, posting(97_000, 129_000), null))), "no stored target: no figure, whatever the posting says");

console.log("\nsalary bands as options");
const BANDS = ["Under $80,000", "$80,000 - $100,000", "$100,001 - $120,000", "$120,001 - $140,000", "$140,000+"];
ok(pickSalaryOption(BANDS, 113_000) === "$100,001 - $120,000", "the band holding the figure");
ok(pickSalaryOption(BANDS, 178_000) === "$140,000+", "an open-ended top band");
ok(pickSalaryOption(["$90k-$110k", "$110k-$130k"], 113_000) === "$110k-$130k", "k-suffixed bands");
ok(pickSalaryOption(["Yes", "No"], 113_000) === null, "options that are not bands give nothing");

console.log(bad ? `\n${bad} FAILED` : "\nsalary-expectation-selftest: ALL PASS");
process.exit(bad ? 1 : 0);
