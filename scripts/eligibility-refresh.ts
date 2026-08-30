/**
 * Re-runs the eligibility gate using what extraction learned.
 *
 * The gate is deterministic and stays deterministic: the same rules, fed
 * better inputs. Extraction reads the posting body and often finds a
 * stated remote policy where our structured-field normalizer had to give
 * up, and the model's answer is evidence, not a verdict. It replaces an
 * UNKNOWN input; it never overrides the rules.
 *
 *   node scripts/eligibility-refresh.ts            report only
 *   node scripts/eligibility-refresh.ts --commit   persist
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { assessEligibility, ELIGIBILITY_VERSION, PROPOSED_RULES } from "../lib/scoring/eligibility.ts";

const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const page = async (t: string, cols: string, extra: (q: any) => any = (q) => q) => {
  const out: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await extra(db.from(t).select(cols)).order("id", { ascending: true }).range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...data); if (data.length < 1000) break;
  }
  return out;
};

const jobs = await page("jobs",
  "id,company_id,source,external_id,title,city,state,country,metro,remote_policy," +
  "remote_geographic_restriction,location_raw,eligibility,eligibility_reason,extraction_version," +
  "salary_min,salary_max,salary_period,salary_is_estimated");
const ex = await page("job_extractions", "id,job_id,output,succeeded,superseded_by",
  (q) => q.is("superseded_by", null).eq("succeeded", true));
const exBy = new Map(ex.map((e: any) => [e.job_id, e.output]));
const { data: cos } = await db.from("companies").select("id,name");
const coName = new Map((cos ?? []).map((c: any) => [c.id, c.name]));

const POLICY: Record<string, string> = {
  FULLY_REMOTE: "FULLY_REMOTE", HYBRID: "HYBRID", ONSITE: "ONSITE",
};

const changes: Array<{ job: any; from: string; to: string; reason: string; why: string }> = [];
const updates: any[] = [];

for (const j of jobs) {
  const out = exBy.get(j.id);
  if (!out) continue;

  const stated = POLICY[out.remote_policy_stated as string];
  const restriction = out.remote_geographic_restriction ?? j.remote_geographic_restriction;
  // Salary can change the verdict on its own now, so a job with no remote
  // information still needs re-assessing.
  if (!stated && !out.remote_geographic_restriction
      && j.salary_max === null && j.salary_min === null) continue;

  const v = assessEligibility({
    city: j.city, state: j.state, country: j.country, metro: j.metro,
    remotePolicy: stated ?? j.remote_policy,
    remoteRestriction: restriction,
    locationRaw: j.location_raw,
    salaryMin: j.salary_min, salaryMax: j.salary_max,
    salaryPeriod: j.salary_period, salaryIsEstimated: j.salary_is_estimated,
  }, PROPOSED_RULES);

  if (v.status !== j.eligibility || v.reason !== j.eligibility_reason) {
    changes.push({
      job: j, from: j.eligibility, to: v.status, reason: v.reason,
      why: stated ? `model read remote policy as ${out.remote_policy_stated}` : "model supplied a geographic restriction",
    });
  }
  updates.push({
    id: j.id, company_id: j.company_id, source: j.source, external_id: j.external_id, title: j.title,
    eligibility: v.status, eligibility_reason: v.reason,
    eligibility_detail: `post-extraction: ${v.detail}`,
    eligibility_checked_at: new Date().toISOString(),
    eligibility_version: ELIGIBILITY_VERSION,
  });
}

const moved: Record<string, number> = {};
for (const c of changes) moved[`${c.from} -> ${c.to}`] = (moved[`${c.from} -> ${c.to}`] ?? 0) + 1;

console.log(`jobs with a current successful extraction: ${exBy.size}`);
console.log(`eligibility re-assessed:                   ${updates.length}`);
console.log(`eligibility changed:                       ${changes.length}\n`);
for (const [k, n] of Object.entries(moved).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${k}`);
}
console.log(`\nsamples:`);
for (const c of changes.slice(0, 12)) {
  console.log(`  ${c.from} -> ${c.to}  [${c.reason}]  ${coName.get(c.job.company_id)} — ${String(c.job.title).slice(0, 46)}`);
  console.log(`        ${c.why}`);
}

// Residency requirements the model found in the body. Reported rather
// than acted on: "must reside in California" is decisive, but deciding it
// from a regex over free text is exactly the kind of guess the gate is
// supposed to avoid making.
const reqs = await page("job_requirements", "job_id,kind,raw_text,normalized_term",
  (q) => q.in("kind", ["LOGISTICAL", "LEGAL"]));
const RESIDENCY = /\b(must (?:reside|live|be based)|reside and be based|based in|located in|residency in|relocate to)\b/i;
const residency = reqs.filter((r: any) => RESIDENCY.test(r.raw_text));
console.log(`\nresidency or location constraints found by extraction: ${residency.length}`);
for (const r of residency.slice(0, 10)) console.log(`  "${String(r.raw_text).slice(0, 100)}"`);
console.log(`  (reported only; the gate does not act on these automatically)`);

if (!commit) {
  console.log(`\ndry run: nothing written.`);
} else {
  for (let i = 0; i < updates.length; i += 500) {
    const { error } = await db.from("jobs").upsert(updates.slice(i, i + 500), { onConflict: "id" });
    if (error) throw new Error(`persist: ${error.message}`);
  }
  console.log(`\nwrote ${updates.length} refreshed verdicts`);
}
