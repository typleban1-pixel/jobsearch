/**
 * Fulfilling the reuse requests made in the queue.
 *
 *   node scripts/promote-answers.ts --dry-run     say what would happen
 *   node scripts/promote-answers.ts               do it
 *   node scripts/promote-answers.ts <appId>       one application only
 *
 * Runs in the worker because the portal cannot: the deployed portal
 * holds a publishable key by design. Ticking "reuse this answer on
 * future applications" records the request; this is what fulfils it.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { promoteRequestedAnswers } from "../lib/feedback/promote.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const dryRun = process.argv.includes("--dry-run");
const applicationId = process.argv.slice(2).find((a) => !a.startsWith("--"));

// recordFeedback refuses an actor that is not a person, because the
// whole point of a feedback event is that a human said something.
const results = await promoteRequestedAnswers(db, "user:plebantyler@gmail.com", { applicationId, dryRun });

if (!results.length) {
  console.log("nothing is awaiting promotion");
  process.exit(0);
}

console.log(dryRun ? "would promote:\n" : "promoted:\n");
for (const r of results) {
  console.log(`  ${r.question}`);
  if (r.skipped) { console.log(`    skipped: ${r.skipped}\n`); continue; }
  console.log(`    ${r.classification} (${r.scope})`);
  for (const line of r.audit) console.log(`    - ${line}`);
  if (r.bankId) console.log(`    question bank row ${r.bankId}`);
  if (r.contextualId) console.log(`    reusable answer ${r.contextualId}`);
  if (r.conflicts.length) console.log(`    ${r.conflicts.length} CONFLICT(S) OPENED, nothing was changed`);
  console.log();
}

const promoted = results.filter((r) => !r.skipped && (r.bankId || r.contextualId)).length;
const conflicted = results.filter((r) => r.conflicts.length).length;
const skipped = results.filter((r) => r.skipped).length;
console.log(`${results.length} considered, ${promoted} stored, ${conflicted} needing reconciliation, ${skipped} skipped`);
