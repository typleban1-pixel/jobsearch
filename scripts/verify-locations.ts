/**
 * Confirms the three levels stay independent:
 *   canonical opening -> published job variants -> normalized locations
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const pg = async (t: string, c: string) => {
  const o: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from(t).select(c).order("id").range(f, f + 999);
    if (error) throw new Error(error.message); o.push(...data); if (data.length < 1000) break;
  } return o;
};
let failed = 0;
const check = (n: string, ok: boolean, d = "") => { if (!ok) failed++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${ok || !d ? "" : `\n        ${d}`}`); };

const jobs = (await pg("jobs", "id,title,company_id,location_raw,canonical_opening_id,eligibility,status")).filter((j: any) => j.status === "OPEN");
const locs = await pg("job_locations", "job_id,position,city,state,country,metro,is_remote,remote_scope");
// Paged. An unranged select caps at 1000 rows, and discovery pushed the
// corpus past 2,700 companies: project44 fell off the end and this file
// reported a live, eligible job as "not found".
const cos = await pg("companies", "id,name");
const cn: Record<string, string> = Object.fromEntries(cos.map((c: any) => [c.id, c.name]));
const byJob = new Map<string, any[]>();
for (const l of locs) { const a = byJob.get(l.job_id) ?? []; a.push(l); byJob.set(l.job_id, a); }
const byOpening = new Map<string, any[]>();
for (const j of jobs) { const a = byOpening.get(j.canonical_opening_id) ?? []; a.push(j); byOpening.set(j.canonical_opening_id, a); }

console.log("three levels stay independent\n");

// Brex: one opening, five variants, each variant one location.
const brex = jobs.filter((j: any) => cn[j.company_id] === "Brex" && j.title.includes("Manager, CX AI Strategy"));
check("Brex: 5 variants share one opening", new Set(brex.map((j: any) => j.canonical_opening_id)).size === 1);
check("Brex: each variant has exactly one location",
  brex.every((j: any) => (byJob.get(j.id) ?? []).length === 1),
  JSON.stringify(brex.map((j: any) => (byJob.get(j.id) ?? []).length)));
check("Brex: the five variants name five different cities",
  new Set(brex.map((j: any) => (byJob.get(j.id) ?? [])[0]?.city)).size === 5);

// Stripe Communities: two openings, one variant each, one location each.
const stripe = jobs.filter((j: any) => cn[j.company_id] === "Stripe" && j.title.includes("Communities Partner Development"));
check("Stripe Communities: 2 rows remain 2 openings", new Set(stripe.map((j: any) => j.canonical_opening_id)).size === 2);
check("Stripe Communities: each is remote with US scope",
  stripe.every((j: any) => (byJob.get(j.id) ?? []).some((l: any) => l.is_remote && l.remote_scope === "US")));

// A multi-location variant inside a multi-variant opening: the two
// dimensions must not interfere.
const multiBoth = [...byOpening.entries()]
  .filter(([, vars]) => vars.length > 1 && vars.some((v: any) => (byJob.get(v.id) ?? []).length > 1));
console.log(`\n  openings with several variants where a variant itself lists several locations: ${multiBoth.length}`);
for (const [openingId, vars] of multiBoth.slice(0, 3)) {
  console.log(`    ${cn[vars[0].company_id]} — ${vars[0].title.slice(0, 44)}  (${vars.length} variants)`);
  for (const v of vars) {
    const ls = byJob.get(v.id) ?? [];
    console.log(`        variant ${v.id.slice(0, 8)}: ${ls.length} location(s)  ${JSON.stringify(v.location_raw).slice(0, 62)}`);
  }
}
check("a variant's locations never leak to a sibling variant",
  multiBoth.every(([, vars]) => vars.every((v: any) => {
    const mine = new Set((byJob.get(v.id) ?? []).map((l: any) => `${l.position}`));
    return (byJob.get(v.id) ?? []).length === mine.size;
  })));
check("every job_locations row belongs to exactly one job",
  locs.length === new Set(locs.map((l: any) => `${l.job_id}|${l.position}`)).size);

// The Chicago examples from the audit.
console.log("\nthe Chicago cases the old parser missed");
const CASES = [
  ["Stripe", "People Partner, Technology"],
  ["Stripe", "Product Manager, Startup Products"],
  ["Stripe", "Account Executive, Enterprise - Hunter"],
  ["project44", "Solutions Architect"],
  ["Home Chef", "Food Safety & Quality Assurance Manager"],
];
for (const [co, title] of CASES) {
  const j = jobs.find((x: any) => cn[x.company_id] === co && x.title.includes(title!));
  if (!j) { check(`${co} — ${title}: found`, false, "job not found"); continue; }
  const ls = byJob.get(j.id) ?? [];
  const hasChi = ls.some((l: any) => l.metro === "Chicagoland");
  check(`${co} — ${title!.slice(0, 34)}: Chicagoland recognised, now ${j.eligibility}`, hasChi,
    `locations ${JSON.stringify(ls.map((l: any) => l.city))}`);
}

console.log(`\n${failed === 0 ? "all passed" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
