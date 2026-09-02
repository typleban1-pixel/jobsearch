/**
 * Applies the deterministic eligibility gate to every open job and
 * reports what survives.
 *
 *   node scripts/eligibility.ts            report only, writes nothing
 *   node scripts/eligibility.ts --commit   persist verdicts to jobs
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { loadCompensationByOpening, salaryInputForJob } from "../lib/scoring/openingCompensation.ts";
import {
  assessEligibility, ELIGIBILITY_VERSION, PROPOSED_RULES,
  type EligibilityStatus, type EligibilityReason,
} from "../lib/scoring/eligibility.ts";

const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

// source, external_id and title are fetched purely because the write is
// an upsert: PostgREST builds an INSERT ... ON CONFLICT, and the insert
// branch still has to satisfy the NOT NULL columns even though only the
// update branch ever runs.
const cols = "id,company_id,source,external_id,title,city,state,country,metro,"
  + "remote_policy,remote_geographic_restriction,location_raw,status,eligibility,eligibility_reason,"
  + "salary_min,salary_max,salary_period,salary_is_estimated,canonical_opening_id";
const jobs: Array<Record<string, any>> = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("jobs").select(cols)
    .eq("status", "OPEN").order("id", { ascending: true }).range(from, from + 999);
  if (error) throw new Error(error.message);
  jobs.push(...data);
  if (data.length < 1000) break;
}

/**
 * Compensation the employer stated, which outranks the posting's own
 * structured fields.
 *
 * Flexport published no salary and stated $27.69/hour on its application
 * form. The structured columns were null, so the floor comparison had
 * nothing to work with and the job stayed eligible. Where a stated
 * figure exists for the opening, it is what the rule should see.
 *
 * The rule itself is untouched. This only decides which numbers reach
 * it, and the employer's own statement is the better answer than silence.
 */
const compByOpening = await loadCompensationByOpening(db, (m) => console.log(`  (${m})`));
if (compByOpening.size) console.log(`employer-stated compensation on ${compByOpening.size} opening(s)`);

// The normalized location set. Authoritative for geography.
const allLocations: Array<Record<string, any>> = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("job_locations")
    .select("job_id,position,city,state,region,country,metro,is_remote,remote_scope,provenance,confidence,raw_segment")
    .order("id", { ascending: true }).range(from, from + 999);
  if (error) throw new Error(error.message);
  allLocations.push(...data); if (data.length < 1000) break;
}
const locationsByJob = new Map<string, any[]>();
for (const l of allLocations) {
  const a = locationsByJob.get(l["job_id"]) ?? [];
  a.push({ city: l["city"], state: l["state"], region: l["region"], country: l["country"],
           metro: l["metro"], isRemote: l["is_remote"], remoteScope: l["remote_scope"],
           provenance: l["provenance"], confidence: l["confidence"],
           rawSegment: l["raw_segment"], position: l["position"] });
  locationsByJob.set(l["job_id"], a);
}
for (const a of locationsByJob.values()) a.sort((x, y) => x.position - y.position);

/**
 * Verdicts this pass is not entitled to overturn.
 *
 * Role shape is decided by scripts/eligibility-refresh.ts from the
 * description and the extracted requirements, neither of which this pass
 * reads. Recomputing geography and writing the result blind would erase
 * 205 quota-sales exclusions and silently reopen roles the user ruled out.
 */
const ROLE_SHAPE_REASONS = new Set([
  "PRIMARY_QUOTA_SALES_ROLE", "PRIMARILY_COMMISSION_COMPENSATION", "SPLIT_SHIFT_REQUIRED",
]);

// Paged. An unranged select stops at PostgREST's 1000-row cap, and with
// 4,221 companies on file that left three quarters of the corpus with no
// name to join against, so the report blamed "?" for 2,439 exclusions.
// Verdicts were never affected; only the label was.
const companies: Array<Record<string, any>> = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("companies").select("id,name")
    .order("id", { ascending: true }).range(from, from + 999);
  if (error) throw new Error(error.message);
  companies.push(...data); if (data.length < 1000) break;
}
const companyName = new Map((companies ?? []).map((c: any) => [c.id, c.name]));

