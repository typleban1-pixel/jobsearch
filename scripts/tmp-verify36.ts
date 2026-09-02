import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const SP = "/private/tmp/claude-501/-Users-plebant/bbd705c3-ed87-4c9b-9ffc-d255f95eb993/scratchpad";
const plan = JSON.parse(readFileSync(`${SP}/plan36.json`, "utf8"));
const ids: string[] = plan.jobs.map((j: any) => j.id);
const leaders = new Set<string>(plan.leaders);
const followerOf = new Map<string, string>();
for (const [l, fs] of plan.followers) for (const f of fs) followerOf.set(f, l);

const { data: jobs } = await db.from("jobs")
  .select("id,title,extracted_at,extraction_version,extraction_source_job_id,extraction_reuse_hash,description_hash").in("id", ids);
const byId = new Map((jobs ?? []).map((j: any) => [j.id, j]));

// 1. actual model calls
const { count: after } = await db.from("llm_calls").select("*", { count: "exact", head: true });
const { data: newCalls } = await db.from("llm_calls").select("subject_id,estimated_cost_cents,succeeded")
  .gt("called_at", "2026-09-02T22:00:00Z");
console.log(`llm_calls: 4118 -> ${after}  (new: ${(newCalls ?? []).length})`);
const cost = (newCalls ?? []).reduce((n: number, c: any) => n + Number(c.estimated_cost_cents ?? 0), 0);
console.log(`actual cost: $${(cost/100).toFixed(4)}   approved ceiling $0.36`);
const callSubjects = new Set((newCalls ?? []).map((c: any) => c.subject_id));
console.log(`\ndistinct jobs that produced a model call: ${callSubjects.size}`);
console.log(`  all were planned leaders: ${[...callSubjects].every((s) => leaders.has(s as string))}`);
const followerCalls = [...callSubjects].filter((s) => followerOf.has(s as string));
console.log(`  FOLLOWER model calls (must be 0): ${followerCalls.length}`);

// 2. followers got the leader's rows
const { data: reqs } = await db.from("job_requirements")
  .select("job_id,kind,raw_text,normalized_term,is_hard_requirement,minimum_years,extraction_version,extracted_by").in("job_id", ids);
const byJob = new Map<string, any[]>();
for (const r of reqs ?? []) byJob.set(r.job_id, [...(byJob.get(r.job_id) ?? []), r]);
const sig = (rows: any[]) => createHash("sha256").update(JSON.stringify(
  [...rows].map((r) => [r.kind, r.raw_text, r.normalized_term, r.is_hard_requirement, r.minimum_years, r.extraction_version, r.extracted_by])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest("hex");
let matched = 0, mismatched = 0, missing = 0;
for (const [f, l] of followerOf) {
  const fr = byJob.get(f), lr = byJob.get(l);
  if (!fr || !lr) { missing++; continue; }
  if (sig(fr) === sig(lr)) matched++; else { mismatched++; console.log(`  MISMATCH follower ${f.slice(0,8)} vs leader ${l.slice(0,8)}`); }
}
console.log(`\nfollowers whose rows match their leader EXACTLY: ${matched}`);
console.log(`  mismatched: ${mismatched}   not extracted (leader failed): ${missing}`);

// 3. provenance
let provOk = 0, provBad = 0;
for (const [f, l] of followerOf) {
  const j: any = byId.get(f);
  if (!j?.extraction_source_job_id) continue;
  if (j.extraction_source_job_id === l && j.extraction_reuse_hash === j.description_hash) provOk++;
  else { provBad++; console.log(`  BAD PROVENANCE ${f.slice(0,8)}: src=${String(j.extraction_source_job_id).slice(0,8)} hash=${j.extraction_reuse_hash === j.description_hash}`); }
}
console.log(`\nprovenance correct: ${provOk}   incorrect: ${provBad}`);
const leadersWithProv = [...leaders].filter((l) => byId.get(l)?.extraction_source_job_id).length;
console.log(`leaders wrongly carrying reuse provenance (must be 0): ${leadersWithProv}`);

// 4. model/version consistency
const allRows = (reqs ?? []);
const vers = new Set(allRows.map((r: any) => r.extraction_version));
const models = new Set(allRows.map((r: any) => r.extracted_by));
console.log(`\nrequirement rows: ${allRows.length}; versions ${JSON.stringify([...vers])}; extracted_by ${JSON.stringify([...models])}`);

// 5. submitted applications
const { data: subs } = await db.from("applications").select("id,status,submitted_at,resume_id,approved_artifact_sha256,approved_answers_sha256").not("submitted_at", "is", null).order("id");
console.log(`\nsubmitted: ${subs?.length}  fingerprint ${createHash("sha256").update(JSON.stringify(subs)).digest("hex").slice(0,16)}  (was 37f6621c0b0117b2)`);

// 6. still-pending
const stillPending = ids.filter((i) => !byId.get(i)?.extracted_at);
console.log(`still pending (leader failed / zero-length description): ${stillPending.length}`);
for (const i of stillPending) console.log(`   ${byId.get(i)?.title}`);
