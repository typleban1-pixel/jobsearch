/**
 * Verifies canonical-opening identity and the application guard.
 *
 * The regression cases are three real clusters from the corpus, each
 * chosen because a plausible dedupe rule gets it wrong:
 *   Brex     one requisition, five cities  -> one opening
 *   Stripe   two requisitions, identical text, same city -> two openings
 *   Flexport three requisitions, same title, three cities -> three openings
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const pg = async (t: string, c: string, x: (q: any) => any = (q) => q) => {
  const o: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await x(db.from(t).select(c)).order("id").range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break;
  } return o;
};

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

const jobs = await pg("jobs", "id,company_id,title,external_id,source,location_raw,status,canonical_opening_id");
const openings = await pg("openings", "id,company_id,source,identity_method,provider_opening_key,representative_title");
// Paged. An unranged select caps at 1000 rows, and discovery pushed the
// corpus past 2,700 companies: project44 fell off the end and this file
// reported a live, eligible job as "not found".
const cos = await pg("companies", "id,name");
const cn: Record<string, string> = Object.fromEntries(cos.map((c: any) => [c.id, c.name]));
const openById = new Map(openings.map((o: any) => [o.id, o]));

const open = jobs.filter((j: any) => j.status === "OPEN");
const byOpening = new Map<string, any[]>();
for (const j of open) { const a = byOpening.get(j.canonical_opening_id) ?? []; a.push(j); byOpening.set(j.canonical_opening_id, a); }
const multi = [...byOpening.entries()].filter(([, a]) => a.length > 1);

console.log("COUNTS");
console.log(`  jobs rows (all):                         ${jobs.length}`);
console.log(`  jobs rows (OPEN):                        ${open.length}`);
console.log(`  canonical openings created:              ${openings.length}`);
console.log(`    by provider opening id:                ${openings.filter((o: any) => o.identity_method === "PROVIDER_OPENING_ID").length}`);
console.log(`    singleton:                             ${openings.filter((o: any) => o.identity_method === "SINGLETON").length}`);
console.log(`  distinct OPEN openings:                  ${byOpening.size}`);
console.log(`  OPEN openings with >1 variant:           ${multi.length}`);
console.log(`  variants inside those:                   ${multi.reduce((s, [, a]) => s + a.length, 0)}`);
console.log(`  rows removed from the applyable count:   ${open.length - byOpening.size}  (source rows all preserved)`);
const multiLoc = multi.filter(([, a]) => new Set(a.map((j: any) => j.location_raw ?? "")).size > 1);
console.log(`  multi-LOCATION canonical openings:       ${multiLoc.length}`);

const { data: reviews } = await db.from("opening_duplicate_reviews").select("*");
console.log(`  ambiguous clusters flagged for review:   ${(reviews ?? []).length}`);
const byReason: Record<string, number> = {};
for (const r of reviews ?? []) { const k = r.reason.slice(0, 60); byReason[k] = (byReason[k] ?? 0) + 1; }
for (const [k, n] of Object.entries(byReason)) console.log(`      ${String(n).padStart(3)}  ${k}...`);
console.log(`  rows inside ambiguous clusters:          ${(reviews ?? []).reduce((s: number, r: any) => s + r.job_ids.length, 0)}`);

console.log("\nINVARIANTS");
check("every job has a canonical opening", jobs.every((j: any) => j.canonical_opening_id));
check("no opening spans more than one company",
  [...byOpening.entries()].every(([id, a]) => new Set(a.map((j: any) => j.company_id)).size === 1));
check("provider-identified openings all carry a key",
  openings.filter((o: any) => o.identity_method === "PROVIDER_OPENING_ID").every((o: any) => o.provider_opening_key));
check("singleton openings carry no key",
  openings.filter((o: any) => o.identity_method === "SINGLETON").every((o: any) => o.provider_opening_key === null));
check("no singleton opening has more than one job",
  [...byOpening.entries()].every(([id, a]) => a.length === 1 || (openById.get(id) as any).identity_method === "PROVIDER_OPENING_ID"));

console.log("\nREGRESSION CASES");
const group = (needle: string, company: string) =>
  open.filter((j: any) => j.title.includes(needle) && cn[j.company_id] === company);

const brex = group("Manager, CX AI Strategy", "Brex");
const brexOpenings = new Set(brex.map((j: any) => j.canonical_opening_id));
check(`Brex "Manager, CX AI Strategy": ${brex.length} variants collapse to 1 opening`,
  brex.length === 5 && brexOpenings.size === 1,
  `${brex.length} rows, ${brexOpenings.size} openings`);
for (const j of brex) console.log(`        ${j.external_id}  ${j.location_raw}`);
check("Brex variants keep their distinct locations",
  new Set(brex.map((j: any) => j.location_raw)).size === brex.length);

const stripe = group("Communities Partner Development", "Stripe");
const stripeOpenings = new Set(stripe.map((j: any) => j.canonical_opening_id));
check(`Stripe "Communities Partner Development Manager": ${stripe.length} rows stay ${stripe.length} openings`,
  stripe.length === 2 && stripeOpenings.size === 2,
  `${stripe.length} rows, ${stripeOpenings.size} openings`);
for (const j of stripe) console.log(`        ${j.external_id}  opening ${(openById.get(j.canonical_opening_id) as any)?.provider_opening_key}  ${j.location_raw}`);

const flex = group("Senior Ocean Operations Associate", "Flexport");
const flexOpenings = new Set(flex.map((j: any) => j.canonical_opening_id));
check(`Flexport "Senior Ocean Operations Associate": ${flex.length} rows stay ${flex.length} openings`,
  flex.length === flexOpenings.size && flex.length > 1,
  `${flex.length} rows, ${flexOpenings.size} openings`);
for (const j of flex) console.log(`        ${j.external_id}  ${j.location_raw}`);

// Identical titles at one company that are genuinely different requisitions
// must stay independently applyable.
const sameTitleDifferentOpening = (() => {
  const byTitle = new Map<string, Set<string>>();
  for (const j of open) {
    const k = `${j.company_id}|${j.title}`;
    const s = byTitle.get(k) ?? new Set(); s.add(j.canonical_opening_id); byTitle.set(k, s);
  }
  return [...byTitle.values()].filter((s) => s.size > 1).length;
})();
check(`identical titles that remain independently applyable: ${sameTitleDifferentOpening} title groups`,
  sameTitleDifferentOpening > 0);

console.log(`\n${failed === 0 ? "all passed" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
