/**
 * The cheap prefilter step: from OPEN + ELIGIBLE jobs, keep the ones a title
 * says are plausibly in this person's functions and level, and write their
 * ids for a targeted, low-cost extraction. Deterministic, no model call.
 *
 *   node scripts/select-plausible.ts --out /tmp/plausible.txt [--include-uncertain]
 *
 * Prints a funnel (eligible -> plausible -> excluded, with reasons) so the
 * cost-per-candidate accounting has a denominator. Leaving out UNCERTAIN by
 * default keeps the unattended batch small; --include-uncertain widens it.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { writeFileSync } from "node:fs";
import { isPlausibleJob } from "../lib/discovery/plausibleFilter.ts";
import { EXTRACTION_VERSION } from "../lib/llm/extractRequirements.ts";

const outIdx = process.argv.indexOf("--out");
const out = outIdx > -1 ? process.argv[outIdx + 1] : null;
const includeUncertain = process.argv.includes("--include-uncertain");
const onlyUnextracted = !process.argv.includes("--all"); // default: only jobs that still need a call
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

async function page<T>(t: string, sel: string, filt: (q: any) => any): Promise<T[]> {
  const rows: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await filt(db.from(t).select(sel)).range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    if (!data?.length) break; rows.push(...data); if (data.length < 1000) break;
  }
  return rows;
}

const elig = includeUncertain ? ["ELIGIBLE", "UNCERTAIN"] : ["ELIGIBLE"];
const jobs = await page<any>("jobs", "id,title,status,eligibility",
  (q) => q.eq("status", "OPEN").in("eligibility", elig));

// Latest job_version per job for structured seniority / IC signal.
const vids = jobs.map((j) => j.id);
const versions = new Map<string, { seniority: string | null; isIC: boolean | null }>();
for (let i = 0; i < vids.length; i += 200) {
  const rows = await page<any>("job_versions", "job_id,seniority,is_individual_contributor,version_number",
    (q) => q.in("job_id", vids.slice(i, i + 200)).order("version_number", { ascending: false }));
  for (const r of rows) if (!versions.has(r.job_id)) versions.set(r.job_id, { seniority: r.seniority, isIC: r.is_individual_contributor });
}

// Jobs that already have a current-version successful extraction -- never
// pay to redo them. Only NEW/uncovered plausible postings should extract.
const extracted = new Set<string>();
if (onlyUnextracted) {
  const rows = await page<any>("job_extractions", "job_id,extraction_version,succeeded,superseded_by",
    (q) => q.is("superseded_by", null).eq("succeeded", true));
  for (const r of rows) if (r.extraction_version === EXTRACTION_VERSION) extracted.add(r.job_id);
}

const plausibleIds: string[] = [];
const reasons: Record<string, number> = {};
for (const j of jobs) {
  const v = versions.get(j.id) ?? {};
  const verdict = isPlausibleJob({ title: j.title ?? "", seniority: (v as any).seniority, isIC: (v as any).isIC });
  const key = (verdict.plausible ? "KEEP: " : "DROP: ") + verdict.reason;
  reasons[key] = (reasons[key] ?? 0) + 1;
  if (verdict.plausible) {
    if (onlyUnextracted && extracted.has(j.id)) { reasons["SKIP: already extracted (current version)"] = (reasons["SKIP: already extracted (current version)"] ?? 0) + 1; continue; }
    plausibleIds.push(j.id);
  }
}

console.log(`plausibility prefilter over ${jobs.length} OPEN ${elig.join("/")} job(s)`);
for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
console.log(`\nplausible: ${plausibleIds.length} of ${jobs.length} (${((plausibleIds.length / Math.max(1, jobs.length)) * 100).toFixed(0)}%)`);
if (out) { writeFileSync(out, plausibleIds.join("\n") + "\n"); console.log(`wrote ${plausibleIds.length} ids -> ${out}`); }
else console.log("(no --out; nothing written)");
