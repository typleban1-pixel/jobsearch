/**
 * Migration 0047, verified against the live database.
 *
 * Run after applying 0047_attribution_and_answer_cleanup.sql. Checks the
 * removal, the addition, both constraints in the failing direction, that
 * existing rows survived, and that no grant widened.
 *
 * The constraint tests write and then remove two test applications. They
 * are marked is_test so the existing purge safeguards apply, and they are
 * removed in a finally block so a failure does not leave debris.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { generateAttributionToken } from "../lib/applications/attribution.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n          ${detail}`}`);
  if (cond) pass++; else fails.push(name);
};

// 1. The numeric confidence is gone.
{
  const { error } = await db.from("application_answers").select("confidence").limit(1);
  check("application_answers.confidence no longer exists",
    !!error && /confidence/.test(error.message), error ? "" : "the column still selects");
}

// 2. The token column exists.
{
  const { error } = await db.from("applications").select("attribution_token").limit(1);
  check("applications.attribution_token exists", !error, error?.message ?? "");
}

// 5. Existing rows survived and are still readable.
const { data: existing, error: exErr } = await db.from("applications")
  .select("id,status,attribution_token,all_fields_confident").limit(1000);
check("existing application rows are intact and readable", !exErr, exErr?.message ?? "");
check("every existing application has a null token (none issued yet)",
  (existing ?? []).every((a) => a.attribution_token === null),
  `${(existing ?? []).filter((a) => a.attribution_token !== null).length} already carry one`);

// 3 and 4. The constraints, tested in the failing direction.
/**
 * Four DISTINCT openings, because two other constraints are in the way.
 *
 * applications_one_active_per_canonical_opening and
 * ..._per_job_post are partial unique indexes over non-terminal
 * statuses. Inserting several test applications against one job trips
 * those instead of the token index, which makes a duplicate-token test
 * pass for the wrong reason. Each case below therefore gets its own
 * opening, so the only constraint that can fire is the one under test.
 */
const candidates: Array<{ id: string; versionId: string; openingId: string | null }> = [];
{
  const { data: live } = await db.from("applications")
    .select("canonical_opening_id")
    .not("status", "in", "(WITHDRAWN,ABANDONED,REJECTED)");
  const taken = new Set((live ?? []).map((a: any) => a.canonical_opening_id).filter(Boolean));
  const seen = new Set<string>();
  for (let from = 0; candidates.length < 4 && from < 2000; from += 200) {
    const { data: jobs } = await db.from("jobs")
      .select("id,canonical_opening_id").order("id").range(from, from + 199);
    if (!jobs?.length) break;
    for (const j of jobs) {
      if (candidates.length >= 4) break;
      const key = j.canonical_opening_id ?? j.id;
      if (taken.has(j.canonical_opening_id) || seen.has(key)) continue;
      const { data: v } = await db.from("job_versions")
        .select("id").eq("job_id", j.id).eq("is_current", true).maybeSingle();
      if (!v) continue;
      seen.add(key);
      candidates.push({ id: j.id, versionId: v.id, openingId: j.canonical_opening_id });
    }
  }
}
const anyJob = candidates[0] ? { id: candidates[0].id } : null;
const anyVersion = candidates[0] ? { id: candidates[0].versionId } : null;
check("four distinct unapplied openings are available to test against",
  candidates.length === 4, `found ${candidates.length}`);

const created: string[] = [];
try {
  if (!anyJob || !anyVersion) {
    check("a job and version exist to test against", false, "none found");
  } else {
    const row = (i: number, extra: Record<string, unknown> = {}) => ({
      job_id: candidates[i]!.id, job_version_id: candidates[i]!.versionId,
      status: "DRAFT", is_test: true, ...extra,
    });
    const token = generateAttributionToken();

    const { data: a, error: aErr } = await db.from("applications")
      .insert(row(0, { attribution_token: token })).select("id").single();
    check("a well formed token is accepted", !aErr, aErr?.message ?? "");
    if (a) created.push(a.id);

    // Uniqueness, on a DIFFERENT opening so the token index is the only
    // constraint that can reject it, and named so a pass cannot come
    // from some other index firing.
    const { data: b, error: dupErr } = await db.from("applications")
      .insert(row(1, { attribution_token: token })).select("id").single();
    if (b) created.push(b.id);
    check("a duplicate token is rejected by the token index specifically",
      !!dupErr && /applications_attribution_token_unique/.test(dupErr.message),
      dupErr ? dupErr.message.slice(0, 120) : "the duplicate was ACCEPTED");

    // Two nulls must coexist: the index is partial on purpose.
    const { data: n1, error: n1Err } = await db.from("applications").insert(row(2)).select("id").single();
    if (n1) created.push(n1.id);
    const { data: n2, error: n2Err } = await db.from("applications").insert(row(3)).select("id").single();
    if (n2) created.push(n2.id);
    check("two applications may both have no token", !n1Err && !n2Err,
      `${n1Err?.message ?? ""} ${n2Err?.message ?? ""}`.trim());

    // Shape. Each reuses opening 1, which is free again because the
    // insert that would have occupied it was rejected above.
    for (const [label, bad] of [
      ["too short", "abc"],
      ["illegal characters", "not/a+valid=token/at/all"],
      ["too long", "a".repeat(65)],
      ["empty", ""],
    ] as Array<[string, string]>) {
      const { data: r, error } = await db.from("applications")
        .insert(row(1, { attribution_token: bad })).select("id").single();
      if (r) created.push(r.id);
      check(`a token that is ${label} is rejected`,
        !!error && /attribution_token_is_opaque/.test(error.message),
        error ? error.message.slice(0, 110) : "it was ACCEPTED");
    }
  }
} finally {
  // Applications are append-only: a plain DELETE is refused, silently
  // from the client's point of view, which left four test rows behind on
  // the first two runs of this script. purge_test_application exists for
  // exactly this and refuses anything not marked is_test at creation.
  for (const id of created) {
    const { error } = await db.rpc("purge_test_application", { p_id: id });
    if (error) console.log(`  cleanup failed for ${id}: ${error.message}`);
  }
  // And the cleanup is verified rather than announced.
  const { data: left } = await db.from("applications").select("id").in("id", created.length ? created : ["00000000-0000-0000-0000-000000000000"]);
  check(`all ${created.length} test application row(s) were removed`,
    (left ?? []).length === 0, `${(left ?? []).length} remain: ${(left ?? []).map((r: any) => r.id).join(", ")}`);
}

// 6. No grant widened.
{
  const { data: audit } = await db.rpc("security_audit");
  const EXPECTED = ["application_answers", "applications", "job_interest", "question_bank"];
  const writable = (audit ?? []).filter((r: any) => /INSERT|UPDATE/.test(r.authenticated_privileges))
    .map((r: any) => r.table_name).sort();
  check("the portal role still writes exactly four tables",
    JSON.stringify(writable) === JSON.stringify(EXPECTED), writable.join(", "));
  const deletable = (audit ?? []).filter((r: any) => /DELETE|TRUNCATE/.test(r.authenticated_privileges));
  check("the portal role still deletes nothing", deletable.length === 0,
    deletable.map((r: any) => r.table_name).join(", "));
  const appsRow = (audit ?? []).find((r: any) => r.table_name === "applications");
  check("applications still has RLS enabled", appsRow?.rls_enabled !== false,
    JSON.stringify(appsRow).slice(0, 120));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log("migration 0047 verified");
