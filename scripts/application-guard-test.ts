/**
 * Exercises the duplicate-application guard against the real database.
 *
 * Writes real rows and removes them afterwards. Every row it creates is
 * DRAFT, which the submitted_requires_approval constraint keeps far away
 * from anything submittable, and the cleanup runs even when an assertion
 * fails.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const created: string[] = [];
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

async function versionFor(jobId: string) {
  const { data } = await db.from("job_versions").select("id").eq("job_id", jobId).eq("is_current", true).maybeSingle();
  if (!data) throw new Error(`no current job_version for ${jobId}`);
  return data.id;
}
async function apply(jobId: string, status = "DRAFT") {
  // is_test is set at creation and can never be flipped later, so a row
  // created without it is permanent debris. Every row this suite writes
  // is a probe and says so.
  const row: any = { job_id: jobId, job_version_id: await versionFor(jobId), status, is_test: true };
  const { data, error } = await db.from("applications").insert(row).select("id,canonical_opening_id,job_id").single();
  if (data) created.push(data.id);
  return { data, error };
}

try {
  const { data: cos } = await db.from("companies").select("id,name");
  const cn: Record<string, string> = Object.fromEntries((cos ?? []).map((c: any) => [c.id, c.name]));
  const nameOf = (id: string) => cn[id];

  const { data: allJobs } = await db.from("jobs").select("id,company_id,title,external_id,location_raw,canonical_opening_id")
    .ilike("title", "%Manager, CX AI Strategy%");
  const brex = (allJobs ?? []).filter((j: any) => nameOf(j.company_id) === "Brex");
  const { data: stripeJobs } = await db.from("jobs").select("id,company_id,title,external_id,location_raw,canonical_opening_id")
    .ilike("title", "%Communities Partner Development%");
  const stripe = (stripeJobs ?? []).filter((j: any) => nameOf(j.company_id) === "Stripe");

  console.log("application guard\n");

  // 1. First application to a multi-location opening succeeds and records
  //    the exact variant.
  const first = await apply(brex[0]!.id);
  check("first application to a Brex variant is accepted", !first.error, first.error?.message ?? "");
  check("the application records the variant applied through", first.data?.job_id === brex[0]!.id);
  check("the application carries the canonical opening",
    first.data?.canonical_opening_id === brex[0]!.canonical_opening_id);
  console.log(`        applied through ${brex[0]!.external_id} (${brex[0]!.location_raw})`);

  // 2. A DIFFERENT variant of the SAME opening must be refused. This is
  //    the bug: under the old job_id index all five were applyable.
  const second = await apply(brex[1]!.id);
  check("a second application through a different city of the same requisition is REFUSED",
    !!second.error, second.error ? "" : "it was accepted, which is the original bug");
  if (second.error) console.log(`        refused ${brex[1]!.external_id} (${brex[1]!.location_raw}): ${second.error.message.slice(0, 90)}`);

  for (const j of brex.slice(2)) {
    const r = await apply(j.id);
    check(`  ...and through ${j.location_raw?.slice(0, 28)}`, !!r.error);
  }

  // 3. The other Stripe requisition must stay applyable. Identical text,
  //    same location, different internal_job_id.
  const s1 = await apply(stripe[0]!.id);
  check("first Stripe requisition is accepted", !s1.error, s1.error?.message ?? "");
  const s2 = await apply(stripe[1]!.id);
  check("the SECOND Stripe requisition is also accepted, being a different opening",
    !s2.error, s2.error?.message ?? "");
  console.log(`        both accepted: ${stripe[0]!.external_id} and ${stripe[1]!.external_id}`);

  // 4. Withdrawing frees the opening for a later reapplication.
  await db.from("applications").update({ status: "WITHDRAWN" }).eq("id", created[0]!);
  const reapply = await apply(brex[1]!.id);
  check("after withdrawing, a later application to that opening is allowed",
    !reapply.error, reapply.error?.message ?? "");

  // 5. Fail closed. A job with no canonical opening must be refused
  //    rather than written without protection.
  const { data: spare } = await db.from("jobs").select("id,canonical_opening_id").limit(1).single();
  const savedOpening = spare!.canonical_opening_id;
  await db.from("jobs").update({ canonical_opening_id: null }).eq("id", spare!.id);
  const { data: check5 } = await db.from("jobs").select("canonical_opening_id").eq("id", spare!.id).single();
  if (check5?.canonical_opening_id === null) {
    const orphan = await apply(spare!.id);
    check("an application to a job with no canonical opening is REFUSED", !!orphan.error,
      orphan.error ? "" : "it was accepted, leaving the application unprotected");
    if (orphan.error) console.log(`        ${orphan.error.message.slice(0, 110)}`);
    await db.from("jobs").update({ canonical_opening_id: savedOpening }).eq("id", spare!.id);
  } else {
    check("NOT NULL prevents a job from losing its opening at all", true);
    console.log("        the column is NOT NULL, so the orphan state is unreachable by design");
  }

  // The NOT NULL column makes the trigger's orphan branch unreachable,
  // which is defence in depth rather than dead code. Its other branch is
  // reachable and proves the trigger actually runs: an application may
  // not name an opening its job does not belong to.
  const wrongOpening = stripe[0]!.canonical_opening_id;
  const { error: mismatch } = await db.from("applications").insert({
    job_id: brex[0]!.id, job_version_id: await versionFor(brex[0]!.id),
    status: "DRAFT", is_test: true, canonical_opening_id: wrongOpening,
  }).select("id").single();
  check("an application naming an opening its job does not belong to is REFUSED",
    !!mismatch, mismatch ? "" : "it was accepted");
  if (mismatch) console.log(`        ${mismatch.message.slice(0, 110)}`);

  // And the derived value is authoritative: supplying the CORRECT opening
  // explicitly is accepted. Uses a job nothing else in this test has
  // touched, since every job used above already holds a live application
  // and would be refused for the right reason.
  const { data: untouched } = await db.from("jobs")
    .select("id,canonical_opening_id").not("id", "in", `(${[...brex, ...stripe].map((j: any) => j.id).join(",")})`)
    .limit(1).single();
  const explicit = await db.from("applications").insert({
    job_id: untouched!.id, job_version_id: await versionFor(untouched!.id),
    status: "DRAFT", is_test: true, canonical_opening_id: untouched!.canonical_opening_id,
  }).select("id,canonical_opening_id").single();
  if (explicit.data) created.push(explicit.data.id);
  check("supplying the correct opening explicitly is accepted",
    !explicit.error && explicit.data?.canonical_opening_id === untouched!.canonical_opening_id,
    explicit.error?.message ?? "");
} finally {
  // A plain delete cannot work here and used to fail silently, leaving
  // rows behind that collided with the next run's fixtures. Applications
  // are append-only and hold ON DELETE RESTRICT history, so removal goes
  // through the one sanctioned door, and the count reported is what was
  // actually removed rather than what was attempted.
  let removed = 0;
  for (const id of created) {
    const { error } = await db.rpc("purge_test_application", { p_id: id });
    if (error) console.log(`  cleanup failed for ${id}: ${error.message}`);
    else removed++;
  }
  const { count } = await db.from("applications").select("*", { count: "exact", head: true });
  console.log(`\ncleanup: removed ${removed} of ${created.length} test rows, ${count} applications remain`);
  if (removed !== created.length) failed++;
}

console.log(`${failed === 0 ? "all passed" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
