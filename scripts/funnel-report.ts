/**
 * The funnel, measured per company source.
 *
 * Expansion decisions are made on marginal candidate yield, not company
 * count: a source that adds 500 companies and produces 30 strong jobs
 * beats one that adds 10,000 and produces nothing. So every stage is
 * attributed back to the discovery source of the company that produced
 * it.
 *
 *   companies -> resolved -> open jobs -> cheap-gate survivors
 *   -> extracted/scored -> CANDIDATE/STRETCH/REVIEW/REJECT
 *   -> auto-submit ready -> submitted
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

async function allRows(table: string, cols: string, f: (q: any) => any = (q) => q): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(db.from(table).select(cols)).order("id").range(from, from + 999);
    if (error) { console.error(`${table}: ${error.message}`); process.exit(1); }
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const cohortOf = (source: string | null): string => {
  const s = String(source ?? "");
  if (/Y Combinator/i.test(s)) return "YC directory";
  if (/Wikidata.*Chicago/i.test(s)) return "Wikidata Chicago";
  if (/Wikidata.*large/i.test(s)) return "Wikidata large US";
  return "seed/other";
};

const companies = await allRows("companies", "id,lifecycle,discovery_source,ats_provider");
const jobs = await allRows("jobs", "id,company_id,status,eligibility");
const verdicts = await allRows("job_candidacy", "id,job_id,verdict,created_at");
const apps = await allRows("applications", "id,job_id,status,submitted_at");

// The authoritative verdict per job is the newest.
const verdictByJob = new Map<string, string>();
const seen = new Map<string, string>();
for (const v of verdicts) {
  const prev = seen.get(v.job_id);
  if (!prev || v.created_at > prev) { seen.set(v.job_id, v.created_at); verdictByJob.set(v.job_id, v.verdict); }
}
const companyById = new Map(companies.map((c: any) => [c.id, c]));
const jobById = new Map(jobs.map((j: any) => [j.id, j]));

type Row = { companies: number; resolved: number; openJobs: number; eligible: number; ineligible: number;
  unknownElig: number; scored: number; candidate: number; stretch: number; review: number; reject: number;
  submitted: number };
const zero = (): Row => ({ companies: 0, resolved: 0, openJobs: 0, eligible: 0, ineligible: 0, unknownElig: 0,
  scored: 0, candidate: 0, stretch: 0, review: 0, reject: 0, submitted: 0 });
const rows = new Map<string, Row>();
const rowFor = (k: string) => { if (!rows.has(k)) rows.set(k, zero()); return rows.get(k)!; };

for (const c of companies as any[]) {
  const r = rowFor(cohortOf(c.discovery_source));
  r.companies++;
  if (c.lifecycle === "ACTIVE") r.resolved++;
}
for (const j of jobs as any[]) {
  const c = companyById.get(j.company_id);
  const r = rowFor(cohortOf(c?.discovery_source ?? null));
  if (j.status === "OPEN") r.openJobs++;
  if (j.eligibility === "ELIGIBLE") r.eligible++;
  else if (j.eligibility === "INELIGIBLE") r.ineligible++;
  else r.unknownElig++;
  const v = verdictByJob.get(j.id);
  if (v) {
    r.scored++;
    if (v === "APPLICATION_CANDIDATE") r.candidate++;
    else if (v === "STRETCH") r.stretch++;
    else if (v === "MANUAL_REVIEW") r.review++;
    else if (v === "REJECT") r.reject++;
  }
}
for (const a of apps as any[]) {
  if (!a.submitted_at) continue;
  const j = jobById.get(a.job_id);
  const c = j ? companyById.get((j as any).company_id) : null;
  rowFor(cohortOf((c as any)?.discovery_source ?? null)).submitted++;
}

const order = [...rows.entries()].sort((a, b) => b[1].companies - a[1].companies);
const H = ["cohort", "cos", "resolved", "open", "elig", "inelig", "unk", "scored", "CAND", "STRETCH", "REVIEW", "REJECT", "subm"];
console.log(H.map((h, i) => h.padEnd(i === 0 ? 18 : 8)).join(""));
for (const [k, r] of order) {
  console.log([k.padEnd(18), r.companies, r.resolved, r.openJobs, r.eligible, r.ineligible, r.unknownElig,
    r.scored, r.candidate, r.stretch, r.review, r.reject, r.submitted]
    .map((x, i) => String(x).padEnd(i === 0 ? 18 : 8)).join(""));
}
const t = zero();
for (const [, r] of rows) for (const k of Object.keys(t) as (keyof Row)[]) t[k] += r[k];
console.log([("TOTAL").padEnd(18), t.companies, t.resolved, t.openJobs, t.eligible, t.ineligible, t.unknownElig,
  t.scored, t.candidate, t.stretch, t.review, t.reject, t.submitted]
  .map((x, i) => String(x).padEnd(i === 0 ? 18 : 8)).join(""));

// marginal yield: strong outcomes per resolved company
console.log("\nmarginal yield (per resolved company):");
for (const [k, r] of order) {
  if (!r.resolved) { console.log(`  ${k.padEnd(18)} (nothing resolved yet)`); continue; }
  console.log(`  ${k.padEnd(18)} ${(r.openJobs / r.resolved).toFixed(1)} open jobs, `
    + `${(r.eligible / r.resolved).toFixed(2)} eligible, ${((r.candidate + r.stretch) / r.resolved).toFixed(2)} candidate+stretch`);
}
