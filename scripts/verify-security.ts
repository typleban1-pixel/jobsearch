/**
 * Proves the database is safe on its own, with the frontend bypassed
 * entirely.
 *
 * Everything here talks to PostgREST directly with raw keys. The portal's
 * checks are not exercised and are not the subject: the question is what
 * someone can do with a key and an HTTP client, which is the question
 * that matters once this is on the internet.
 *
 *   node scripts/verify-security.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { optional, required } from "../lib/env.ts";

const URL = required("SUPABASE_URL");
const ANON = optional("SUPABASE_PUBLISHABLE_KEY") ?? optional("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
          ?? optional("SUPABASE_ANON_KEY") ?? optional("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = required("SUPABASE_SERVICE_ROLE_KEY");

if (!ANON) {
  console.error("Missing the publishable key. Add SUPABASE_PUBLISHABLE_KEY to .env.local.");
  process.exit(2);
}

const anon = createClient(URL, ANON, { auth: { persistSession: false } });
const service = createClient(URL, SERVICE, { auth: { persistSession: false } });

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

/** A read is blocked when it errors OR returns nothing. Both are acceptable; data is not. */
async function cannotRead(client: SupabaseClient, table: string): Promise<{ ok: boolean; why: string }> {
  const { data, error } = await client.from(table).select("*").limit(1);
  if (error) return { ok: true, why: error.message.slice(0, 60) };
  return { ok: (data ?? []).length === 0, why: `returned ${(data ?? []).length} row(s)` };
}

const SENSITIVE = [
  "profile", "evidence", "employment_records", "metrics", "skills", "education",
  "credential_declarations", "operating_policy", "resumes", "resume_claims",
  "applications", "truth_change_log", "profile_version_rows", "job_interest",
  "openings", "job_locations", "job_scores", "jobs",
];

console.log("ANON KEY, THE VALUE ANY BROWSER CAN READ\n");
for (const t of SENSITIVE) {
  const r = await cannotRead(anon, t);
  check(`anon cannot SELECT ${t}`, r.ok, r.why);
}

const { error: insErr } = await anon.from("job_interest")
  .insert({ canonical_opening_id: "00000000-0000-0000-0000-000000000000", state: "SAVED" });
check("anon cannot INSERT", !!insErr, insErr ? "" : "the insert was accepted");

const { error: updErr, count: updCount } = await anon.from("job_interest")
  .update({ state: "SAVED" }, { count: "exact" }).neq("id", "00000000-0000-0000-0000-000000000000");
check("anon cannot UPDATE", !!updErr || updCount === 0, updErr ? "" : `updated ${updCount} row(s)`);

const { error: delErr, count: delCount } = await anon.from("job_interest")
  .delete({ count: "exact" }).neq("id", "00000000-0000-0000-0000-000000000000");
check("anon cannot DELETE", !!delErr || delCount === 0, delErr ? "" : `deleted ${delCount} row(s)`);

// TRUNCATE is not expressible through PostgREST, so the grant is the
// thing to assert. security_audit() reports it.
const { data: auditAnon } = await service.rpc("security_audit");
const anonGrants = (auditAnon ?? []).filter((r: any) => r.anon_privileges !== "none");
check("anon holds no table privilege at all, so TRUNCATE is unreachable", anonGrants.length === 0,
  anonGrants.map((r: any) => `${r.table_name}=${r.anon_privileges}`).join(", "));

const { error: rpcErr } = await anon.rpc("is_app_owner");
check("anon cannot call is_app_owner()", !!rpcErr, rpcErr ? "" : "the call succeeded");

