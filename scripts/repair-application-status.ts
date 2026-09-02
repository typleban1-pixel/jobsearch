/**
 * Moves applications out of BLOCKED_NEEDS_INPUT once nothing is blocked.
 *
 *   node scripts/repair-application-status.ts [--write]
 *
 * The status was only ever advanced by the answer route, at the moment it
 * cleared the last blocked field. Every other way a block can clear --
 * leaving a field blank, a resolver fix re-running, two answers saved at
 * once -- left the column behind, so the portal said "needs your answers"
 * about applications with nothing blocked.
 *
 * Rather than teach each write path to remember, this reconciles the
 * column against the answers, which are the actual truth.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const write = process.argv.includes("--write");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: apps } = await db.from("applications")
  .select("id,job_id,status,all_fields_confident")
  .eq("status", "BLOCKED_NEEDS_INPUT");

if (!apps?.length) { console.log("nothing sitting in BLOCKED_NEEDS_INPUT"); process.exit(0); }

const { data: jobs } = await db.from("jobs").select("id,title");
const title = new Map((jobs ?? []).map((j) => [j.id, j.title]));
let moved = 0;

for (const a of apps) {
  const { count } = await db.from("application_answers")
    .select("id", { count: "exact", head: true })
    .eq("application_id", a.id).eq("confidence_state", "BLOCKED");
  const name = String(title.get(a.job_id) ?? a.id).slice(0, 52);
  if ((count ?? 0) > 0) { console.log(`  still blocked (${count})  ${name}`); continue; }

  moved++;
  console.log(`  ready for review          ${name}`);
  if (!write) continue;
  const { error } = await db.from("applications")
    .update({ status: "AWAITING_REVIEW" }).eq("id", a.id);
  if (error) { console.log(`      could not move: ${error.message}`); continue; }
  await db.from("application_events").insert({
    application_id: a.id, event: "STATUS_RECONCILED",
    detail: "Nothing was blocked any more, but the status still said BLOCKED_NEEDS_INPUT. "
      + "Moved to AWAITING_REVIEW to match the answers.",
    actor: "system",
  });
}

console.log(write ? `\nmoved ${moved}` : `\n${moved} would move. Pass --write.`);
