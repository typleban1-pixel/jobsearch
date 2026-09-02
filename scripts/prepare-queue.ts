/**
 * Completes DRAFT applications, on the machine that holds the model key.
 *
 *   node scripts/prepare-queue.ts              dry run, reports only
 *   node scripts/prepare-queue.ts --commit     prepare for real
 *   node scripts/prepare-queue.ts --limit 5 --commit
 *
 * The portal creates a DRAFT when you decide to apply and freezes the
 * posting version. It cannot do more: snapshotting the employer's form
 * and tailoring the resume need an Anthropic key, and the deployed
 * portal deliberately has none.
 */
import { createClient } from "@supabase/supabase-js";
import { required, optional } from "../lib/env.ts";
import { prepareApplication } from "../lib/applications/prepare.ts";
import { AnthropicProvider } from "../lib/llm/anthropic.ts";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const commit = process.argv.includes("--commit");
const limit = arg("limit", 10);
const useLlm = !process.argv.includes("--no-llm") && Boolean(optional("ANTHROPIC_API_KEY"));

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });
const llm = useLlm ? new AnthropicProvider() : null;

const { data: drafts, error } = await db.from("applications")
  .select("id,job_id,created_at").eq("status", "DRAFT").eq("is_test", false)
  .order("created_at").limit(limit);
if (error) throw new Error(error.message);

console.log(`${drafts?.length ?? 0} draft application(s) to prepare`);
console.log(`resume tailoring: ${llm ? "model-assisted" : "master wording only (no model)"}`);
if (!commit) console.log("dry run: pass --commit to write\n");

for (const d of drafts ?? []) {
  const { data: job } = await db.from("jobs").select("title,company_id").eq("id", d.job_id).single();
  const { data: co } = job ? await db.from("companies").select("name").eq("id", job.company_id).single() : { data: null };
  const label = `${co?.name ?? "?"} — ${job?.title ?? "?"}`;

  if (!commit) { console.log(`  would prepare ${label}`); continue; }

  const r = await prepareApplication(db, d.job_id, llm, d.id);
  if (r.refusedReason) {
    console.log(`  NOT PREPARED  ${label}\n      ${r.refusedReason}`);
    // A posting whose form cannot be snapshotted is not a failed
    // application, it is one that needs the browser. It stays DRAFT.
    await db.from("applications").update({ blocked_reason: r.refusedReason }).eq("id", d.id);
    continue;
  }
  console.log(`  ${r.status.padEnd(20)} ${label}`);
  console.log(`      resume: ${r.tailoring.accepted} lines accepted, ${r.tailoring.rejected} refused by a guard, ${r.tailoring.fellBack} fell back to master wording`);
  console.log(`      fields: ${r.answered} answered, ${r.blocked} blocked, ${r.skipped} skipped`);
}