console.log("\nSIGNED IN, BUT NOT THE OWNER\n");
const strangerEmail = `verify-${Date.now()}@example.invalid`;
const strangerPassword = `pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const { data: created, error: createErr } = await service.auth.admin.createUser({
  email: strangerEmail, password: strangerPassword, email_confirm: true,
});
if (createErr || !created.user) {
  check("could create a non-owner test user", false, createErr?.message ?? "no user returned");
} else {
  const stranger = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error: signInErr } = await stranger.auth.signInWithPassword({
    email: strangerEmail, password: strangerPassword,
  });
  check("a non-owner can hold a valid session", !signInErr, signInErr?.message ?? "");

  for (const t of ["profile", "evidence", "credential_declarations", "job_interest", "job_scores", "jobs"]) {
    const r = await cannotRead(stranger, t);
    check(`authenticated non-owner reads nothing from ${t}`, r.ok, r.why);
  }
  const { error: sIns } = await stranger.from("job_interest")
    .insert({ canonical_opening_id: "00000000-0000-0000-0000-000000000000", state: "SAVED" });
  check("authenticated non-owner cannot INSERT", !!sIns, sIns ? "" : "the insert was accepted");

  const { error: sUpd, count: sCount } = await stranger.from("job_interest")
    .update({ state: "SAVED" }, { count: "exact" }).neq("id", "00000000-0000-0000-0000-000000000000");
  check("authenticated non-owner cannot UPDATE", !!sUpd || sCount === 0, sUpd ? "" : `updated ${sCount} row(s)`);

  const { data: ownerCheck } = await stranger.rpc("is_app_owner");
  check("is_app_owner() is false for a non-owner", ownerCheck === false, `got ${JSON.stringify(ownerCheck)}`);

  await stranger.auth.signOut();
  await service.auth.admin.deleteUser(created.user.id);
  console.log("  (test user removed)");
}

console.log("\nTHE OWNER PATH\n");

/**
 * Tested with a temporary account added to app_owner, not with the real
 * owner's credentials.
 *
 * Setting a password on the actual account to make a test convenient
 * would be changing a person's credentials for the tester's benefit. The
 * membership row is what is_app_owner() reads, so granting it to a
 * throwaway user exercises exactly the same policy path, and it is
 * removed at the end.
 */
const tempEmail = `owner-path-${Date.now()}@example.invalid`;
const tempPassword = `pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const { data: tempUser, error: tempErr } = await service.auth.admin.createUser({
  email: tempEmail, password: tempPassword, email_confirm: true,
});
if (tempErr || !tempUser.user) {
  check("could create a temporary owner-path user", false, tempErr?.message ?? "");
} else {
  const { error: grantErr } = await service.from("app_owner")
    .insert({ user_id: tempUser.user.id, email: tempEmail });
  check("temporary user added to app_owner", !grantErr, grantErr?.message ?? "");

  const owner = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error: oErr } = await owner.auth.signInWithPassword({ email: tempEmail, password: tempPassword });
  check("owner can sign in with email and password", !oErr, oErr?.message ?? "");

  if (!oErr) {
    const { data: isOwner } = await owner.rpc("is_app_owner");
    check("is_app_owner() is true", isOwner === true, `got ${JSON.stringify(isOwner)}`);

    for (const t of ["job_scores", "jobs", "score_reasons", "job_locations", "openings", "companies", "job_interest"]) {
      const { data, error } = await owner.from(t).select("*").limit(1);
      check(`owner can read ${t}, which the portal renders`, !error, error?.message ?? "");
      if (!error && t === "job_scores") check("  and actually receives rows", (data ?? []).length > 0);
    }

    const { data: anOpening } = await owner.from("openings").select("id").limit(1).single();
    const { error: wErr } = await owner.from("job_interest").upsert(
      { canonical_opening_id: anOpening!.id, state: "UNDECIDED", updated_at: new Date().toISOString() },
      { onConflict: "canonical_opening_id" },
    );
    check("owner can create or update job_interest", !wErr, wErr?.message ?? "");

    const { error: oDel, count: oDelCount } = await owner.from("job_interest")
      .delete({ count: "exact" }).eq("canonical_opening_id", anOpening!.id);
    check("owner CANNOT delete, even their own row", !!oDel || oDelCount === 0,
      oDel ? "" : `deleted ${oDelCount} row(s)`);

    console.log("\n  worker-write-only tables must reject the portal user:");
    const workerOnly: Array<[string, Record<string, unknown>]> = [
      ["job_scores", { job_id: "00000000-0000-0000-0000-000000000000", fit_score: 99, profile_version: 5, weights_version: 5, extraction_version: 3 }],
      ["jobs", { company_id: "00000000-0000-0000-0000-000000000000", source: "X", external_id: "x", title: "x", normalized_title: "x" }],
      ["job_locations", { job_id: "00000000-0000-0000-0000-000000000000", position: 0, provenance: "PROVIDER_LOCATION_FIELD", confidence: "EXACT", raw_segment: "x", parser_version: 1 }],
      ["openings", { company_id: "00000000-0000-0000-0000-000000000000", source: "X", identity_method: "SINGLETON", representative_title: "x" }],
      ["corpus_statistics", { label: "x", document_frequencies: {}, job_count: 1, concept_count: 1, statistics_hash: "x" }],
      ["truth_change_log", { source_table: "x", operation: "INSERT" }],
    ];
    for (const [t, row] of workerOnly) {
      const { error } = await owner.from(t).insert(row as any);
      check(`  cannot INSERT into ${t}`, !!error, error ? "" : "the insert was ACCEPTED");
    }

    // The truth profile is READ-ONLY to the browser role. 0034 removed
    // the write grants 0007 had handed out for editing surfaces that were
    // never built.
    //
    // Asserted through the grant rather than by inserting. An earlier
    // version of this test wrote rows into evidence and skills to prove
    // the point, which is not a thing a security test should do to the
    // data it is protecting.
    console.log("\n  truth profile is read-only to the portal role:");
    const { data: audit } = await service.rpc("security_audit");
    // The truth profile proper. applications, application_answers and
    // question_bank left this list when the application phase was built
    // in 0042: the portal now writes them, deliberately and narrowly, and
    // they are asserted separately below. Nothing else moved.
    const TRUTH = [
      "evidence", "skills", "employment_records", "metrics", "projects", "education",
      "credential_declarations", "resumes",
      "resume_claims", "profile", "location_preferences", "work_preferences",
      "skill_evidence", "suggested_skills", "scoring_weights", "app_owner",
    ];
    for (const t of TRUTH) {
      const row = (audit ?? []).find((r: any) => r.table_name === t);
      const writable = /INSERT|UPDATE|DELETE|TRUNCATE/.test(row?.authenticated_privileges ?? "");
      check(`  ${t} is read-only`, !writable, `privileges: ${row?.authenticated_privileges}`);
    }

    // And the grant is not the only thing stopping it: try the write.
    console.log("\n  and the writes actually fail:");
    for (const [t, row] of [
      ["evidence", { summary: "should not be written" }],
      ["skills", { name: "should not be written" }],
      ["resumes", { label: "should not be written", content: {} }],
      ["resume_claims", { claim: "should not be written" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const { error } = await owner.from(t).insert(row as any);
      check(`  cannot INSERT into ${t}`, !!error, error ? "" : "the insert was ACCEPTED");
    }

    // The writable set, named exactly.
    //
    // An application is created and reviewed in the portal, so those
    // three tables are writable by design. The check is not "how many"
    // but "which": a set comparison fails on anything unexpected
    // appearing, and equally on one of these silently disappearing.
    //
    // Notably absent and staying absent: application_events. The audit
    // trail is written by triggers, so the role that makes the
    // transitions cannot edit the record of them.
    const EXPECTED_WRITABLE = ["application_answers", "applications", "job_interest", "question_bank"];
    const writableTables = (audit ?? [])
      .filter((r: any) => /INSERT|UPDATE/.test(r.authenticated_privileges))
      .map((r: any) => r.table_name).sort();
    check(`the portal role writes exactly the four tables the UI writes (${writableTables.join(", ")})`,
      JSON.stringify(writableTables) === JSON.stringify(EXPECTED_WRITABLE),
      `expected ${EXPECTED_WRITABLE.join(", ")}`);

    const noDelete = (audit ?? []).filter((r: any) => /DELETE|TRUNCATE/.test(r.authenticated_privileges));
    check("the portal role can delete nothing at all", noDelete.length === 0,
      noDelete.map((r: any) => r.table_name).join(", "));

    const { error: bumpErr } = await owner.rpc("bump_profile_version", { p_reason: "should not be callable" });
    check("  cannot cut a profile version", !!bumpErr, bumpErr ? "" : "the call succeeded");

    await owner.auth.signOut();
  }

  // Remove the membership first: a leftover app_owner row would be a
  // second account with full access to everything.
  await service.from("app_owner").delete().eq("user_id", tempUser.user.id);
  await service.auth.admin.deleteUser(tempUser.user.id);
  const { data: owners } = await service.from("app_owner").select("user_id,email");
  check("app_owner is back to exactly one account", (owners ?? []).length === 1,
    JSON.stringify(owners));
  console.log("  (temporary owner-path user removed)");
}

console.log(`\n${failed === 0 ? "all passed" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
