/**
 * Recording an answer you gave that the system could not.
 *
 *   node scripts/record-feedback.ts \
 *     --application <uuid> \
 *     --question "Are you able to commute to our Chicago office?" \
 *     --answer "Yes" \
 *     [--intent can_commute] [--proposed "No"] [--field question_7]
 *
 * Prints what it would learn and what it would refuse to learn, then
 * writes it. Nothing is inferred about you that you did not say: the
 * classification is shown before the write, and a correction that
 * disagrees with an established fact opens a conflict instead of
 * changing anything.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { loadBeliefs, recordFeedback } from "../lib/feedback/store.ts";
import { normalizeQuestion } from "../lib/feedback/classify.ts";
import { applicationScope } from "../lib/applications/prepare.ts";
import type { FeedbackEvent } from "../lib/feedback/types.ts";

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
};

const applicationId = arg("application");
const questionRaw = arg("question");
const humanAnswer = arg("answer");
if (!applicationId || !questionRaw || !humanAnswer) {
  console.error("usage: --application <uuid> --question <text> --answer <text> [--intent k] [--proposed text] [--field key] [--why text]");
  process.exit(1);
}

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: app, error } = await db.from("applications")
  .select("id,job_id,status").eq("id", applicationId).single();
if (error || !app) { console.error(`no such application: ${error?.message}`); process.exit(1); }

const scope = app.job_id ? await applicationScope(db, app.job_id).catch(() => null) : null;

// The frozen profile is what the resolver reads, but a fact is written
// to the live profile, so beliefs are read from the live row.
const { data: profile } = await db.from("profile").select("*").eq("singleton", true).single();
const snap = await loadBeliefs(db, (profile ?? {}) as Record<string, unknown>);

const ev: FeedbackEvent = {
  applicationId, jobId: app.job_id ?? null, canonicalOpeningId: null,
  employer: scope?.employer ?? null, provider: scope?.provider ?? null,
  questionRaw, questionNormalized: normalizeQuestion(questionRaw),
  providerFieldKey: arg("field"),
  intentBefore: arg("intent-before"),
  confidenceBefore: "BLOCKED",
  whyStopped: arg("why") ?? "the field was left for a human during the fill",
  proposedAnswer: arg("proposed"),
  humanAnswer,
  intentConfirmed: arg("intent"),
  conditions: scope?.conditions ?? {},
  occurredAt: new Date().toISOString(),
};

const result = await recordFeedback(db, ev, snap, "user:human_confirmed");

console.log(`recorded ${result.eventId}`);
console.log(`  classification: ${result.outcome.classification.classification} (${result.outcome.classification.scope})`);
console.log(`  because: ${result.outcome.classification.because}`);
for (const a of result.outcome.audit) console.log(`  - ${a}`);
if (result.conflictIds.length) {
  console.log(`\n  ${result.conflictIds.length} conflict(s) opened. Nothing was changed; these need your decision:`);
  for (const c of result.outcome.conflicts) {
    console.log(`    ${c.kind} ${c.subject}: ${c.existing} vs ${c.incoming}`);
  }
}
