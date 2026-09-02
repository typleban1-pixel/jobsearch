/**
 * Is the relationship layer live, does it hold the confirmed facts, and
 * did it leave the granular records alone?
 *
 * The last question is the important one. This whole design exists so
 * that an employer-facing consolidation never edits the record it
 * consolidates, and a verification that did not check the records would
 * be checking the easy half.
 *
 * Read-only except for inserts engineered to be REJECTED, which leave
 * nothing behind.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}\n         ${detail}`); }
};

// The granular records, exactly as they stood before 0056 was written.
const EXPECTED_RECORDS = [
  ["Lorain County Community College", "2016-01-01", "2019-01-01", false],
  ["Genius One, Inc.", "2019-01-01", "2022-01-01", false],
  ["Anytime Picture LLC", "2019-01-01", "2022-01-01", false],
  ["Holley Performance", "2022-01-01", "2024-01-01", false],
  ["Genius One, Inc.", "2024-01-01", null, true],
  ["Anytime Picture LLC", "2024-01-01", "2025-01-01", false],
] as const;

const { data: recs, error: recErr } = await db.from("employment_records")
  .select("id,employer,start_month,end_month,is_current,status,employment_type,start_precision,end_precision")
  .order("start_month").order("employer");
check("the employment records are readable", !recErr, recErr?.message ?? "");

const actual = (recs ?? []).map((r) => [r.employer, r.start_month, r.end_month, r.is_current] as const)
  .sort((a, b) => a[1]!.localeCompare(b[1]!) || a[0]!.localeCompare(b[0]!));
const expected = [...EXPECTED_RECORDS].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
check("all six granular records are present and unchanged",
  JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual));
check("every one is still VERIFIED",
  (recs ?? []).every((r) => r.status === "VERIFIED"), "");
check("and still at YEAR precision",
  (recs ?? []).every((r) => r.start_precision === "YEAR" && (r.end_precision ?? "YEAR") === "YEAR"),
  JSON.stringify((recs ?? []).map((r) => `${r.start_precision}/${r.end_precision}`)));

// ---- the relationships themselves -----------------------------------
const { data: rels, error: relErr } = await db.from("employment_relationships").select("*").order("employer");
check("employment_relationships exists and is readable", !relErr, relErr?.message ?? "");
if (relErr) { console.log(`\n${pass + fails.length} checks, ${pass} passed`); process.exit(1); }

check("exactly two relationships exist", (rels ?? []).length === 2,
  JSON.stringify((rels ?? []).map((r) => r.employer)));

const byEmployer = new Map((rels ?? []).map((r) => [r.employer, r]));
const genius = byEmployer.get("Genius One, Inc.");
const anytime = byEmployer.get("Anytime Picture LLC");

check("Genius One is recorded as continuous from 2019 with no end date",
  genius?.relationship_start === "2019-01-01" && genius?.relationship_end === null,
  JSON.stringify([genius?.relationship_start, genius?.relationship_end]));
check("as contract work with variable workload",
  genius?.employment_type === "CONTRACT" && genius?.workload === "VARIABLE",
  `${genius?.employment_type} / ${genius?.workload}`);
check("labelled Contract, not part-time and not full-time",
  genius?.employer_facing_qualifier === "Contract", String(genius?.employer_facing_qualifier));
check("at YEAR precision on both ends",
  genius?.start_precision === "YEAR" && genius?.end_precision === "YEAR",
  `${genius?.start_precision}/${genius?.end_precision}`);

check("Anytime Picture is recorded as continuous 2019 to 2025",
  anytime?.relationship_start === "2019-01-01" && anytime?.relationship_end === "2025-01-01",
  JSON.stringify([anytime?.relationship_start, anytime?.relationship_end]));
check("as part-time contract work throughout",
  anytime?.employment_type === "CONTRACT" && anytime?.workload === "CONSISTENT_PART_TIME"
  && anytime?.employer_facing_qualifier === "Part-Time Contract",
  `${anytime?.workload} / ${anytime?.employer_facing_qualifier}`);
check("also at YEAR precision",
  anytime?.start_precision === "YEAR" && anytime?.end_precision === "YEAR", "");

check("Holley has no relationship row, because one period needs no consolidating",
  !byEmployer.has("Holley Performance"), "");
check("and neither does the college",
  !byEmployer.has("Lorain County Community College"), "");

// ---- what they point at ---------------------------------------------
const idsFor = (employer: string) => (recs ?? []).filter((r) => r.employer === employer).map((r) => r.id).sort();
check("Genius One covers both of its verified periods and nothing else",
  JSON.stringify([...(genius?.covered_record_ids ?? [])].sort()) === JSON.stringify(idsFor("Genius One, Inc.")),
  JSON.stringify(genius?.covered_record_ids));
check("Anytime Picture likewise",
  JSON.stringify([...(anytime?.covered_record_ids ?? [])].sort()) === JSON.stringify(idsFor("Anytime Picture LLC")),
  JSON.stringify(anytime?.covered_record_ids));
check("each covers exactly two records",
  genius?.covered_record_ids?.length === 2 && anytime?.covered_record_ids?.length === 2, "");

// ---- provenance ------------------------------------------------------
for (const r of rels ?? []) {
  check(`the ${r.employer} relationship names a human confirmation`,
    String(r.confirmed_by).startsWith("user:") && String(r.continuity_basis).includes("HUMAN_CONFIRMED"),
    `${r.confirmed_by}: ${String(r.continuity_basis).slice(0, 60)}`);
}
const { data: log } = await db.from("truth_change_log")
  .select("actor,source_table,new_data").eq("source_table", "employment_relationships");
check("both are recorded in the truth change log by a human actor",
  (log ?? []).length === 2 && (log ?? []).every((l) => l.actor === "user:human_confirmed"),
  JSON.stringify((log ?? []).map((l) => l.actor)));

// ---- the trigger, exercised by writes that must fail -----------------
const probe = (over: Record<string, unknown>) => ({
  employer: "Holley Performance",
  display_title: "Videographer & Editor",
  employer_facing_qualifier: null,
  relationship_start: "2022-01-01", relationship_end: "2024-01-01",
  start_precision: "YEAR", end_precision: "YEAR",
  employment_type: "FULL_TIME", workload: "CONSISTENT_FULL_TIME",
  covered_record_ids: idsFor("Holley Performance"),
  continuity_basis: "probe row that must never be accepted, written by the verifier",
  confirmed_by: "user:verifier",
  ...over,
});

const early = await db.from("employment_relationships").insert(probe({ relationship_start: "2020-01-01" }));
check("a relationship starting before its earliest verified period is refused",
  Boolean(early.error) && /never begins before/.test(early.error!.message), early.error?.message ?? "IT WAS ACCEPTED");

const late = await db.from("employment_relationships").insert(probe({ relationship_end: "2026-01-01" }));
check("one ending after its latest verified period is refused",
  Boolean(late.error) && /dates are never extended/.test(late.error!.message), late.error?.message ?? "IT WAS ACCEPTED");

const sharpened = await db.from("employment_relationships").insert(probe({ start_precision: "MONTH" }));
check("one sharpening YEAR precision to MONTH is refused",
  Boolean(sharpened.error) && /precision is never upgraded/.test(sharpened.error!.message),
  sharpened.error?.message ?? "IT WAS ACCEPTED");

const mixed = await db.from("employment_relationships").insert(probe({
  covered_record_ids: [...idsFor("Holley Performance"), ...idsFor("Genius One, Inc.")] }));
check("one covering another employer's records is refused",
  Boolean(mixed.error), mixed.error?.message ?? "IT WAS ACCEPTED");

const machine = await db.from("employment_relationships").insert(probe({ confirmed_by: "system:inferred" }));
check("one confirmed by anything other than a person is refused",
  Boolean(machine.error), machine.error?.message ?? "IT WAS ACCEPTED");

const thin = await db.from("employment_relationships").insert(probe({ continuity_basis: "obvious" }));
check("one with no stated basis is refused",
  Boolean(thin.error), thin.error?.message ?? "IT WAS ACCEPTED");

const second = await db.from("employment_relationships").insert(probe({
  employer: "Genius One, Inc.", covered_record_ids: idsFor("Genius One, Inc."),
  relationship_start: "2019-01-01", relationship_end: null }));
check("a second relationship for one employer is refused",
  Boolean(second.error) && /relationship_one_per_employer/.test(second.error!.message),
  second.error?.message ?? "IT WAS ACCEPTED");

const { count: after } = await db.from("employment_relationships").select("*", { count: "exact", head: true });
check("none of the refused writes left a row behind", after === 2, `${after} rows`);

const { data: recsAfter } = await db.from("employment_records").select("id,employer,start_month,end_month,is_current");
check("and the granular records are still exactly as they were",
  JSON.stringify((recsAfter ?? []).map((r) => [r.employer, r.start_month, r.end_month, r.is_current])
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])) || String(a[0]).localeCompare(String(b[0]))))
  === JSON.stringify(expected), "");

console.log(`\n${pass + fails.length} checks, ${pass} passed`);
if (fails.length) { console.log(`${fails.length} FAILED`); process.exit(1); }
console.log("0056 is live");