const verdicts = jobs.map((j) => {
  if (ROLE_SHAPE_REASONS.has(j["eligibility_reason"])) {
    return { job: j, v: { status: j["eligibility"] as EligibilityStatus,
                          reason: j["eligibility_reason"] as EligibilityReason,
                          detail: "role shape, decided from the description; not revisited by the geography pass" },
             preserved: true };
  }
  return {
    job: j,
    v: assessEligibility({
      city: j.city, state: j.state, country: j.country, metro: j.metro,
      remotePolicy: j.remote_policy, remoteRestriction: j.remote_geographic_restriction,
      locationRaw: j.location_raw,
      locations: locationsByJob.get(j.id) ?? [],
      ...salaryInputForJob(j, compByOpening),
    }),
    preserved: false,
  };
});
console.log(`role-shape verdicts preserved untouched: ${verdicts.filter((x) => x.preserved).length}`);

const byStatus: Record<string, number> = {};
const byReason: Record<string, { status: EligibilityStatus; n: number; sample: string[] }> = {};
for (const { job, v } of verdicts) {
  byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;
  const b = (byReason[v.reason] ??= { status: v.status, n: 0, sample: [] });
  b.n++;
  if (b.sample.length < 3) {
    b.sample.push(`${companyName.get(job.company_id) ?? "?"}: ${String(job.title).slice(0, 40)} — ${v.detail.slice(0, 60)}`);
  }
}

const total = verdicts.length;
const surviving = (byStatus["ELIGIBLE"] ?? 0) + (byStatus["UNCERTAIN"] ?? 0);
const pct = (n: number) => `${((n * 100) / total).toFixed(1)}%`;

console.log(`eligibility gate v${ELIGIBILITY_VERSION}`);
console.log(`rules: target metros ${PROPOSED_RULES.targetMetros.join(", ")}; remote country ${PROPOSED_RULES.remoteCountry}\n`);
console.log(`open jobs assessed: ${total}\n`);
for (const s of ["ELIGIBLE", "UNCERTAIN", "INELIGIBLE"] as const) {
  console.log(`  ${s.padEnd(12)} ${String(byStatus[s] ?? 0).padStart(5)}  ${pct(byStatus[s] ?? 0)}`);
}
console.log(`\n  survive to extraction: ${surviving}  ${pct(surviving)}`);
console.log(`  withheld:              ${byStatus["INELIGIBLE"] ?? 0}  ${pct(byStatus["INELIGIBLE"] ?? 0)}`);

console.log(`\nby reason:`);
const order = { ELIGIBLE: 0, UNCERTAIN: 1, INELIGIBLE: 2 } as const;
for (const [reason, b] of Object.entries(byReason)
  .sort((a, c) => order[a[1].status] - order[c[1].status] || c[1].n - a[1].n)) {
  console.log(`\n  ${b.status.padEnd(11)} ${String(b.n).padStart(5)}  ${pct(b.n).padStart(6)}  ${reason}`);
  for (const s of b.sample) console.log(`                                  ${s}`);
}

// Ineligible concentration: a gate that removes one company entirely is
// worth eyeballing before it is trusted.
const inelByCompany: Record<string, number> = {};
const totalByCompany: Record<string, number> = {};
for (const { job, v } of verdicts) {
  const n = companyName.get(job.company_id) ?? "?";
  totalByCompany[n] = (totalByCompany[n] ?? 0) + 1;
  if (v.status === "INELIGIBLE") inelByCompany[n] = (inelByCompany[n] ?? 0) + 1;
}
console.log(`\ncompanies most affected:`);
for (const [n, c] of Object.entries(inelByCompany).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(c).padStart(4)} / ${String(totalByCompany[n]).padStart(4)} excluded  ${n}`);
}

if (!commit) {
  console.log(`\ndry run: no verdicts written. Pass --commit to persist.`);
} else {
  const now = new Date().toISOString();
  for (let i = 0; i < verdicts.length; i += 500) {
    const slice = verdicts.slice(i, i + 500);
    const { error } = await db.from("jobs").upsert(slice.map(({ job, v }) => ({
      id: job.id, company_id: job.company_id, source: job.source,
      external_id: job.external_id, title: job.title,
      eligibility: v.status, eligibility_reason: v.reason,
      eligibility_detail: v.detail, eligibility_checked_at: now,
      eligibility_version: ELIGIBILITY_VERSION,
    })), { onConflict: "id" });
    if (error) throw new Error(`persist: ${error.message}`);
  }
  console.log(`\nwrote ${verdicts.length} verdicts (eligibility_version ${ELIGIBILITY_VERSION})`);
  console.log(
    `\nNOTE: this pass uses structured fields only and overwrites any\n` +
    `extraction-informed verdicts. Run scripts/eligibility-refresh.ts --commit\n` +
    `immediately after, or ~590 jobs will silently revert to a worse answer.`,
  );
}
