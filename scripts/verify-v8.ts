/**
 * What version 8 froze, what it left alone, and what a resume built from
 * it will actually say.
 *
 * The frozen snapshot is what preparation reads, so a relationship that
 * exists live but not in the version authorizes nothing. Read-only.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { composeResume } from "../lib/render/resume.ts";
import { assertChronologyIntact } from "../lib/render/chronology.ts";
import { renderResume } from "../lib/render/resumePdf.ts";
import type { EmploymentRelationship } from "../lib/render/relationships.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}\n         ${detail}`); }
};

const { data: live } = await db.from("profile").select("profile_version").eq("singleton", true).single();
check("the live profile is at version 8", live!.profile_version === 8, String(live!.profile_version));

const { data: v8 } = await db.from("profile_versions").select("*").eq("version", 8).single();
check("version 8 is registered with its reason", Boolean(v8?.reason?.includes("HUMAN_CONFIRMED")), String(v8?.reason).slice(0, 60));
console.log(`         ${v8?.row_count} rows, truth hash ${v8?.truth_hash}`);

const rows = await (async () => {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from("profile_version_rows").select("row_id,source_table,row_data")
      .eq("profile_version", 8).range(from, from + 999).order("row_id");
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
})();
check("all frozen rows load", rows.length === v8!.row_count, `${rows.length} of ${v8!.row_count}`);

const composition: Record<string, number> = {};
for (const r of rows) composition[r.source_table] = (composition[r.source_table] ?? 0) + 1;
check("version 8 froze the two employment relationships",
  composition["employment_relationships"] === 2, JSON.stringify(composition));
check("alongside all six granular employment records, untouched",
  composition["employment_records"] === 6, JSON.stringify(composition));
check("it is exactly version 7 plus those two rows",
  v8!.row_count === 256, `${v8!.row_count} rows`);

const frozen = rows.filter((r) => r.source_table === "employment_relationships").map((r) => r.row_data);
const genius = frozen.find((r) => r.employer === "Genius One, Inc.");
const anytime = frozen.find((r) => r.employer === "Anytime Picture LLC");

check("the frozen Genius relationship runs 2019 to present as contract work",
  genius?.relationship_start === "2019-01-01" && genius?.relationship_end === null
  && genius?.employment_type === "CONTRACT" && genius?.workload === "VARIABLE"
  && genius?.employer_facing_qualifier === "Contract", JSON.stringify(genius));
check("the frozen Anytime relationship runs 2019 to 2025 as part-time contract work",
  anytime?.relationship_start === "2019-01-01" && anytime?.relationship_end === "2025-01-01"
  && anytime?.workload === "CONSISTENT_PART_TIME"
  && anytime?.employer_facing_qualifier === "Part-Time Contract", JSON.stringify(anytime));
check("both are frozen at YEAR precision",
  [genius, anytime].every((r) => r?.start_precision === "YEAR" && r?.end_precision === "YEAR"), "");
check("both carry their human confirmation into the version",
  [genius, anytime].every((r) => String(r?.confirmed_by).startsWith("user:")
    && String(r?.continuity_basis).includes("HUMAN_CONFIRMED")), "");

const recordIds = new Set(rows.filter((r) => r.source_table === "employment_records").map((r) => r.row_id));
check("every covered record id points at a record frozen in this same version",
  frozen.every((r) => (r.covered_record_ids ?? []).every((id: string) => recordIds.has(id))),
  JSON.stringify(frozen.map((r) => r.covered_record_ids)));

// The employment records themselves must be identical to version 7's.
const v7rows = await (async () => {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from("profile_version_rows").select("row_id,source_table,row_data")
      .eq("profile_version", 7).range(from, from + 999).order("row_id");
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
})();
const empOf = (list: any[]) => JSON.stringify(list.filter((r) => r.source_table === "employment_records")
  .map((r) => [r.row_id, r.row_data.employer, r.row_data.start_month, r.row_data.end_month,
               r.row_data.start_precision, r.row_data.end_precision, r.row_data.is_current])
  .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
check("the granular employment records in v8 are byte-identical to v7's",
  empOf(rows) === empOf(v7rows), "");

// Earlier versions are history and must not have moved.
const { data: v7 } = await db.from("profile_versions").select("row_count,truth_hash").eq("version", 7).single();
check("version 7 still has 254 rows and the hash recorded when it was cut",
  v7?.row_count === 254 && String(v7?.truth_hash).startsWith("95a2a54d0213"),
  `${v7?.row_count} / ${v7?.truth_hash}`);
check("version 7 gained no relationship rows",
  !v7rows.some((r) => r.source_table === "employment_relationships"), "");
for (const [v, count, hash] of [[3, 132, "d4f3e201d1cd"], [4, 251, "dc831176b4af"],
                                [5, 250, "e0ba771b87ac"], [6, 250, "2391e1322ac8"]] as const) {
  const { data } = await db.from("profile_versions").select("row_count,truth_hash").eq("version", v).single();
  check(`version ${v} is unchanged`,
    data?.row_count === count && String(data?.truth_hash).startsWith(hash),
    `${data?.row_count} / ${data?.truth_hash}`);
}
check("version 8 has its own hash, distinct from every earlier one",
  !["d4f3e201d1cd", "dc831176b4af", "e0ba771b87ac", "2391e1322ac8", "95a2a54d0213"]
    .some((h) => String(v8!.truth_hash).startsWith(h)),
  String(v8?.truth_hash));

// ---- what a resume built from version 8 says ------------------------
const { data: p } = await db.from("profile")
  .select("legal_first_name,legal_last_name,preferred_name").single();
const doc = composeResume(rows as any,
  { first: p!.legal_first_name, last: p!.legal_last_name } as any,
  `${p!.preferred_name ?? p!.legal_first_name} ${p!.legal_last_name}`);

console.log("\n  the employer-facing chronology version 8 produces:");
for (const r of doc.roles) {
  console.log(`    ${r.title}`);
  console.log(`      ${r.employer}${r.location ? ` · ${r.location}` : ""} | `
    + `${r.start.slice(0, 4)}-${r.end ? r.end.slice(0, 4) : "Present"} | ${r.lines.length} candidate bullets`);
}

const order = doc.roles.map((r) => r.employer);
check("Holley leads, being the most recently begun position",
  order[0] === "Holley Performance", JSON.stringify(order));
check("then Genius One, once, as 2019 to present",
  order[1] === "Genius One, Inc." && doc.roles[1]!.start === "2019-01-01" && doc.roles[1]!.end === null,
  JSON.stringify(doc.roles[1]));
check("then Anytime Picture, once, as 2019 to 2025",
  order[2] === "Anytime Picture LLC" && doc.roles[2]!.end === "2025-01-01", JSON.stringify(doc.roles[2]));
check("then the college", order[3] === "Lorain County Community College", JSON.stringify(order));
check("neither contract employer appears twice",
  order.filter((e) => e === "Genius One, Inc.").length === 1
  && order.filter((e) => e === "Anytime Picture LLC").length === 1, JSON.stringify(order));
check("Genius reads as contract without claiming part-time or full-time",
  doc.roles[1]!.title.includes("(Contract)") && !/part-time|full-time/i.test(doc.roles[1]!.title), doc.roles[1]!.title);
check("Anytime reads as part-time contract", doc.roles[2]!.title.includes("(Part-Time Contract)"), doc.roles[2]!.title);
check("Holley carries no qualifier", !doc.roles[0]!.title.includes("("), doc.roles[0]!.title);
check("no defensive prose about the overlap appears anywhere",
  !doc.roles.some((r) => /alongside|simultaneous|concurrently|varied|three jobs/i.test(`${r.title} ${r.employer}`)), "");
check("the overlap itself is left visible",
  doc.roles[1]!.start! < doc.roles[0]!.end! && doc.roles[2]!.start! < doc.roles[0]!.end!, "");

const relationships: EmploymentRelationship[] = frozen.map((r) => ({
  id: "frozen", employer: r.employer, displayTitle: r.display_title, location: r.location ?? null,
  qualifier: r.employer_facing_qualifier ?? null, start: r.relationship_start, end: r.relationship_end ?? null,
  startPrecision: r.start_precision, endPrecision: r.end_precision, employmentType: r.employment_type,
  workload: r.workload, coveredRecordIds: r.covered_record_ids ?? [],
  continuityBasis: r.continuity_basis, confirmedBy: r.confirmed_by,
}));
let chronologyOk = "";
try { assertChronologyIntact(doc, doc, relationships); } catch (e) { chronologyOk = String(e); }
check("the chronology invariant accepts the consolidated document", chronologyOk === "", chronologyOk);

const r = await renderResume(doc);
check("it renders, and an ATS reads each employer once",
  r.pdf.subarray(0, 5).toString() === "%PDF-"
  && (r.extractedText.match(/Genius One/g) ?? []).length === 1
  && (r.extractedText.match(/Anytime Picture/g) ?? []).length === 1,
  `genius ${(r.extractedText.match(/Genius One/g) ?? []).length}, anytime ${(r.extractedText.match(/Anytime Picture/g) ?? []).length}`);
check("with the spans and qualifiers intact in the extracted text",
  /2019/.test(r.extractedText) && /Present/.test(r.extractedText)
  && /Part-Time Contract/.test(r.extractedText), "");

console.log(`\n${pass + fails.length} checks, ${pass} passed`);
if (fails.length) { console.log(`${fails.length} FAILED`); process.exit(1); }
console.log("version 8 carries the confirmed relationships");
