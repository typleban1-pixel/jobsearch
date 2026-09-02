import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const page = async (t: string, c: string) => { const o: any[] = [];
  for (let f = 0; ; f += 1000) { const { data, error } = await db.from(t).select(c).order("id").range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break; } return o; };

// 1. Could a test application be submitted by the worker's "requested" path?
const apps = await page("applications", "id,job_id,status,is_test,human_approved,submitted_at,submit_requested_at,all_fields_confident");
const requested = apps.filter((a: any) => a.submit_requested_at && !a.submitted_at);
console.log(`applications with submit_requested_at set and unsubmitted: ${requested.length}`);
for (const a of requested) console.log(`   ${a.id.slice(0,8)} test=${a.is_test} approved=${a.human_approved} confident=${a.all_fields_confident}`);
const armed = requested.filter((a: any) => a.is_test && a.human_approved && a.all_fields_confident);
console.log(`   -> test applications that would be SUBMITTED by the worker: ${armed.length}`);

// 2. Which candidacy row does the worker's Map actually keep per job?
const cand = await page("job_candidacy", "id,job_id,verdict,model_version,profile_version");
const workerView = new Map<string, any>(cand.map((c: any) => [c.job_id, c]));
const byModel: Record<string, number> = {};
for (const [, c] of workerView) byModel[`model ${c.model_version} / v${c.profile_version}`] = (byModel[`model ${c.model_version} / v${c.profile_version}`] ?? 0) + 1;
console.log(`\nverdicts the worker would actually read, by version: ${JSON.stringify(byModel)}`);
const spot = workerView.get(cand.find((c: any) => c.job_id.startsWith("a3529df5"))!.job_id);
console.log(`   SpotHero as the worker sees it: model ${spot.model_version} -> ${spot.verdict}`);
console.log(`   SpotHero authoritative (model 4): ${cand.find((c: any) => c.job_id.startsWith("a3529df5") && c.model_version === 4)!.verdict}`);
const stale = [...workerView.values()].filter((c: any) => c.model_version !== 4 || c.profile_version !== 15).length;
console.log(`   jobs where the worker reads a NON-authoritative verdict: ${stale} of ${workerView.size}`);
