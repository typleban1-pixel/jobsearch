/**
 * What the company universe actually is, before changing it.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const countOf = async (t: string, f: (q: any) => any = (q) => q) => {
  const { count, error } = await f(db.from(t).select("id", { count: "exact", head: true }));
  if (error) return `ERR ${error.message.slice(0, 60)}`;
  return count ?? 0;
};

console.log("=== COMPANIES ===");
/**
 * Paged, because PostgREST returns 1,000 rows and stops.
 *
 * The first run of this audit reported "1,000 companies" and built every
 * percentage on it. The universe was four times that: the number was the
 * page size wearing a total's clothes.
 */
async function allRows(table: string, cols: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(cols).order("id").range(from, from + 999);
    if (error) { console.error(`${table}: ${error.message}`); process.exit(1); }
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}
const all = await allRows("companies",
  "id,name,lifecycle,ats_provider,ats_token,ats_detection_method,discovery_method,discovery_source,has_chicagoland_presence,hires_remote_us,open_job_count");
console.log(`total companies: ${all.length}`);

const by = (key: string) => {
  const m = new Map<string, number>();
  for (const c of all as any[]) m.set(String(c[key] ?? "(null)"), (m.get(String(c[key] ?? "(null)")) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
console.log("\nby lifecycle:");
for (const [k, v] of by("lifecycle")) console.log(`  ${String(k).padEnd(24)} ${v}`);
console.log("\nby ats_provider:");
for (const [k, v] of by("ats_provider")) console.log(`  ${String(k).padEnd(24)} ${v}`);
console.log("\nby ats_detection_method:");
for (const [k, v] of by("ats_detection_method")) console.log(`  ${String(k).padEnd(28)} ${v}`);
console.log("\nby discovery_method:");
for (const [k, v] of by("discovery_method").slice(0, 12)) console.log(`  ${String(k).padEnd(28)} ${v}`);
console.log("\nby discovery_source:");
for (const [k, v] of by("discovery_source").slice(0, 12)) console.log(`  ${String(k).padEnd(28)} ${v}`);
const chi = all.filter((c: any) => c.has_chicagoland_presence).length;
const rem = all.filter((c: any) => c.hires_remote_us).length;
console.log(`\nchicagoland presence: ${chi}   hires remote US: ${rem}`);

const resolved = all.filter((c: any) => c.ats_provider && c.ats_token);
console.log(`\nresolved (provider AND token): ${resolved.length} / ${all.length}  (${(100 * resolved.length / Math.max(1, all.length)).toFixed(1)}%)`);
const providerOnly = all.filter((c: any) => c.ats_provider && !c.ats_token);
console.log(`provider but no token:        ${providerOnly.length}`);
const unresolved = all.filter((c: any) => !c.ats_provider);
console.log(`no provider at all:           ${unresolved.length}`);

console.log("\n=== JOBS ===");
console.log(`total jobs:            ${await countOf("jobs")}`);
console.log(`OPEN jobs:             ${await countOf("jobs", (q) => q.eq("status", "OPEN"))}`);
console.log(`ELIGIBLE jobs:         ${await countOf("jobs", (q) => q.eq("eligibility", "ELIGIBLE"))}`);
console.log(`INELIGIBLE jobs:       ${await countOf("jobs", (q) => q.eq("eligibility", "INELIGIBLE"))}`);
console.log(`UNKNOWN eligibility:   ${await countOf("jobs", (q) => q.is("eligibility", null))}`);

// jobs per resolved company
const jobRows = await allRows("jobs", "id,company_id,status,eligibility");
const jobsByCo = new Map<string, number>();
for (const j of jobRows as any[]) jobsByCo.set(j.company_id, (jobsByCo.get(j.company_id) ?? 0) + 1);
const openByCo = new Map<string, number>();
for (const j of (jobRows as any[]).filter((x) => x.status === "OPEN")) openByCo.set(j.company_id, (openByCo.get(j.company_id) ?? 0) + 1);
const contributing = [...jobsByCo.keys()].length;
console.log(`\ncompanies contributing >=1 job: ${contributing}`);
console.log(`companies resolved but contributing 0 jobs: ${resolved.filter((c: any) => !jobsByCo.has(c.id)).length}`);

console.log("\n=== CANDIDACY ===");
for (const v of ["APPLICATION_CANDIDATE", "STRETCH", "MANUAL_REVIEW", "REJECT"]) {
  console.log(`${v.padEnd(24)} ${await countOf("job_candidacy", (q) => q.eq("verdict", v))}`);
}
console.log("\n=== APPLICATIONS ===");
console.log(`total:      ${await countOf("applications")}`);
console.log(`submitted:  ${await countOf("applications", (q) => q.not("submitted_at", "is", null))}`);
