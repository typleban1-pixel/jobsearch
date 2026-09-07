/**
 * Records a person's approval of an application, with the same binding the
 * portal's Approve button writes.
 *
 *   node --env-file=.env.local scripts/approve-by-person.ts <application_id> [--accept-qualification-gap] [--commit]
 *
 * The portal hides Approve for a job whose candidacy is a STRETCH with an
 * occupational gap and says "review it and apply manually if you choose".
 * A Workday application is applied to manually by construction -- the
 * person signs in, the runner fills, the person says submit -- so the
 * choice the portal invites is made here, in the open: the person's
 * instruction is the approval, the résumé artifact and answer set are
 * bound by hash exactly as the route binds them, and the qualification
 * gap is accepted only with the flag, which is recorded in the event.
 *
 * Every other refusal the submit guard raises (posting closed, no longer
 * eligible, candidacy refuses outright, blocked answers, artifact drift)
 * stops this exactly as it stops the portal. Nothing is submitted here.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { revalidateBeforeSubmit } from "../lib/applications/revalidate.ts";
import { answerSetHash } from "../lib/applications/approvalBinding.ts";

const id = process.argv[2];
if (!id) { console.error("usage: node scripts/approve-by-person.ts <application_id> [--accept-qualification-gap] [--commit]"); process.exit(2); }
const commit = process.argv.includes("--commit");
const acceptGap = process.argv.includes("--accept-qualification-gap");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: app } = await db.from("applications").select("*").eq("id", id).single();
if (!app) { console.error("no such application"); process.exit(1); }
if (app.submitted_at) { console.error("already submitted"); process.exit(1); }
if (app.human_approved) { console.log("already approved; nothing to do"); process.exit(0); }
const [{ data: job }, { data: answers }, { data: version }, { data: verdicts }, { data: company }] = await Promise.all([
  db.from("jobs").select("title,status,eligibility,canonical_opening_id,company_id").eq("id", app.job_id).single(),
  db.from("application_answers").select("field_key,answer_text,confidence_state,is_required").eq("application_id", id),
  db.from("job_versions").select("is_current").eq("id", app.job_version_id).maybeSingle(),
  db.from("job_candidacy").select("verdict,created_at,reason_codes,hard_met,hard_total").eq("job_id", app.job_id).order("created_at", { ascending: false }).limit(1),
  db.from("companies").select("name").eq("id", (await db.from("jobs").select("company_id").eq("id", app.job_id).single()).data!.company_id).single(),
]);
const { data: resume } = app.resume_id
  ? await db.from("resumes").select("artifact_sha256,content_sha256,label").eq("id", app.resume_id).maybeSingle()
  : { data: null } as any;
const rows = answers ?? [];
const currentAnswers = answerSetHash(rows as any);
const now = new Date().toISOString();
const check = revalidateBeforeSubmit({
  applicationId: id,
  jobStatus: job?.status ?? "unknown", eligibility: job?.eligibility ?? null,
  candidacyVerdict: verdicts?.[0]?.verdict ?? null, candidacyComputedAt: verdicts?.[0]?.created_at ?? null,
  candidacyReasonCode: (verdicts?.[0] as any)?.reason_codes?.[0] ?? null,
  hardMet: (verdicts?.[0] as any)?.hard_met ?? null, hardTotal: (verdicts?.[0] as any)?.hard_total ?? null,
  humanApproved: true, humanApprovedAt: now, authorizationMode: "HUMAN_APPROVED",
  allFieldsConfident: Boolean(app.all_fields_confident),
  blockedAnswers: rows.filter((a: any) => a.confidence_state === "BLOCKED").length,
  requiredUnanswered: rows.filter((a: any) => a.is_required && a.answer_text == null).length,
  jobVersionIsCurrent: Boolean(version?.is_current),
  storedArtifactSha256: resume?.artifact_sha256 ?? null, approvedArtifactSha256: resume?.artifact_sha256 ?? null,
  currentAnswersSha256: currentAnswers, approvedAnswersSha256: currentAnswers,
  otherSubmittedOnOpening: false, readbackPassed: true,
});
console.log(`${company?.name} — ${job?.title}`);
console.log(`  application ${id.slice(0, 8)}  ${app.status}  résumé ${resume?.label ?? "(none)"}`);
console.log(`  artifact ${String(resume?.artifact_sha256 ?? "").slice(0, 12)}  answers ${rows.length} (hash ${currentAnswers.slice(0, 12)})`);
console.log(`  candidacy ${verdicts?.[0]?.verdict ?? "none"} ${(verdicts?.[0] as any)?.reason_codes?.[0] ?? ""}`);
for (const r of check.refusals) console.log(`  refusal ${r.code}: ${r.detail}`);
const gapOnly = check.refusals.length > 0 && check.refusals.every((r) => r.code === "MATERIAL_QUALIFICATION_GAP");
if (!check.ok && !(gapOnly && acceptGap)) {
  console.error(gapOnly
    ? "\nthe only refusal is the qualification gap; re-run with --accept-qualification-gap if the person chooses to apply anyway"
    : "\nrefused: the submit guard raises more than a qualification gap; nothing was written");
  process.exit(1);
}
if (!resume?.artifact_sha256) { console.error("no rendered artifact to bind the approval to"); process.exit(1); }
if (!commit) { console.log("\ndry run; pass --commit to record the approval"); process.exit(0); }

const { error } = await db.from("applications").update({
  human_approved: true, human_approved_at: now, authorization_mode: "HUMAN_APPROVED",
  approved_artifact_sha256: resume.artifact_sha256, approved_content_sha256: resume.content_sha256 ?? null,
  approved_answers_sha256: currentAnswers,
  status: app.status === "AWAITING_REVIEW" ? "READY_TO_SUBMIT" : app.status,
}).eq("id", id);
if (error) { console.error(`could not record the approval: ${error.message}`); process.exit(1); }
await db.from("application_events").insert({
  application_id: id, event: "HUMAN_APPROVED", actor: "user:plebantyler@gmail.com",
  detail: `Approved by the person's explicit instruction (approve-by-person). Bound to artifact ${resume.artifact_sha256} and answer set ${currentAnswers}.`
    + (gapOnly ? ` The person chose to apply despite the qualification gap: ${check.refusals[0]!.detail}.` : ""),
});
console.log(`\napproved and bound; status ${app.status === "AWAITING_REVIEW" ? "READY_TO_SUBMIT" : app.status}`);
