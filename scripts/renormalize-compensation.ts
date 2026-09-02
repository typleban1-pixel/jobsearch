/**
 * Re-reads compensation from descriptions already on file.
 *
 *   node scripts/renormalize-compensation.ts            report only
 *   node scripts/renormalize-compensation.ts --commit   write it
 *
 * Normal ingest cannot do this. A new job_versions row is written only
 * when content_hash changes, and these postings have not changed: what
 * changed is our ability to read them. Home Chef published "Illinois Pay
 * Range \n $60,000 — $75,000 USD" and the parser discarded it, because
 * the label window reached back into the previous sentence and found
 * "401k match". The posting was then salary-unknown, the hard floor could
 * not exclude it, and it reached a prepared application.
 *
 * Only fills gaps. A job that already carries a salary is left exactly
 * as it is: this corrects an absence, and silently overwriting a figure
 * the board supplied would be a different and much riskier operation.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { parseSalaryFromText } from "../lib/ingest/normalize/compensation.ts";
import { compareToFloor } from "../lib/scoring/salary.ts";

const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const page = async (t: string, cols: string, f: (q: any) => any = (q) => q, order = "id") => {
  const out: any[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await f(db.from(t).select(cols)).order(order).range(from, from + 499);
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...data); if (data.length < 500) break;
  }
  return out;
};

const { data: prof } = await db.from("profile").select("salary_hard_floor").single();
const floor = prof!.salary_hard_floor as number | null;

const jobs = await page("jobs", "id,title,status,eligibility,salary_min,salary_max");
// Two stores hold description text. job_versions is the frozen record
// written at ingest and is append-only, so it cannot be corrected; the
// Workday hydrator writes job_descriptions, which is also what extraction
// and scoring read.
//
// Reading only job_versions is why this script reported "0 gain a salary"
// against 437 postings whose descriptions had just been hydrated: it was
// looking at the store the new text never reached. job_descriptions is
// preferred and job_versions is the fallback, so postings ingested with
// their text still behave exactly as before.
const versions = await page("job_versions", "job_id,description_text,salary_min,salary_max",
  (q: any) => q.eq("is_current", true), "job_id");
const hydrated = await page("job_descriptions", "job_id,description_text", (q: any) => q, "job_id");
const textFor = new Map<string, string>();
for (const v of versions as any[]) textFor.set(v.job_id, v.description_text ?? "");
for (const d of hydrated as any[]) {
  const t = d.description_text ?? "";
  if (t.trim().length > (textFor.get(d.job_id) ?? "").trim().length) textFor.set(d.job_id, t);
}

const found: Array<{ id: string; title: string; status: string; eligibility: string;
  min: number; max: number; period: string; currency: string | null;
  annualMax: number | null; below: boolean }> = [];

for (const j of jobs) {
  // Never overwrite a figure that is already recorded.
  if (j.salary_min !== null || j.salary_max !== null) continue;
  const parsed = parseSalaryFromText(textFor.get(j.id) ?? "");
  if (!parsed || parsed.salaryMin === null || parsed.salaryMax === null) continue;
  const v = compareToFloor({ salaryMin: parsed.salaryMin, salaryMax: parsed.salaryMax,
    period: parsed.salaryPeriod, isEstimated: false, floor });
  found.push({ id: j.id, title: j.title, status: j.status, eligibility: j.eligibility,
    min: parsed.salaryMin, max: parsed.salaryMax, period: parsed.salaryPeriod!,
    currency: parsed.salaryCurrency ?? null,
    annualMax: v.annualizedMax, below: v.verdict === "BELOW_FLOOR" });
}

const openEligible = found.filter((f) => f.status === "OPEN" && f.eligibility === "ELIGIBLE");
console.log(`${jobs.length} jobs, ${found.length} gain a salary that was not recorded`);
console.log(`  of those, currently OPEN and ELIGIBLE: ${openEligible.length}`);
console.log(`  and below the ${floor?.toLocaleString()} floor: ${openEligible.filter((f) => f.below).length}`);

console.log("\nopen and eligible, now below the floor:");
for (const f of openEligible.filter((x) => x.below).sort((a, b) => (a.annualMax ?? 0) - (b.annualMax ?? 0))) {
  console.log(`  ${String(f.min).padStart(7)} - ${String(f.max).padStart(7)} ${f.period.padEnd(5)}`
    + `  max/yr ${String(f.annualMax).padStart(7)}  ${f.title.slice(0, 46)}`);
}

if (!commit) {
  console.log(`\nnothing written; pass --commit to persist`);
  process.exit(0);
}

// jobs.salary_* is what eligibility, scoring and the portal all read.
// job_versions is the frozen record of one fetch and stays as it is:
// what it says is what the parser understood at the time, and rewriting
// history to match a later understanding would hide the defect.
let written = 0;
for (const f of found) {
  const { error } = await db.from("jobs").update({
    salary_min: f.min, salary_max: f.max, salary_period: f.period,
    // The parser resolves a currency and it belongs with the figures:
    // a bare 114700 is not a compensation fact without one.
    salary_currency: f.currency,
    salary_is_estimated: false, salary_source: "description_text:renormalized",
  }).eq("id", f.id);
  if (error) { console.error(`  ${f.title}: ${error.message}`); continue; }
  written++;
}
console.log(`\nwrote salary onto ${written} jobs`);
console.log("run scripts/eligibility-refresh.ts next, then score.ts --commit and score-candidacy.ts --write");
