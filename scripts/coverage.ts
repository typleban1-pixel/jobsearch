/**
 * Where the corpus actually comes from.
 *
 *   node scripts/coverage.ts
 *
 * The universe was 99% one accelerator directory, which nothing in the
 * system reported and nobody would have noticed. These are the numbers
 * that make dependence on a single source visible while it is still
 * cheap to fix, and that show whether new platforms are contributing
 * jobs or merely existing.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const page = async <T,>(t: string, c: string): Promise<T[]> => {
  const o: T[] = [];
  for (let x = 0; ; x += 1000) {
    const { data, error } = await db.from(t).select(c).order("id").range(x, x + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    o.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return o;
};

const [companies, jobs, locations, candidacy, apps, sources] = await Promise.all([
  page<any>("companies", "id,name,discovery_source,discovery_method,lifecycle,ats_provider,ats_token"),
  page<any>("jobs", "id,company_id,source,status,eligibility,canonical_opening_id"),
  page<any>("job_locations", "id,job_id,metro,is_remote,remote_scope"),
  page<any>("job_candidacy", "id,job_id,verdict"),
  page<any>("applications", "id,job_id,status,submitted_at,is_test"),
  page<any>("company_sources", "id,label,companies_found,last_run_at"),
]);

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const num = (s: string | number, n = 6) => String(s).padStart(n);
const rule = (t: string) => console.log(`\n${t}\n${"-".repeat(t.length)}`);

// ---- employers by where they came from --------------------------------
rule("Employers by discovery source");
const bySource = new Map<string, number>();
for (const c of companies) bySource.set(c.discovery_source ?? "(hand-seeded)", (bySource.get(c.discovery_source ?? "(hand-seeded)") ?? 0) + 1);
const total = companies.length;
for (const [k, v] of [...bySource].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${num(v)}  ${pad(`${((100 * v) / total).toFixed(1)}%`, 7)} ${k}`);
}
console.log(`  ${num(total)}  total`);
const yc = bySource.get("Y Combinator company directory") ?? 0;
console.log(`\n  single-source dependence: ${((100 * yc) / total).toFixed(1)}% from the largest source`);

// ---- platforms ---------------------------------------------------------
rule("Platform coverage");
const openJobs = jobs.filter((j) => j.status === "OPEN");
const byJob = new Map(jobs.map((j) => [j.id, j]));
const chicago = new Set<string>(), remoteUs = new Set<string>();
for (const l of locations) {
  if (l.metro === "Chicagoland") chicago.add(l.job_id);
  if (l.is_remote && ["US", "NORTH AMERICA"].includes(String(l.remote_scope ?? "").toUpperCase())) remoteUs.add(l.job_id);
}
const verdict = new Map(candidacy.map((c) => [c.job_id, c.verdict]));
const liveApps = apps.filter((a) => !a.is_test);
const appJobs = new Set(liveApps.map((a) => a.job_id));
const submitted = new Set(liveApps.filter((a) => a.submitted_at).map((a) => a.job_id));

console.log(`  ${pad("platform", 13)}${num("boards")}${num("open")}${num("chi")}${num("remote")}${num("elig")}${num("cand")}${num("strch")}${num("apps")}${num("sub")}`);
for (const p of ["GREENHOUSE", "LEVER", "ASHBY", "WORKDAY"]) {
  const mine = openJobs.filter((j) => j.source === p);
  const elig = mine.filter((j) => j.eligibility === "ELIGIBLE");
  const boards = companies.filter((c) => c.ats_provider === p && c.ats_token).length;
  console.log(
    `  ${pad(p, 13)}${num(boards)}${num(mine.length)}${num(mine.filter((j) => chicago.has(j.id)).length)}` +
    `${num(mine.filter((j) => remoteUs.has(j.id)).length)}${num(elig.length)}` +
    `${num(elig.filter((j) => verdict.get(j.id) === "APPLICATION_CANDIDATE").length)}` +
    `${num(elig.filter((j) => verdict.get(j.id) === "STRETCH").length)}` +
    `${num(mine.filter((j) => appJobs.has(j.id)).length)}${num(mine.filter((j) => submitted.has(j.id)).length)}`,
  );
}
console.log(`  ${pad("(total)", 13)}${num(companies.filter((c) => c.ats_token).length)}${num(openJobs.length)}` +
  `${num(openJobs.filter((j) => chicago.has(j.id)).length)}${num(openJobs.filter((j) => remoteUs.has(j.id)).length)}` +
  `${num(openJobs.filter((j) => j.eligibility === "ELIGIBLE").length)}` +
  `${num([...verdict.values()].filter((v) => v === "APPLICATION_CANDIDATE").length)}` +
  `${num([...verdict.values()].filter((v) => v === "STRETCH").length)}${num(appJobs.size)}${num(submitted.size)}`);

// ---- resolution yield --------------------------------------------------
rule("Resolution");
const discovered = companies.filter((c) => c.lifecycle === "DISCOVERED").length;
const active = companies.filter((c) => c.lifecycle === "ACTIVE").length;
const withToken = companies.filter((c) => c.ats_token).length;
console.log(`  ${num(discovered)}  employers waiting to be checked for a board`);
console.log(`  ${num(active)}  active`);
console.log(`  ${num(withToken)}  with a validated board or tenant`);
console.log(`  ${num(`${((100 * withToken) / Math.max(1, withToken + discovered)).toFixed(1)}%`)}  yield so far`);

// ---- duplicates --------------------------------------------------------
rule("Duplicate openings");
const perOpening = new Map<string, Set<string>>();
for (const j of openJobs) {
  if (!j.canonical_opening_id) continue;
  const set = perOpening.get(j.canonical_opening_id) ?? new Set<string>();
  set.add(j.source);
  perOpening.set(j.canonical_opening_id, set);
}
const crossSource = [...perOpening.values()].filter((s) => s.size > 1).length;
console.log(`  ${num(perOpening.size)}  openings with a canonical id`);
console.log(`  ${num(crossSource)}  spanning more than one platform`);
if (!crossSource) console.log("       none yet, which is expected until two platforms cover the same employer");

rule("Sources last swept");
for (const s of sources.sort((a, b) => String(b.last_run_at).localeCompare(String(a.last_run_at)))) {
  console.log(`  ${pad(String(s.last_run_at ?? "never").slice(0, 10), 12)} ${num(s.companies_found)}  ${s.label}`);
}
console.log("");
