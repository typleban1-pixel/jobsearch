/**
 * Migration 0050, against the live database.
 *
 *   node scripts/verify-0050.ts
 *
 * The invariant under test:
 *
 *   THE EXACT DOCUMENT APPROVED IS THE EXACT DOCUMENT UPLOADED.
 *
 * Every refusal is asserted by its specific cause, because a refusal for
 * the wrong reason is a test that passes while proving nothing. Test
 * rows are created and purged; the last check is that none survived.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { required } from "../lib/env.ts";
import { approvedArtifact } from "../lib/render/artifact.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n          ${detail}`}`);
  if (cond) pass++; else fails.push(name);
};

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const FAKE_A = Buffer.from("%PDF-1.4 approved document", "utf8");
const FAKE_B = Buffer.from("%PDF-1.4 a different document", "utf8");

const resumes: string[] = [];
const apps: string[] = [];

const newResume = async (label: string, pdf: Buffer | null) => {
  const row: Record<string, unknown> = { label, is_master: false, content: {} };
  if (pdf) {
    row.artifact_pdf = pdf.toString("base64");
    row.artifact_sha256 = sha(pdf);
    row.artifact_bytes = pdf.length;
    row.content_sha256 = sha(Buffer.from(label));
    row.renderer_version = 2;
  }
  const { data, error } = await db.from("resumes").insert(row).select("id").single();
  if (error) throw new Error(`resume insert: ${error.message}`);
  resumes.push(data.id);
  return data.id as string;
};

try {
  // ---- shape and completeness constraints --------------------------
  {
    const { error } = await db.from("resumes").insert({
      label: "bad hash", is_master: false, content: {},
      artifact_pdf: "x", artifact_sha256: "not-a-hash", artifact_bytes: 1,
    });
    check("a malformed artifact hash is rejected",
      !!error && /artifact_hash_is_sha256/.test(error.message), error?.message.slice(0, 100) ?? "ACCEPTED");
  }
  {
    const { error } = await db.from("resumes").insert({
      label: "bad content hash", is_master: false, content: {}, content_sha256: "nope",
    });
    check("a malformed content hash is rejected",
      !!error && /content_hash_is_sha256/.test(error.message), error?.message.slice(0, 100) ?? "ACCEPTED");
  }
  {
    // Bytes without a hash, and a hash without bytes: both incomplete.
    const { error: e1 } = await db.from("resumes").insert({
      label: "half artifact", is_master: false, content: {}, artifact_pdf: "abc",
    });
    check("an artifact without its hash is rejected",
      !!e1 && /artifact_is_complete/.test(e1.message), e1?.message.slice(0, 100) ?? "ACCEPTED");
    const { error: e2 } = await db.from("resumes").insert({
      label: "hash only", is_master: false, content: {}, artifact_sha256: sha(FAKE_A),
    });
    check("a hash without its artifact is rejected",
      !!e2 && /artifact_is_complete/.test(e2.message), e2?.message.slice(0, 100) ?? "ACCEPTED");
  }

  // ---- approval cannot happen without a named artifact -------------
  //
  // Each test application needs its OWN opening.
  // applications_one_active_per_canonical_opening is a partial unique
  // index over non-terminal statuses, so reusing one job makes the
  // second insert fail on that constraint instead of exercising
  // anything this file is about.
  const candidates: Array<{ id: string; versionId: string }> = [];
  {
    const { data: live } = await db.from("applications")
      .select("canonical_opening_id").not("status", "in", "(WITHDRAWN,ABANDONED,REJECTED)");
    const taken = new Set((live ?? []).map((a: any) => a.canonical_opening_id).filter(Boolean));
    const seen = new Set<string>();
    for (let from = 0; candidates.length < 5 && from < 3000; from += 200) {
      const { data: jobs } = await db.from("jobs")
        .select("id,canonical_opening_id").order("id").range(from, from + 199);
      if (!jobs?.length) break;
      for (const j of jobs) {
        if (candidates.length >= 5) break;
        const key = j.canonical_opening_id ?? j.id;
        if (taken.has(j.canonical_opening_id) || seen.has(key)) continue;
        const { data: v } = await db.from("job_versions")
          .select("id").eq("job_id", j.id).eq("is_current", true).maybeSingle();
        if (!v) continue;
        seen.add(key);
        candidates.push({ id: j.id, versionId: v.id });
      }
    }
  }
  check("five distinct unapplied openings are available to test against",
    candidates.length === 5, `found ${candidates.length}`);

  let nextCandidate = 0;
  const newApp = async (resumeId: string | null) => {
    const c = candidates[nextCandidate++]!;
    const { data, error } = await db.from("applications").insert({
      job_id: c.id, job_version_id: c.versionId, status: "DRAFT", is_test: true,
      resume_id: resumeId,
    }).select("id").single();
    if (error) throw new Error(`application insert: ${error.message}`);
    apps.push(data.id);
    return data.id as string;
  };

  /**
   * Walks the legal path to READY_TO_SUBMIT.
   *
   * The state machine refuses DRAFT -> READY_TO_SUBMIT outright, which is
   * correct and is asserted here rather than worked around: approval is
   * reached the way the real workflow reaches it.
   */
  const advanceToReview = async (id: string) => {
    // all_fields_confident is computed by a trigger from the answers, and
    // an application with no answers can never satisfy it. One accounted
    // -for field is the minimum honest state in which approval is even
    // possible, so the test reaches it the way the real workflow does
    // rather than by writing the flag, which another trigger forbids.
    const { error: ansErr } = await db.from("application_answers").insert({
      application_id: id, question_text: "verify-0050 placeholder field",
      field_label: "verify-0050 placeholder field", is_required: true,
      answer_text: "answered", confidence_state: "HUMAN_CONFIRMED",
      provenance: "USER_RESPONSE", category: "A_VERIFIED_FACT",
    });
    if (ansErr) throw new Error(`answer insert: ${ansErr.message}`);

    for (const status of ["PREPARING", "AWAITING_REVIEW"]) {
      const { error } = await db.from("applications").update({ status }).eq("id", id);
      if (error) throw new Error(`transition to ${status}: ${error.message}`);
    }
    const { data: a } = await db.from("applications")
      .select("all_fields_confident").eq("id", id).single();
    if (!a?.all_fields_confident) throw new Error("all_fields_confident did not become true");
  };

  {
    const r = await newResume("verify-0050 approved", FAKE_A);
    const a = await newApp(r);
    const { error } = await db.from("applications")
      .update({ human_approved: true, human_approved_at: new Date().toISOString() }).eq("id", a);
    check("approval without a named artifact is impossible",
      !!error && /approval_names_an_artifact/.test(error.message), error?.message.slice(0, 100) ?? "ACCEPTED");

    {
      const { error: illegal } = await db.from("applications")
        .update({ status: "READY_TO_SUBMIT" }).eq("id", a);
      check("the state machine still refuses to skip review",
        !!illegal && /illegal application transition/.test(illegal.message),
        illegal?.message.slice(0, 90) ?? "the jump was ACCEPTED");
    }
    await advanceToReview(a);
    const { error: ok } = await db.from("applications").update({
      human_approved: true, human_approved_at: new Date().toISOString(),
      approved_artifact_sha256: sha(FAKE_A), status: "READY_TO_SUBMIT",
    }).eq("id", a);
    check("approval naming the artifact succeeds", !ok, ok?.message ?? "");

    const v = await approvedArtifact(db, a);
    check("the approved artifact verifies and yields its bytes",
      v.ok && v.sha256 === sha(FAKE_A), v.ok ? "" : v.why);

    // ---- altered after approval ------------------------------------
    await db.from("resumes").update({
      artifact_pdf: FAKE_B.toString("base64"), artifact_sha256: sha(FAKE_B), artifact_bytes: FAKE_B.length,
    }).eq("id", r);
    const v2 = await approvedArtifact(db, a);
    check("an artifact altered after approval is refused",
      !v2.ok && /no longer matches what was approved/.test(v2.why), v2.ok ? "ACCEPTED" : v2.why.slice(0, 110));
    check("and the refusal says it must be reviewed again, not regenerated",
      !v2.ok && /reviewed again rather than regenerated/.test(v2.why), v2.ok ? "" : v2.why.slice(0, 110));

    // ---- bytes and recorded hash disagreeing -----------------------
    await db.from("resumes").update({
      artifact_pdf: FAKE_A.toString("base64"), artifact_sha256: sha(FAKE_A), artifact_bytes: FAKE_A.length,
    }).eq("id", r);
    const v3 = await approvedArtifact(db, a);
    check("restoring the approved bytes restores verification", v3.ok, v3.ok ? "" : v3.why);
  }

  // ---- a missing artifact ------------------------------------------
  {
    const r = await newResume("verify-0050 no artifact", null);
    const a = await newApp(r);
    await advanceToReview(a);
    await db.from("applications").update({
      human_approved: true, approved_artifact_sha256: sha(FAKE_A), status: "READY_TO_SUBMIT",
    }).eq("id", a);
    const v = await approvedArtifact(db, a);
    check("an approval whose resume has no stored PDF is refused",
      !v.ok && /no stored PDF artifact/.test(v.why), v.ok ? "ACCEPTED" : v.why.slice(0, 100));
  }

  // ---- an unapproved application -----------------------------------
  {
    const r = await newResume("verify-0050 unapproved", FAKE_A);
    const a = await newApp(r);
    const v = await approvedArtifact(db, a);
    check("an application with no approval is refused",
      !v.ok && /no approved artifact is recorded/.test(v.why), v.ok ? "ACCEPTED" : v.why.slice(0, 100));
  }

  // ---- equivalent content is not the approved artifact -------------
  {
    // The same words, rendered again: a different file. The content hash
    // matching is not permission to upload it.
    const content = sha(Buffer.from("identical content"));
    const r1 = await newResume("verify-0050 original", FAKE_A);
    await db.from("resumes").update({ content_sha256: content }).eq("id", r1);
    const a = await newApp(r1);
    await advanceToReview(a);
    await db.from("applications").update({
      human_approved: true, approved_artifact_sha256: sha(FAKE_A),
      approved_content_sha256: content, status: "READY_TO_SUBMIT",
    }).eq("id", a);

    // Swap in a different rendering that carries the SAME content hash.
    await db.from("resumes").update({
      artifact_pdf: FAKE_B.toString("base64"), artifact_sha256: sha(FAKE_B),
      artifact_bytes: FAKE_B.length, content_sha256: content,
    }).eq("id", r1);
    const v = await approvedArtifact(db, a);
    check("a re-render with a matching content hash still cannot substitute",
      !v.ok, v.ok ? "the byte gate was bypassed by a content hash" : v.why.slice(0, 100));
    check("the content hash is recorded but never gates the upload",
      !v.ok && !/content/i.test(v.why), v.ok ? "" : v.why.slice(0, 100));
  }

  // ---- permissions --------------------------------------------------
  {
    const { data: audit } = await db.rpc("security_audit");
    const EXPECTED = ["application_answers", "applications", "job_interest", "question_bank"];
    const w = (audit ?? []).filter((x: any) => /INSERT|UPDATE/.test(x.authenticated_privileges))
      .map((x: any) => x.table_name).sort();
    check("the portal role still writes exactly four tables",
      JSON.stringify(w) === JSON.stringify(EXPECTED), w.join(", "));
    const resumesRow = (audit ?? []).find((x: any) => x.table_name === "resumes");
    check("resumes stays read-only to the portal role",
      !/INSERT|UPDATE|DELETE/.test(resumesRow?.authenticated_privileges ?? ""),
      resumesRow?.authenticated_privileges ?? "no row");
  }
} finally {
  for (const id of apps) {
    const { error } = await db.rpc("purge_test_application", { p_id: id });
    if (error) console.log(`  cleanup failed for application ${id}: ${error.message}`);
  }
  for (const id of resumes) {
    const { error } = await db.from("resumes").delete().eq("id", id);
    if (error) console.log(`  cleanup failed for resume ${id}: ${error.message}`);
  }
  const { data: leftApps } = await db.from("applications").select("id").in("id", apps.length ? apps : ["00000000-0000-0000-0000-000000000000"]);
  const { data: leftRes } = await db.from("resumes").select("id").in("id", resumes.length ? resumes : ["00000000-0000-0000-0000-000000000000"]);
  check("no test debris remains",
    (leftApps ?? []).length === 0 && (leftRes ?? []).length === 0,
    `${(leftApps ?? []).length} application(s), ${(leftRes ?? []).length} resume(s)`);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log("migration 0050 verified");
