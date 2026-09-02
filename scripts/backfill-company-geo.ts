/**
 * Derives a company's geographic relevance from where it actually posts.
 *
 *   node scripts/backfill-company-geo.ts            dry run
 *   node scripts/backfill-company-geo.ts --commit
 *
 * `has_chicagoland_presence` and `hires_remote_us` have existed on
 * companies since the universe was built and have been null on all 2,716
 * rows, so every "prioritize Chicagoland" instruction has so far had
 * nothing behind it. Nothing here guesses: both flags are read off
 * job_locations rows that the normalizer already resolved, and a company
 * whose jobs carry no usable location stays null rather than false.
 *
 * The distinction matters. False means "it posts, and none of it is
 * here". Null means "nobody has looked", and those are different reasons
 * to rank a company lower.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const page = async <T,>(t: string, c: string, x: (q: any) => any = (q) => q): Promise<T[]> => {
  const o: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await x(db.from(t).select(c)).order("id").range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    o.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return o;
};

/**
 * Remote scopes a US-based applicant can actually take. NORTH AMERICA
 * includes the United States and is counted; every other scope names
 * somewhere this applicant cannot work from, and "unscoped remote" is
 * not evidence of a US-eligible role.
 */
const US_REMOTE = new Set(["US", "NORTH AMERICA"]);

const jobs = await page<{ id: string; company_id: string; status: string }>(
  "jobs", "id,company_id,status");
const open = jobs.filter((j) => j.status === "OPEN");
const byJob = new Map(open.map((j) => [j.id, j.company_id]));

const locations = await page<{
  job_id: string; metro: string | null; is_remote: boolean; remote_scope: string | null;
}>("job_locations", "id,job_id,metro,is_remote,remote_scope");

type Tally = { chicagoland: boolean; remoteUs: boolean; located: number };
const tally = new Map<string, Tally>();
for (const loc of locations) {
  const companyId = byJob.get(loc.job_id);
  if (!companyId) continue;                       // closed job, or a job that vanished
  const t = tally.get(companyId) ?? { chicagoland: false, remoteUs: false, located: 0 };
  t.located++;
  if (loc.metro === "Chicagoland") t.chicagoland = true;
  if (loc.is_remote && loc.remote_scope && US_REMOTE.has(loc.remote_scope.toUpperCase())) t.remoteUs = true;
  tally.set(companyId, t);
}

const companies = await page<{
  id: string; name: string; lifecycle: string;
  has_chicagoland_presence: boolean | null; hires_remote_us: boolean | null;
}>("companies", "id,name,lifecycle,has_chicagoland_presence,hires_remote_us");

const updates: Array<{ id: string; has_chicagoland_presence: boolean; hires_remote_us: boolean; name: string }> = [];
let unchanged = 0, noEvidence = 0;
for (const c of companies) {
  const t = tally.get(c.id);
  if (!t || t.located === 0) { noEvidence++; continue; }   // stays null on purpose
  if (c.has_chicagoland_presence === t.chicagoland && c.hires_remote_us === t.remoteUs) { unchanged++; continue; }
  updates.push({ id: c.id, name: c.name, has_chicagoland_presence: t.chicagoland, hires_remote_us: t.remoteUs });
}

console.log(`companies                ${companies.length}`);
console.log(`  with located open jobs ${companies.length - noEvidence}`);
console.log(`  no location evidence   ${noEvidence}  (left null, not false)`);
console.log(`  already correct        ${unchanged}`);
console.log(`  to update              ${updates.length}`);
console.log(`    Chicagoland presence ${updates.filter((u) => u.has_chicagoland_presence).length}`);
console.log(`    hires remote US      ${updates.filter((u) => u.hires_remote_us).length}`);
for (const u of updates.filter((x) => x.has_chicagoland_presence).slice(0, 10)) {
  console.log(`      ${u.name}`);
}

if (!commit) { console.log("\n(dry run: nothing written)"); process.exit(0); }

let written = 0;
for (const u of updates) {
  const { error } = await db.from("companies").update({
    has_chicagoland_presence: u.has_chicagoland_presence,
    hires_remote_us: u.hires_remote_us,
  }).eq("id", u.id);
  if (error) { console.error(`  ${u.name}: ${error.message}`); continue; }
  written++;
}
console.log(`\nwrote ${written} of ${updates.length}`);
