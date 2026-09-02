/**
 * The manual-submission recording path, against the live database.
 *
 * Recording that a person submitted is a different operation from
 * authorizing a machine to submit, and these prove the difference holds:
 * the manual path works where the machine path cannot, and the machine
 * path's guarantees are unchanged.
 *
 * Every case creates its own throwaway application and removes it, so
 * nothing here touches real applications.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

// A job nothing has been submitted against, so duplicate protection is
// not the thing under test except where it is.
const { data: jobs } = await db.from("jobs").select("id,canonical_opening_id")
  .eq("status", "OPEN").eq("eligibility", "ELIGIBLE").limit(40);
const { data: submitted } = await db.from("applications").select("job_id").not("submitted_at", "is", null);
const { data: subJobs } = await db.from("jobs").select("canonical_opening_id")
  .in("id", (submitted ?? []).map((s: any) => s.job_id));
const taken = new Set((subJobs ?? []).map((j: any) => j.canonical_opening_id));
const { data: used } = await db.from("applications").select("job_id");
const usedJobs = new Set((used ?? []).map((u: any) => u.job_id));
const free = (jobs ?? []).filter((j: any) => !taken.has(j.canonical_opening_id) && !usedJobs.has(j.id));
if (free.length < 10) { console.error(`need 10 unused jobs, have ${free.length}`); process.exit(1); }
let nextJob = 0;
const takeJob = () => free[nextJob++]!.id;

const made: string[] = [];
const startedAt = new Date().toISOString();
async function makeApp(jobId: string, over: Record<string, unknown> = {}): Promise<string> {
  const { data: v } = await db.from("job_versions").select("id").eq("job_id", jobId)
    .order("version_number", { ascending: false }).limit(1).single();
  const { data, error } = await db.from("applications").insert({
    job_id: jobId, job_version_id: v!.id, status: "DRAFT",
    submission_mode: "MANUAL", is_test: true,
  }).select("id").single();
  if (error) throw new Error(error.message);
  made.push(data!.id);
  await db.from("applications").update({ status: "PREPARING" }).eq("id", data!.id);
  await db.from("applications").update({ status: "AWAITING_REVIEW" }).eq("id", data!.id);
  const { error: eApprove } = await db.from("applications").update({
    human_approved: true, human_approved_at: new Date().toISOString(),
    authorization_mode: "HUMAN_APPROVED",
    // approval_names_an_artifact: an approval must say what was approved.
    approved_artifact_sha256: "0".repeat(64),
    approved_content_sha256: "1".repeat(64),
    ...over,
  }).eq("id", data!.id);
  if (eApprove) throw new Error(`approve step: ${eApprove.message}`);
  return data!.id;
}
const rec = (id: string, over: Record<string, unknown> = {}) => db.rpc("record_manual_submission", {
  p_application_id: id, p_submitted_at: new Date().toISOString(),
  p_confirmation_reference: "fill-run:test-evidence", p_detail: "test", ...over,
});

try {
  // 1. The Popl shape: zero mapped answers, recorded successfully.
  {
    const firstJob = takeJob();
    const id = await makeApp(firstJob);
    const { data: pre } = await db.from("applications").select("all_fields_confident").eq("id", id).single();
    const { count } = await db.from("application_answers").select("id", { count: "exact", head: true }).eq("application_id", id);
    check("the test application has zero mapped answers", count === 0, String(count));
    const { error } = await rec(id);
    check("a manual submission with zero mapped answers is recorded", !error, error?.message ?? "");
    const { data: post } = await db.from("applications")
      .select("status,submitted_at,submit_outcome,all_fields_confident").eq("id", id).single();
    check("status is SUBMITTED", post!.status === "SUBMITTED", post!.status);
    check("submitted_at is set from the supplied time", Boolean(post!.submitted_at), "");
    check("outcome is CONFIRMED", post!.submit_outcome === "CONFIRMED", String(post!.submit_outcome));
    check("all_fields_confident is unchanged",
      post!.all_fields_confident === pre!.all_fields_confident, `${pre!.all_fields_confident} -> ${post!.all_fields_confident}`);
    check("and it was never true", post!.all_fields_confident === false, "");
  }

  // 2. The same application cannot become READY_TO_SUBMIT.
  {
    const id = await makeApp(takeJob());
    const { error } = await db.from("applications").update({ status: "READY_TO_SUBMIT" }).eq("id", id);
    check("zero mapped fields does NOT make it ready to submit",
      Boolean(error) && /every required field/i.test(error!.message), error?.message ?? "no error");
  }

  // 3. The direct transition is still illegal outside the path.
  {
    const id = await makeApp(takeJob());
    const { error } = await db.from("applications")
      .update({ status: "SUBMITTED", submitted_at: new Date().toISOString() }).eq("id", id);
    check("AWAITING_REVIEW -> SUBMITTED is refused by a plain update",
      Boolean(error) && /illegal application transition/i.test(error!.message), error?.message ?? "no error");
  }

  // 4. Confirmation evidence is required.
  {
    const id = await makeApp(takeJob());
    const { error } = await rec(id, { p_confirmation_reference: "" });
    check("no confirmation evidence, no recording",
      Boolean(error) && /confirmation evidence/i.test(error!.message), error?.message ?? "no error");
  }

  // 5. A time is required.
  {
    const id = await makeApp(takeJob());
    const { error } = await rec(id, { p_submitted_at: null });
    check("a submission time is required",
      Boolean(error) && /time it was actually submitted/i.test(error!.message), error?.message ?? "no error");
  }

  // 6. The automated worker cannot use this path.
  {
    const id = await makeApp(takeJob());
    await db.from("applications").update({ submission_mode: "AUTOMATED" }).eq("id", id);
    const { error } = await rec(id);
    check("an AUTOMATED application cannot use the manual path",
      Boolean(error) && /MANUAL submissions only/i.test(error!.message), error?.message ?? "no error");
    await db.from("applications").update({ submission_mode: "ASSISTED" }).eq("id", id);
    const { error: e2 } = await rec(id);
    check("an ASSISTED application cannot use it either",
      Boolean(e2) && /MANUAL submissions only/i.test(e2!.message), e2?.message ?? "no error");
  }

  // 7. If the automation may have clicked, this is the ambiguous case.
  {
    const id = await makeApp(takeJob(), { submit_click_attempted_at: new Date().toISOString() });
    const { error } = await rec(id);
    check("an application the automation may have submitted is refused",
      Boolean(error) && /resolve the ambiguity/i.test(error!.message), error?.message ?? "no error");
  }

  // 8. Duplicate-opening protection still applies.
  //
  // Enforced by a unique index, so a second application on an opening
  // that already has one cannot even be created. That is stronger than
  // the RPC's own check, and it is what actually protects the employer
  // from receiving two applications.
  {
    const { data: firstApp } = await db.from("applications").select("job_id").eq("id", made[0]!).single();
    const { data: v } = await db.from("job_versions").select("id").eq("job_id", firstApp!.job_id)
      .order("version_number", { ascending: false }).limit(1).single();
    const { error } = await db.from("applications").insert({
      job_id: firstApp!.job_id, job_version_id: v!.id, status: "DRAFT",
      submission_mode: "MANUAL", is_test: true,
    });
    check("a second application on a submitted opening cannot be created",
      Boolean(error) && /one_active_per_canonical_opening/i.test(error!.message), error?.message ?? "no error");
  }

  // 9. Already submitted cannot be recorded twice.
  {
    const { data: done } = await db.from("applications").select("id")
      .eq("is_test", true).not("submitted_at", "is", null).limit(1).maybeSingle();
    if (done) {
      const { error } = await rec(done.id);
      check("an already-submitted application is refused",
        Boolean(error) && /already submitted/i.test(error!.message), error?.message ?? "no error");
    } else check("an already-submitted application is refused", false, "no submitted test app found");
  }
} finally {
  for (const id of made) {
    await db.rpc("purge_test_application", { p_id: id }).then(() => undefined, () => undefined);
  }
  // Anything this run created, tracked or not.
  //
  // purge_test_application is the sanctioned path: a plain DELETE cannot
  // remove a row whose audit events exist, and a test row driven to
  // SUBMITTED to prove the gates would otherwise be stranded in the real
  // submitted list forever. It refuses anything not marked is_test.
  const { data: strays } = await db.from("applications").select("id")
    .eq("is_test", true).gte("created_at", startedAt);
  for (const s2 of strays ?? []) {
    const { error } = await db.rpc("purge_test_application", { p_id: s2.id });
    if (error) console.log(`  could not purge ${s2.id}: ${error.message.slice(0, 80)}`);
  }
  console.log(`\ncleaned up ${made.length + (strays ?? []).length} test applications from this run`);
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
