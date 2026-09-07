/**
 * Abandons an application on the person's instruction, and says why.
 *
 *   node --env-file=.env.local scripts/abandon-application.ts <application_id> --reason "<their words>" [--exclude-job] [--commit]
 *
 * "No, do not do Chartis" is a decision about one posting, and it has to
 * outlive the row it is made on: a closed application never blocks its job
 * from a fresh attempt, so the worker would prepare the same posting again
 * the next time it was selected. --exclude-job records the decision where
 * selection reads it (automation_policy.excluded_job_ids), so the job is
 * skipped from then on. Nothing submitted is ever touched.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const id = process.argv[2];
const arg = (k: string): string | null => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };
const reason = arg("reason");
const commit = process.argv.includes("--commit");
const excludeJob = process.argv.includes("--exclude-job");
if (!id || !reason) { console.error('usage: abandon-application.ts <application_id> --reason "<why>" [--exclude-job] [--commit]'); process.exit(2); }

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const { data: app } = await db.from("applications").select("id,job_id,status,submitted_at").eq("id", id).maybeSingle();
if (!app) { console.error("no such application"); process.exit(1); }
if (app.submitted_at) { console.error(`refusing: submitted at ${app.submitted_at}; a sent application is not abandoned, it is history`); process.exit(1); }
const { data: job } = await db.from("jobs").select("title,companies(name)").eq("id", app.job_id).single();
console.log(`${(job as any)?.companies?.name} — ${job?.title}`);
console.log(`  application ${id.slice(0, 8)} is ${app.status}; will be ABANDONED${excludeJob ? ", and job " + app.job_id.slice(0, 8) + " excluded from automation" : ""}`);
console.log(`  reason: ${reason}`);
if (!commit) { console.log("\ndry run; pass --commit to write"); process.exit(0); }

const { error } = await db.from("applications").update({ status: "ABANDONED", outcome_note: `Abandoned by the person: ${reason}` }).eq("id", id);
if (error) { console.error(`could not abandon: ${error.message}`); process.exit(1); }
await db.from("application_events").insert({
  application_id: id, event: "ABANDONED_BY_PERSON", actor: "user:plebantyler@gmail.com",
  detail: `Abandoned on the person's instruction: ${reason}${excludeJob ? " The job is excluded from automation." : ""}`,
});
if (excludeJob) {
  const { data: policy } = await db.from("automation_policy").select("id,excluded_job_ids").limit(1).single();
  const ids = [...new Set([...(policy?.excluded_job_ids ?? []), app.job_id])];
  const { error: pErr } = await db.from("automation_policy").update({ excluded_job_ids: ids }).eq("id", policy!.id);
  if (pErr) { console.error(`abandoned, but the job could not be excluded: ${pErr.message}`); process.exit(1); }
  console.log(`  excluded jobs now: ${ids.length}`);
}
console.log("\ndone");
