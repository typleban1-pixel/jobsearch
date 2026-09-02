import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { planExtraction } from "../lib/llm/extractionDedup.ts";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const page = async (t: string, c: string) => { const o: any[] = [];
  for (let x = 0; ; x += 1000) { const { data, error } = await db.from(t).select(c).order("id").range(x, x + 999);
    if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break; } return o; };
const jobs = await page("jobs", "id,title,status,eligibility,extracted_at,description_hash");
const pending = jobs.filter((j: any) => j.status === "OPEN" && j.eligibility === "ELIGIBLE" && !j.extracted_at);
const plan = planExtraction(pending.map((j: any) => ({ id: j.id, descriptionHash: j.description_hash })));
writeFileSync("/private/tmp/claude-501/-Users-plebant/bbd705c3-ed87-4c9b-9ffc-d255f95eb993/scratchpad/pending36.txt",
  pending.map((j: any) => j.id).join("\n"));
writeFileSync("/private/tmp/claude-501/-Users-plebant/bbd705c3-ed87-4c9b-9ffc-d255f95eb993/scratchpad/plan36.json",
  JSON.stringify({ jobs: pending.map((j: any) => ({ id: j.id, hash: j.description_hash, title: j.title })),
    leaders: plan.leaders.map((l) => l.id), followers: [...plan.followers].map(([k, v]) => [k, v.map((x) => x.id)]) }, null, 1));
console.log(`pending ${pending.length}, leaders ${plan.leaders.length}, followers ${plan.reused}`);
const { count: calls } = await db.from("llm_calls").select("*", { count: "exact", head: true });
console.log(`llm_calls BEFORE: ${calls}`);
const { data: subs } = await db.from("applications").select("id,status,submitted_at,resume_id,approved_artifact_sha256,approved_answers_sha256").not("submitted_at", "is", null).order("id");
console.log(`submitted BEFORE: ${subs?.length}  fingerprint ${createHash("sha256").update(JSON.stringify(subs)).digest("hex").slice(0,16)}`);
