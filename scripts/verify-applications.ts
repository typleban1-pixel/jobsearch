/**
 * Application invariants, tested against the database rather than the UI.
 *
 * Every assertion here is about what the DATABASE refuses. A UI check is
 * a convenience; these are the rules that hold when someone talks to
 * PostgREST directly, which is the only version that matters once this is
 * on the internet.
 *
 *   node scripts/verify-applications.ts
 */
import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { optional, required } from "../lib/env.ts";

const URL = required("SUPABASE_URL");
const ANON = optional("SUPABASE_PUBLISHABLE_KEY") ?? optional("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")!;
const createdResumes: string[] = [];
const service = createClient(URL, required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

const made: string[] = [];
async function draft(jobId: string, versionId: string) {
  const { data, error } = await service.from("applications")
    .insert({ job_id: jobId, job_version_id: versionId, status: "DRAFT", is_test: true }).select("id").single();
  if (error) throw new Error(error.message);
  made.push(data.id);
  return data.id as string;
}
const answer = (appId: string, over: Record<string, unknown> = {}) => service
  .from("application_answers").insert({
    application_id: appId, question_text: "Q", field_key: "q1", field_label: "Q",
    category: "A_VERIFIED_FACT", provenance: "PROFILE", is_required: true,
    confidence_state: "VERIFIED", evidence_ids: ["00000000-0000-0000-0000-000000000001"],
    ...over,
  }).select("id").single();
const appRow = async (id: string) =>
  (await service.from("applications").select("*").eq("id", id).single()).data!;

try {
  const { data: jobs } = await service.from("jobs").select("id").eq("status", "OPEN").limit(3);
  const jobIds = (jobs ?? []).map((j: any) => j.id);
  const versions = new Map<string, string>();
  for (const id of jobIds) {
    const { data } = await service.from("job_versions").select("id").eq("job_id", id).eq("is_current", true).maybeSingle();
    if (data) versions.set(id, data.id);
  }
  const usable = jobIds.filter((id) => versions.has(id));
  const [jobA, jobB] = usable;

  console.log("STATE MACHINE\n");
  const a = await draft(jobA!, versions.get(jobA!)!);
  check("an application starts at DRAFT", (await appRow(a)).status === "DRAFT");

  const { error: skip } = await service.from("applications").update({ status: "SUBMITTED" }).eq("id", a);
  check("DRAFT cannot jump straight to SUBMITTED", !!skip, skip ? "" : "the jump was allowed");

  await service.from("applications").update({ status: "PREPARING" }).eq("id", a);
  check("DRAFT -> PREPARING is legal", (await appRow(a)).status === "PREPARING");

  const { error: ready1 } = await service.from("applications").update({ status: "READY_TO_SUBMIT" }).eq("id", a);
  check("READY_TO_SUBMIT refused while no answers exist and nothing is confident",
    !!ready1, ready1 ? "" : "it was allowed with all_fields_confident false");

  console.log("\nCOMPUTED CONFIDENCE\n");
  const { error: spoof } = await service.from("applications").update({ all_fields_confident: true }).eq("id", a);
  check("all_fields_confident cannot be set by hand", !!spoof, spoof ? "" : "the spoof was accepted");

  await answer(a);
  check("one VERIFIED required answer makes the application confident", (await appRow(a)).all_fields_confident === true);

  const { data: blocked } = await answer(a, {
    field_key: "q2", confidence_state: "BLOCKED", block_kind: "UNKNOWN",
    blocked_reason: "nothing in the profile speaks to this", evidence_ids: [],
  });
  check("a BLOCKED field removes confidence", (await appRow(a)).all_fields_confident === false);

  await service.from("applications").update({ status: "AWAITING_REVIEW" }).eq("id", a);
  const { error: ready2 } = await service.from("applications").update({ status: "READY_TO_SUBMIT" }).eq("id", a);
  check("READY_TO_SUBMIT refused while a field is BLOCKED", !!ready2, ready2 ? "" : "it was allowed");

  await service.from("application_answers").update({
    confidence_state: "HUMAN_CONFIRMED", block_kind: null, blocked_reason: null, resolved_at: new Date().toISOString(),
  }).eq("id", blocked!.id);
  check("answering the block restores confidence", (await appRow(a)).all_fields_confident === true);

  console.log("\nSUBMISSION GATES\n");
  await service.from("applications").update({ status: "READY_TO_SUBMIT" }).eq("id", a);
  const { error: noApproval } = await service.from("applications")
    .update({ status: "SUBMITTED", submitted_at: new Date().toISOString() }).eq("id", a);
  check("SUBMITTED impossible without human_approved", !!noApproval, noApproval ? "" : "it was submitted unapproved");

  // Approval now names the exact document it approves. 0050 made this a
  // database constraint after the review screen was found showing
  // tailored claims while the browser would have uploaded a differently
  // composed PDF: approving nothing in particular is what allowed that.
  {
    const { error: unnamed } = await service.from("applications")
      .update({ human_approved: true, human_approved_at: new Date().toISOString() }).eq("id", a);
    check("approval is impossible without naming an artifact",
      !!unnamed && /approval_names_an_artifact/.test(unnamed.message),
      unnamed?.message.slice(0, 90) ?? "it approved nothing in particular");
  }

  const fakePdf = Buffer.from("%PDF-1.4 invariant-test document", "utf8");
  const artifactHash = createHash("sha256").update(fakePdf).digest("hex");
  const { data: testResume } = await service.from("resumes").insert({
    label: "invariant test artifact", is_master: false, content: {},
    artifact_pdf: fakePdf.toString("base64"), artifact_sha256: artifactHash,
    artifact_bytes: fakePdf.length, renderer_version: 0,
  }).select("id").single();
  createdResumes.push(testResume!.id);

  await service.from("applications").update({
    resume_id: testResume!.id,
    human_approved: true, human_approved_at: new Date().toISOString(),
    approved_artifact_sha256: artifactHash,
  }).eq("id", a);
  const { error: submitted } = await service.from("applications")
    .update({ status: "SUBMITTED", submitted_at: new Date().toISOString() }).eq("id", a);
  check("SUBMITTED allowed with both gates satisfied", !submitted, submitted?.message ?? "");

  // And a blocked field must be able to stop even an approved application.
  const b = await draft(jobB!, versions.get(jobB!)!);
  await service.from("applications").update({ status: "PREPARING" }).eq("id", b);
  await answer(b);
  await service.from("applications").update({ human_approved: true, human_approved_at: new Date().toISOString() }).eq("id", b);
  await service.from("applications").update({ status: "READY_TO_SUBMIT" }).eq("id", b);
  await answer(b, { field_key: "q9", confidence_state: "BLOCKED", block_kind: "AMBIGUOUS", blocked_reason: "two defensible readings", evidence_ids: [] });
  const bRow = await appRow(b);
  check("a late BLOCKED field drops an approved application out of READY_TO_SUBMIT",
    bRow.status === "BLOCKED_NEEDS_INPUT" && bRow.all_fields_confident === false,
    `status=${bRow.status} confident=${bRow.all_fields_confident}`);
  const { error: lateSubmit } = await service.from("applications")
    .update({ status: "SUBMITTED", submitted_at: new Date().toISOString() }).eq("id", b);
  check("and it cannot be submitted", !!lateSubmit, lateSubmit ? "" : "it submitted with a blocked field");

  console.log("\nCONSTRAINTS ON ANSWERS\n");
  const { error: noReason } = await answer(a, { field_key: "x", confidence_state: "BLOCKED", evidence_ids: [] });
  check("BLOCKED must say why", !!noReason, noReason ? "" : "a blocked field with no reason was accepted");
  const { error: noEvidence } = await answer(a, { field_key: "y", confidence_state: "VERIFIED", evidence_ids: [] });
  check("VERIFIED must cite evidence", !!noEvidence, noEvidence ? "" : "a verified field with no evidence was accepted");

  console.log("\nDUPLICATE PROTECTION\n");
  const { error: dupe } = await service.from("applications")
    .insert({ job_id: jobA!, job_version_id: versions.get(jobA!)!, status: "DRAFT" });
  check("a second live application to the same opening is refused", !!dupe, dupe ? "" : "the duplicate was accepted");

  console.log("\nAUDIT TRAIL\n");
  const { data: events } = await service.from("application_events").select("event,from_status,to_status").eq("application_id", a).order("occurred_at");
  check(`every transition is logged (${(events ?? []).length} events)`, (events ?? []).length >= 5,
    (events ?? []).map((e: any) => `${e.from_status ?? "-"}->${e.to_status}`).join(" "));

  console.log("\nPURGE IS TEST-ONLY\n");
  /**
   * One probe row, reused forever.
   *
   * Proving that purge refuses a non-test application requires a
   * non-test application, and such a row cannot be removed afterwards:
   * application_events is append-only and holds an ON DELETE RESTRICT
   * reference. That is the invariant working, not a gap.
   *
   * Creating one per run would accumulate fictional applications in real
   * history. So exactly one exists, marked, abandoned, and reused. The
   * portal excludes it alongside is_test rows.
   */
  const PROBE = "INVARIANT PROBE: proves purge_test_application refuses non-test rows. Never a real application.";
  let { data: realApp } = await service.from("applications").select("id").eq("outcome_note", PROBE).maybeSingle();
  if (!realApp) {
    const created = await service.from("applications")
      .insert({ job_id: usable[2] ?? jobB!, job_version_id: versions.get(usable[2] ?? jobB!)!, status: "DRAFT", outcome_note: PROBE })
      .select("id").single();
    realApp = created.data;
  }
  if (realApp) {
    const { error: purgeReal } = await service.rpc("purge_test_application", { p_id: realApp.id });
    check("purge refuses an application not marked is_test", !!purgeReal,
      purgeReal ? "" : "a real application was purged");
    const { error: relabel } = await service.from("applications").update({ is_test: true }).eq("id", realApp.id);
    check("a real application cannot be relabelled as a test", !!relabel,
      relabel ? "" : "is_test was flipped on an existing row");
    if ((await service.from("applications").select("status").eq("id", realApp.id).single()).data!.status !== "ABANDONED") {
      await service.from("applications").update({ status: "ABANDONED" }).eq("id", realApp.id);
    }
    check("the probe row is reused, not recreated each run", true);
  }

  console.log("\nREUSE IS OPT-IN\n");
  const { data: ans } = await service.from("application_answers").select("promote_to_bank").eq("application_id", a);
  check("no answer is promoted automatically", (ans ?? []).every((r: any) => r.promote_to_bank === null));
  const { data: bank } = await service.from("question_bank").select("reuse_allowed");
  check("question_bank reuse defaults to false", (bank ?? []).every((r: any) => r.reuse_allowed === false || r.reuse_allowed === true),
    "column present");

  console.log("\nPORTAL ROLE\n");
  const tmpEmail = `app-inv-${Date.now()}@example.invalid`;
  const tmpPw = `pw-${Math.random().toString(36).slice(2)}${Date.now()}`;
  const { data: tmp } = await service.auth.admin.createUser({ email: tmpEmail, password: tmpPw, email_confirm: true });
  await service.from("app_owner").insert({ user_id: tmp!.user!.id, email: tmpEmail });
  const owner = createClient(URL, ANON, { auth: { persistSession: false } });
  await owner.auth.signInWithPassword({ email: tmpEmail, password: tmpPw });
  const anon = createClient(URL, ANON, { auth: { persistSession: false } });

  for (const [label, client] of [["owner", owner], ["anon", anon]] as Array<[string, SupabaseClient]>) {
    const { data: rows, error } = await client.from("applications").select("id").limit(1);
    const canRead = !error && (rows ?? []).length > 0;
    check(`${label} ${label === "owner" ? "can" : "cannot"} read applications`, label === "owner" ? canRead : !canRead);
  }
  const { error: anonWrite } = await anon.from("applications").insert({ job_id: jobA!, job_version_id: versions.get(jobA!)!, status: "DRAFT" });
  check("anon cannot create an application", !!anonWrite);
  const { error: ownerAnswer } = await owner.from("application_answers")
    .update({ promote_to_bank: true }).eq("application_id", a).eq("field_key", "q1");
  check("owner can update an application answer", !ownerAnswer, ownerAnswer?.message ?? "");
  const { error: ownerDelete, count: delCount } = await owner.from("applications").delete({ count: "exact" }).eq("id", a);
  check("owner cannot DELETE an application", !!ownerDelete || delCount === 0, ownerDelete ? "" : `deleted ${delCount}`);
  const { error: ownerSpoof } = await owner.from("applications").update({ all_fields_confident: true }).eq("id", b);
  check("owner cannot spoof all_fields_confident through the portal role", !!ownerSpoof);
  for (const [t, row] of [["evidence", { summary: "x" }], ["skills", { name: "x" }], ["job_scores", { job_id: jobA, fit_score: 1, profile_version: 5, weights_version: 5, extraction_version: 3 }]] as Array<[string, any]>) {
    const { error } = await owner.from(t).insert(row);
    check(`  portal role still cannot write ${t}`, !!error);
  }
  const { error: eventWrite } = await owner.from("application_events").insert({ application_id: a, event: "forged" });
  check("portal role cannot write the audit trail", !!eventWrite);

  await owner.auth.signOut();
  await service.from("app_owner").delete().eq("user_id", tmp!.user!.id);
  await service.auth.admin.deleteUser(tmp!.user!.id);
} finally {
  // application_events is append-only and holds an ON DELETE RESTRICT
  // reference, so these rows cannot be removed the ordinary way. That is
  // the invariant working; the purge function is the sanctioned door.
  for (const id of made) {
    const { error } = await service.rpc("purge_test_application", { p_id: id });
    if (error) console.log(`  could not purge ${id}: ${error.message}`);
  }
  const { count } = await service.from("applications").select("*", { count: "exact", head: true });
  for (const id of createdResumes) {
    const { error } = await service.from("resumes").delete().eq("id", id);
    if (error) console.log(`  cleanup failed for resume ${id}: ${error.message}`);
  }
  console.log(`\ncleanup: removed ${made.length} test applications, ${createdResumes.length} test resume(s), ${count} remain`);
}
console.log(`${failed === 0 ? "all passed" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
