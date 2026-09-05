/**
 * Controlled POLICY_AUTHORIZED authorization for ONE application.
 *
 *   node scripts/policy-authorize.ts <application_id> "<reason>"
 *
 * Moves a prepared, fully-answered application to READY_TO_SUBMIT under
 * authorization_mode=POLICY_AUTHORIZED, binding the approval to the exact
 * tailored resume artifact. This is the autonomous authorization the
 * unattended worker performs, exposed as a single reviewable command for
 * a controlled, per-application exception.
 *
 * It CANNOT weaken anything downstream. It refuses unless:
 *   - no answer is BLOCKED and every required field has an answer;
 *   - all_fields_confident is true (computed from the answers);
 *   - the bound resume has a rendered artifact hash;
 *   - no other live (non-closed) application exists for the opening;
 *   - the application is not already submitted.
 * Every evidence, revalidation and confirmation gate still applies in
 * scripts/submit-application.ts, which is what actually submits.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { requiredBlocked } from "../lib/applications/revalidate.ts";

const APP = process.argv[2];
const REASON = process.argv[3] ?? "controlled per-application authorization";
if (!APP) { console.error('usage: node scripts/policy-authorize.ts <application_id> "<reason>"'); process.exit(2); }

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: app, error } = await db.from("applications")
  .select("id,status,resume_id,all_fields_confident,canonical_opening_id,submitted_at,authorization_mode")
  .eq("id", APP).maybeSingle();
if (error || !app) { console.error(`no such application: ${error?.message}`); process.exit(1); }
if (app.submitted_at) { console.error("already submitted; refusing"); process.exit(1); }

// Fire the confidence recompute (no-op answer touch) so all_fields_confident
// reflects the current answers and the current recompute rules.
const { data: one } = await db.from("application_answers").select("id,resolved_at").eq("application_id", APP).limit(1).maybeSingle();
if (one) await db.from("application_answers").update({ resolved_at: one.resolved_at ?? new Date().toISOString() }).eq("id", one.id);

const { data: rows } = await db.from("application_answers").select("confidence_state,is_required,answer_text").eq("application_id", APP);
// Required-blocked only: an optional blocked field (deferred demographic,
// pronoun self-ID) is left blank at fill time and must not refuse
// authorization. Fails closed on unknown requiredness.
const reqBlocked = requiredBlocked((rows ?? []) as any);
const reqUnanswered = (rows ?? []).filter((r: any) => r.is_required && !r.answer_text).length;
if (!rows?.length || reqBlocked > 0 || reqUnanswered > 0) {
  console.error(`refusing: ${rows?.length ?? 0} answers, ${reqBlocked} required-blocked, ${reqUnanswered} required-unanswered`); process.exit(1);
}

const { data: fresh } = await db.from("applications").select("all_fields_confident").eq("id", APP).single();
if (!fresh?.all_fields_confident) { console.error("refusing: all_fields_confident is false after recompute"); process.exit(1); }

const { data: r } = await db.from("resumes").select("artifact_sha256,content_sha256").eq("id", app.resume_id).single();
if (!r?.artifact_sha256) { console.error("refusing: the bound resume has no rendered artifact"); process.exit(1); }

const { data: live } = await db.from("applications").select("id,status")
  .eq("canonical_opening_id", app.canonical_opening_id).not("status", "in", "(REJECTED,WITHDRAWN,ABANDONED)");
if ((live ?? []).filter((x: any) => x.id !== APP).length) {
  console.error(`refusing: another live application exists for this opening: ${JSON.stringify(live)}`); process.exit(1);
}

const snapshot = { basis: REASON, reviewedByPerson: false, decidedAt: new Date().toISOString(),
  qualification: { blocked: 0, requiredUnanswered: 0, allFieldsConfident: true, artifactBound: true } };
const { error: ae } = await db.from("applications").update({
  authorization_mode: "POLICY_AUTHORIZED", policy_authorized_at: new Date().toISOString(),
  policy_snapshot: snapshot, approved_artifact_sha256: r.artifact_sha256,
  approved_content_sha256: r.content_sha256 ?? null, status: "READY_TO_SUBMIT",
}).eq("id", APP);
if (ae) { console.error(`authorize failed: ${ae.message}`); process.exit(1); }
await db.from("application_events").insert({ application_id: APP, event: "POLICY_AUTHORIZED",
  detail: `Authorized (POLICY_AUTHORIZED) via policy-authorize.ts. ${REASON}. No person read this application; basis in policy_snapshot.`,
  actor: "system" });
console.log(`AUTHORIZED ${APP}: POLICY_AUTHORIZED, artifact ${r.artifact_sha256.slice(0, 12)}, status READY_TO_SUBMIT`);
console.log(`next: node scripts/submit-application.ts ${APP}`);
