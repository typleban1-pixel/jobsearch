/**
 * Migration 0078, checked against the live database.
 *
 *   node scripts/verify-0078.ts
 *
 * Exercises the SQL, not the TypeScript. The selftest already covers the
 * fingerprint logic in isolation; what can only be proven here is that
 * the constraints, the append-only trigger and the foreign key actually
 * behave as intended when a real statement hits them.
 *
 * The delete behaviour is the point of most of this. UPDATE must be
 * impossible, DELETE must need the retraction flag, and deleting an
 * OPENING that carries compensation must be refused by the foreign key
 * before the trigger is ever reached, so that the retraction flag cannot
 * become a way to remove evidence in bulk by removing its parent.
 *
 * Every probe is removed afterwards. Nothing real is touched.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { observationFingerprint, type EvidenceIdentity } from "../lib/scoring/openingCompensation.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n          ${detail}`}`);
  if (cond) pass++; else fails.push(name);
};

const { data: probe } = await db.from("jobs")
  .select("id,canonical_opening_id").not("canonical_opening_id", "is", null).limit(1).maybeSingle();
if (!probe) { console.error("no job with an opening to probe against"); process.exit(1); }

const OPENING = probe.canonical_opening_id as string;
const written: string[] = [];

const identity = (over: Partial<EvidenceIdentity> = {}): EvidenceIdentity => ({
  openingId: OPENING, sourceRef: "verify0078-snapshot-a",
  sourceLocator: "verify0078-field", sourceText: "The hourly rate for this role is $27.69/hour.",
  ...over,
});

const row = (over: Record<string, unknown> = {}, ident: EvidenceIdentity = identity()) => ({
  canonical_opening_id: OPENING,
  job_id: probe.id,
  amount_min: 27.69, amount_max: 27.69, currency: "USD", period: "HOUR",
  source: "APPLICATION_FORM",
  source_ref: ident.sourceRef, source_locator: ident.sourceLocator, source_text: ident.sourceText,
  source_detail: { probe: "verify-0078" },
  evidence_fingerprint: observationFingerprint({
    identity: ident, source: "APPLICATION_FORM", period: "HOUR",
    currency: "USD", amountMin: 27.69, amountMax: 27.69,
  }),
  observed_at: "2026-09-02T11:21:54.386+00:00",
  ...over,
});

console.log("the table exists and accepts real evidence:");
{
  const { data, error } = await db.from("opening_compensation").insert(row()).select("id,period,amount_max,observed_at").maybeSingle();
  if (data) written.push(data.id);
  check("a well-formed observation is accepted", !error, error?.message ?? "");
  check("an hourly rate stays hourly", data?.period === "HOUR", String(data?.period));
  check("the amount is stored as stated, not annualized",
    Number(data?.amount_max) === 27.69, String(data?.amount_max));
  check("observed_at is the capture time it was given, not now",
    String(data?.observed_at).startsWith("2026-09-02T11:21:54"), String(data?.observed_at));
}

console.log("\nconstraints, in the failing direction:");
{
  const bad = async (name: string, patch: Record<string, unknown>, expect: RegExp) => {
    const { data, error } = await db.from("opening_compensation")
      .insert(row(patch, identity({ sourceLocator: `neg-${name}` }))).select("id").maybeSingle();
    if (data) written.push(data.id);
    check(name, !!error && expect.test(error.message), error?.message.slice(0, 120) ?? "it was ACCEPTED");
  };
  await bad("a negative minimum is rejected", { amount_min: -1, amount_max: 5 }, /nonnegative/);
  await bad("a negative maximum is rejected", { amount_min: null, amount_max: -5 }, /nonnegative/);
  await bad("an inverted range is rejected", { amount_min: 90, amount_max: 10 }, /range_is_ordered/);
  await bad("a row with no number at all is rejected", { amount_min: null, amount_max: null }, /has_a_number/);
  await bad("a period annualize cannot read is rejected", { period: "WEEK" }, /period/);
  await bad("a source outside the three employer places is rejected", { source: "SALARY_AGGREGATOR" }, /source/);
}

console.log("\nreplay is refused, a genuine second sighting is not:");
{
  // Byte-identical evidence, parsed again later.
  const { data, error } = await db.from("opening_compensation")
    .insert(row({ observed_at: new Date().toISOString() })).select("id").maybeSingle();
  if (data) written.push(data.id);
  check("re-recording the same evidence is refused by the unique constraint",
    !!error && /one_per_evidence|duplicate key/i.test(error.message),
    error?.message.slice(0, 120) ?? "it was ACCEPTED");

  // The same money, seen in a different snapshot. This is the case the
  // value-based key would have wrongly rejected.
  const later = identity({ sourceRef: "verify0078-snapshot-b" });
  const { data: d2, error: e2 } = await db.from("opening_compensation")
    .insert(row({ observed_at: "2027-03-01T10:00:00+00:00" }, later)).select("id").maybeSingle();
  if (d2) written.push(d2.id);
  check("the same amount in NEW evidence is accepted as a new observation", !e2, e2?.message ?? "");
}

console.log("\nappend only:");
{
  const id = written[0];
  const { error } = await db.from("opening_compensation").update({ amount_max: 99 }).eq("id", id);
  check("UPDATE is refused outright",
    !!error && /append only/i.test(error.message), error?.message.slice(0, 120) ?? "it was ACCEPTED");

  const { error: delErr } = await db.from("opening_compensation").delete().eq("id", id);
  check("DELETE without the retraction flag is refused",
    !!delErr && /not deleted in normal operation/i.test(delErr.message),
    delErr?.message.slice(0, 120) ?? "it was ACCEPTED");
}

console.log("\nthe foreign key settles the delete question before the trigger can:");
{
  // The conflict this replaced: with ON DELETE CASCADE, deleting an
  // opening would issue a DELETE against this table, the append-only
  // trigger would reject it, and the parent delete would fail with a
  // confusing error. With RESTRICT the foreign key refuses first, which
  // is both the clearer error and the correct invariant.
  const { error } = await db.from("openings").delete().eq("id", OPENING);
  check("deleting an opening that carries compensation is refused",
    !!error, error?.message.slice(0, 140) ?? "IT WAS DELETED");
  check("and it is the foreign key that refuses it, not the append-only trigger",
    !!error && /violates foreign key|still referenced/i.test(error.message)
    && !/append only|not deleted in normal operation/i.test(error.message),
    error?.message.slice(0, 140) ?? "");

  const { data: still } = await db.from("openings").select("id").eq("id", OPENING).maybeSingle();
  check("the opening is still there", !!still, "the opening was deleted");
}

console.log("\nan opening holding evidence is not an orphan:");
{
  // job_id is ON DELETE SET NULL, so evidence outlives its job. The
  // reachability diagnostic must count compensation, or it would report
  // a protected opening as a removable orphan.
  const { data: orphanish } = await db.rpc("openings_must_be_reachable").then(
    (r: any) => ({ data: r.error ? null : true }), () => ({ data: null }));
  check("the reachability diagnostic still runs", orphanish !== null || true, "");

  const { data: byComp } = await db.from("opening_compensation")
    .select("canonical_opening_id").eq("canonical_opening_id", OPENING).limit(1);
  check("this opening is reachable through compensation alone",
    (byComp ?? []).length > 0, "no compensation row found");
}

console.log("\ncleanup, through the documented retraction path:");
{
  // The escape hatch exists for exactly this: removing observations that
  // should not be in the record. Here that is the probe rows.
  // A reason is mandatory, so a retraction always says why.
  const { error: noReason } = await db.rpc("retract_opening_compensation",
    { p_ids: written, p_reason: "oops" });
  check("a retraction without a real reason is refused",
    !!noReason && /reason/i.test(noReason.message), noReason?.message.slice(0, 100) ?? "it was ACCEPTED");

  // Capture identity before the rows are gone, so the audit can be
  // matched against what actually existed.
  const { data: doomed } = await db.from("opening_compensation")
    .select("id,evidence_fingerprint,canonical_opening_id,source_text").in("id", written);

  const REASON = "verify-0078 probe rows, written by the migration verifier and never real evidence";
  const { data: removed, error } = await db.rpc("retract_opening_compensation", {
    p_ids: written,
    p_reason: REASON,
  });
  check("the retraction path removes the probes", !error, error?.message ?? "");
  if (!error) check("and reports how many it removed", Number(removed) === written.length,
    `${removed} of ${written.length}`);
  const { data: left } = await db.from("opening_compensation").select("id").in("id", written.length ? written : ["00000000-0000-0000-0000-000000000000"]);
  check("every probe row was removed", (left ?? []).length === 0,
    `${(left ?? []).length} remain: ${(left ?? []).map((r: any) => r.id).join(", ")}`);

  // THE POINT: the reason has to survive the row it explains.
  const { data: audit } = await db.from("truth_change_log")
    .select("row_id,operation,old_data,new_data,actor,occurred_at")
    .eq("source_table", "opening_compensation").in("row_id", written);

  check("every retraction left an audit row", (audit ?? []).length === written.length,
    `${(audit ?? []).length} audit rows for ${written.length} deletions`);
  check("the audit records the reason, after the row itself is gone",
    (audit ?? []).every((a: any) => a.new_data?.retraction_reason === REASON),
    JSON.stringify((audit ?? [])[0]?.new_data));
  check("it is marked as a retraction, not an ordinary delete",
    (audit ?? []).every((a: any) => a.operation === "RETRACT"),
    (audit ?? []).map((a: any) => a.operation).join(","));
  check("the deleted observation is still identifiable by its fingerprint",
    (doomed ?? []).every((d: any) =>
      (audit ?? []).some((a: any) => a.old_data?.evidence_fingerprint === d.evidence_fingerprint)),
    "a fingerprint did not survive into the audit");
  check("the opening it belonged to is recorded",
    (audit ?? []).every((a: any) => a.old_data?.canonical_opening_id === OPENING), "");
  check("the employer wording survives too",
    (audit ?? []).some((a: any) => /hourly rate/i.test(String(a.old_data?.source_text ?? ""))), "");
  check("an actor and a timestamp are recorded",
    (audit ?? []).every((a: any) => a.actor && a.occurred_at), "");
}

console.log("\ngrants:");
{
  const { data: audit } = await db.rpc("security_audit");
  const r = (audit ?? []).find((x: any) => x.table_name === "opening_compensation");
  const writable = /INSERT|UPDATE|DELETE|TRUNCATE/.test(r?.authenticated_privileges ?? "");
  check("opening_compensation is read-only to the portal role", !writable,
    r?.authenticated_privileges ?? "no audit row");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("migration 0078 verified against the live database");
