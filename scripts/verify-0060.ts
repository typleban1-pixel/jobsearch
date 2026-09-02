/**
 * Candidacy, after the migration. Read-only unless a check needs a
 * failed write, which by definition leaves nothing behind.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { CANDIDACY_MODEL_VERSION } from "../lib/scoring/candidacy.ts";
import { TAXONOMY_VERSION } from "../lib/scoring/requirementClass.ts";
import { FIT_FORMULA_VERSION } from "../lib/scoring/fit.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}\n         ${d}`); }
};
const page = async (t: string, c: string, f: (q: any) => any = (q) => q) => {
  const o: any[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await f(db.from(t).select(c)).range(i, i + 999);
    if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break;
  }
  return o;
};

// ---- 1. the tables exist with the expected shape ----------------------
const probe = await db.from("job_candidacy").select("*").limit(1);
check("job_candidacy exists", !probe.error, probe.error?.message ?? "");
const COLS = ["id", "job_id", "verdict", "reason_codes", "reason", "profile_version", "formula_version",
  "taxonomy_version", "model_version", "hard_met", "hard_total", "direct_matches", "transferable_matches",
  "baseline_met", "occupational", "core_gaps", "gating_gaps", "unknown_gates", "created_at"];
const got = Object.keys(probe.data?.[0] ?? {});
check("every expected column is present", COLS.every((c) => got.includes(c)),
  `missing: ${COLS.filter((c) => !got.includes(c)).join(", ")}`);
const ov = await db.from("candidacy_overrides").select("*").limit(1);
check("candidacy_overrides exists", !ov.error, ov.error?.message ?? "");

// The verdict CHECK constraint. A failed insert writes nothing.
{
  const { data: anyJob } = await db.from("jobs").select("id").limit(1).single();
  const bad = await db.from("job_candidacy").insert({ job_id: anyJob!.id, verdict: "MAYBE", reason: "x",
    profile_version: 12, formula_version: 3, taxonomy_version: 4, model_version: 3,
    hard_met: 0, hard_total: 0, direct_matches: 0, transferable_matches: 0, baseline_met: 0 });
  check("the verdict check constraint rejects an unknown value", Boolean(bad.error), "an invalid verdict was accepted");
  const emptyReason = await db.from("candidacy_overrides").insert({ job_id: anyJob!.id, invoked_by: "test", reason: "   " });
  check("an override with a blank reason is refused", Boolean(emptyReason.error), "a blank reason was accepted");
}

// ---- 2. coverage and distribution -------------------------------------
const jobs = (await page("jobs", "id,title,status,eligibility")).filter((j: any) => j.status === "OPEN" && j.eligibility === "ELIGIBLE");
const { data: prof } = await db.from("profile").select("profile_version").single();
const rows = await page("job_candidacy", "id,job_id,verdict,reason_codes,profile_version,formula_version,taxonomy_version,model_version");
const current = rows.filter((r: any) => r.profile_version === prof!.profile_version
  && r.formula_version === FIT_FORMULA_VERSION && r.taxonomy_version === TAXONOMY_VERSION && r.model_version === CANDIDACY_MODEL_VERSION);
console.log(`\n  live state: profile v${prof!.profile_version}, formula ${FIT_FORMULA_VERSION}, taxonomy ${TAXONOMY_VERSION}, model ${CANDIDACY_MODEL_VERSION}`);
console.log(`  job_candidacy rows: ${rows.length} total, ${current.length} at the current state\n`);
check("every eligible job has a current verdict", new Set(current.map((r: any) => r.job_id)).size === jobs.length,
  `${new Set(current.map((r: any) => r.job_id)).size} of ${jobs.length}`);
check("687 eligible jobs", jobs.length === 687, String(jobs.length));
const eligibleIds = new Set(jobs.map((j: any) => j.id));
check("no current verdict belongs to an ineligible job",
  current.every((r: any) => eligibleIds.has(r.job_id)), "");

const dist: Record<string, number> = {};
for (const r of current) dist[r.verdict] = (dist[r.verdict] ?? 0) + 1;
console.log(`  distribution: ${JSON.stringify(dist)}`);
check("APPLICATION_CANDIDATE = 1", dist["APPLICATION_CANDIDATE"] === 1, String(dist["APPLICATION_CANDIDATE"] ?? 0));
check("STRETCH = 58", dist["STRETCH"] === 58, String(dist["STRETCH"] ?? 0));
check("REJECT = 628", dist["REJECT"] === 628, String(dist["REJECT"] ?? 0));
check("MANUAL_REVIEW = 0", (dist["MANUAL_REVIEW"] ?? 0) === 0, String(dist["MANUAL_REVIEW"] ?? 0));

const key = (r: any) => `${r.job_id}|${r.profile_version}|${r.formula_version}|${r.taxonomy_version}|${r.model_version}`;
const seen = new Map<string, number>();
for (const r of rows) seen.set(key(r), (seen.get(key(r)) ?? 0) + 1);
const dupes = [...seen.entries()].filter(([, n]) => n > 1);
check("no duplicate row for the same job and version tuple", dupes.length === 0, JSON.stringify(dupes.slice(0, 3)));

// The unique index, tested by trying to violate it.
{
  const one = current[0]!;
  const clash = await db.from("job_candidacy").insert({ job_id: one.job_id, verdict: "REJECT", reason: "duplicate probe",
    profile_version: one.profile_version, formula_version: one.formula_version,
    taxonomy_version: one.taxonomy_version, model_version: one.model_version,
    hard_met: 0, hard_total: 0, direct_matches: 0, transferable_matches: 0, baseline_met: 0 });
  check("the unique version key refuses a second current row", Boolean(clash.error), "a duplicate was accepted");
}

// ---- 3. the named jobs -------------------------------------------------
const byJob = new Map(current.map((r: any) => [r.job_id, r]));
const named: Array<[string, string, string]> = [
  ["Menu Strategy Analyst", "APPLICATION_CANDIDATE", "MEETS_HARD_REQUIREMENTS"],
  ["Regional Implementation Manager", "STRETCH", "OCCUPATIONAL_GAP"],
  ["Customer Success Manager II", "STRETCH", "OCCUPATIONAL_GAP"],
  ["Legal Operations Specialist/Senior", "REJECT", "MULTIPLE_CORE_GAPS"],
  ["Principal Engineer, Streaming", "REJECT", "CORE_GAP_WITHOUT_SUPPORT"],
];
console.log();
for (const [title, verdict, code] of named) {
  const j = jobs.find((x: any) => x.title.startsWith(title));
  const r = j ? byJob.get(j.id) : null;
  check(`${title.slice(0, 40)} is ${verdict} / ${code}`,
    Boolean(r) && r.verdict === verdict && (r.reason_codes ?? [])[0] === code,
    r ? `${r.verdict} / ${(r.reason_codes ?? [])[0]}` : "no persisted row");
}

// ---- 4. no side effects ------------------------------------------------
const { count: apps } = await db.from("applications").select("*", { count: "exact", head: true });
check("still exactly 2 applications", apps === 2, String(apps));
const { data: sh } = await db.from("applications").select("status,resume_id,human_approved,approved_artifact_sha256")
  .eq("id", "9af26bee-dd8d-4e8d-b037-a224a5be24aa").single();
check("the SpotHero application is untouched",
  sh!.status === "READY_TO_SUBMIT" && sh!.resume_id === "4f350897-8ce1-4137-9ee2-f8360857abdd"
  && sh!.human_approved === true && sh!.approved_artifact_sha256 === "c4ba2ccedfead2f85959cac862df3744c91978ead53a4da76a46bc9948a0e9d1",
  JSON.stringify(sh));
const { count: overrides } = await db.from("candidacy_overrides").select("*", { count: "exact", head: true });
check("no override rows exist yet", overrides === 0, String(overrides));

console.log(`\n${pass + fails.length} checks, ${pass} passed`);
for (const f of fails) console.log(`  ${f}`);
if (fails.length) process.exit(1);
console.log("0060 verified");
