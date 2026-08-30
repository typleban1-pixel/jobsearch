/** Full post-run report for the bulk extraction pass. Reads only. */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { classOfKind } from "../lib/scoring/kinds.ts";
import { checkGrounding } from "../lib/llm/grounding.ts";

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
const n = (x: any, w: number) => String(x).padStart(w);
const p = (x: any, w: number) => String(x).padEnd(w);

const jobs = await page("jobs", "id,eligibility,eligibility_reason,status,extracted_at,extraction_version,company_id,title");
const exts = await page("job_extractions", "id,job_id,extraction_version,succeeded,error,superseded_by,requirements_extracted");
const reqs = await page("job_requirements", "id,job_id,kind,is_hard_requirement,extraction_version,extraction_confidence,match_method,minimum_years");
const calls = await page("llm_calls", "id,purpose,succeeded,input_tokens,output_tokens,estimated_cost_cents,duration_ms",
  (q) => q.eq("purpose", "extract_requirements"));

console.log("=== RUN ===");
const ok = exts.filter((e: any) => e.succeeded);
const bad = exts.filter((e: any) => !e.succeeded);
console.log(`  job_extractions rows        ${exts.length}  (succeeded ${ok.length}, failed ${bad.length})`);
console.log(`  current (not superseded)    ${exts.filter((e: any) => !e.superseded_by).length}`);
console.log(`  superseded                  ${exts.filter((e: any) => e.superseded_by).length}`);
console.log(`  jobs marked extracted       ${jobs.filter((j: any) => j.extracted_at).length}`);
console.log(`  at extraction_version 2     ${jobs.filter((j: any) => j.extraction_version === 2).length}`);
console.log(`  at extraction_version 1     ${jobs.filter((j: any) => j.extraction_version === 1).length}`);
if (bad.length) for (const b of bad.slice(0, 10)) console.log(`    FAILED job ${b.job_id}: ${String(b.error).slice(0, 140)}`);

console.log("\n=== REQUIREMENTS ===");
const v2 = reqs.filter((r: any) => r.extraction_version === 2);
console.log(`  total                       ${reqs.length}  (v2: ${v2.length})`);
console.log(`  per job                     ${(v2.length / Math.max(1, jobs.filter((j: any) => j.extraction_version === 2).length)).toFixed(1)}`);
console.log(`  with minimum_years          ${v2.filter((r: any) => r.minimum_years !== null).length}`);
console.log(`  confidence <0.6             ${v2.filter((r: any) => +r.extraction_confidence < 0.6).length}`);

console.log("\n=== HARDNESS BY KIND (v2) ===");
const HARD = ["HARD", "PREFERRED", "UNCLEAR"] as const;
console.log(`  ${p("kind", 18)}${p("class", 17)}${HARD.map((h) => n(h, 11)).join("")}${n("total", 8)}${n("%HARD", 8)}`);
const kinds = [...new Set(v2.map((r: any) => r.kind))].sort();
const cls: Record<string, { t: number; h: number }> = {};
for (const k of kinds) {
  const kr = v2.filter((r: any) => r.kind === k);
  const c = classOfKind(k as string);
  const counts = HARD.map((h) => kr.filter((r: any) => r.is_hard_requirement === h).length);
  (cls[c] ??= { t: 0, h: 0 }).t += kr.length;
  cls[c]!.h += counts[0]!;
  console.log(`  ${p(k, 18)}${p(c, 17)}${counts.map((x) => n(x, 11)).join("")}${n(kr.length, 8)}${n(`${((counts[0]! * 100) / kr.length).toFixed(0)}%`, 8)}`);
}
const hTot = v2.filter((r: any) => r.is_hard_requirement === "HARD").length;
console.log(`  ${p("ALL", 35)}${HARD.map((h) => n(v2.filter((r: any) => r.is_hard_requirement === h).length, 11)).join("")}${n(v2.length, 8)}${n(`${((hTot * 100) / v2.length).toFixed(0)}%`, 8)}`);

console.log("\n=== CLASS DISTRIBUTION (v2) ===");
for (const [c, v] of Object.entries(cls).sort((a, b) => b[1].t - a[1].t)) {
  console.log(`  ${p(c, 18)}${n(v.t, 7)}  ${n(`${((v.t * 100) / v2.length).toFixed(1)}%`, 7)}  ${n(`${((v.h * 100) / v.t).toFixed(0)}% HARD`, 11)}`);
}
const sm = v2.filter((r: any) => classOfKind(r.kind) === "SKILL_MATCHABLE");
console.log(`\n  HARD among skill-matchable only: ${((sm.filter((r: any) => r.is_hard_requirement === "HARD").length * 100) / Math.max(1, sm.length)).toFixed(0)}%`);

console.log("\n=== ELIGIBILITY ===");
const byStatus: Record<string, number> = {};
for (const j of jobs.filter((x: any) => x.status === "OPEN")) byStatus[j.eligibility ?? "null"] = (byStatus[j.eligibility ?? "null"] ?? 0) + 1;
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) console.log(`  ${p(k, 14)}${n(v, 6)}`);

console.log("\n=== COST ===");
const okCalls = calls.filter((c: any) => c.succeeded);
const tin = okCalls.reduce((a: number, c: any) => a + (c.input_tokens ?? 0), 0);
const tout = okCalls.reduce((a: number, c: any) => a + (c.output_tokens ?? 0), 0);
const cents = okCalls.reduce((a: number, c: any) => a + Number(c.estimated_cost_cents ?? 0), 0);
console.log(`  llm_calls                   ${calls.length}  (succeeded ${okCalls.length}, failed ${calls.length - okCalls.length})`);
console.log(`  input tokens                ${tin.toLocaleString()}`);
console.log(`  output tokens               ${tout.toLocaleString()}`);
console.log(`  cost                        ${cents.toFixed(2)}c   $${(cents / 100).toFixed(2)}`);
console.log(`  mean latency                ${(okCalls.reduce((a: number, c: any) => a + (c.duration_ms ?? 0), 0) / Math.max(1, okCalls.length) / 1000).toFixed(1)}s`);

console.log("\n=== INVARIANTS ===");
const curByJob = new Map<string, number>();
for (const e of exts.filter((x: any) => !x.superseded_by)) curByJob.set(e.job_id, (curByJob.get(e.job_id) ?? 0) + 1);
const multiCurrent = [...curByJob.values()].filter((v) => v > 1).length;
const reqJobs = new Set(reqs.map((r: any) => r.job_id));
const reqVersionsPerJob = new Map<string, Set<number>>();
for (const r of reqs) {
  const s = reqVersionsPerJob.get(r.job_id) ?? new Set<number>();
  s.add(r.extraction_version); reqVersionsPerJob.set(r.job_id, s);
}
const mixedVersions = [...reqVersionsPerJob.values()].filter((s) => s.size > 1).length;
const extractedNoReqs = jobs.filter((j: any) => j.extracted_at && !reqJobs.has(j.id)).length;
const check = (name: string, okv: boolean, detail = "") =>
  console.log(`  ${okv ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
check("at most one current extraction per job", multiCurrent === 0, `${multiCurrent} with more than one`);
check("no job mixes requirement versions", mixedVersions === 0, `${mixedVersions} mixed`);
check("every superseded row points at a successor", exts.filter((e: any) => e.superseded_by).every((e: any) => exts.some((x: any) => x.id === e.superseded_by)));
check("one llm_call per successful extraction", okCalls.length === ok.length, `${okCalls.length} calls vs ${ok.length} extractions`);
// Not a pass/fail. A posting can legitimately have no requirements:
// talent-pool and evergreen listings ("VTS Talent Network",
// "TEMPLATE - US Tech") describe no role at all, and at least one real
// posting shipped with a "Plug in job spec" placeholder still in it.
// Zero is the correct extraction for those, so this reports rather than
// judges, and the titles are printed so a real miss is visible.
console.log(`  NOTE  ${extractedNoReqs} extracted jobs have zero requirements (review the titles below)`);
for (const j of jobs.filter((x: any) => x.extracted_at && !reqJobs.has(x.id))) {
  console.log(`          ${String(j.title).slice(0, 70)}`);
}
