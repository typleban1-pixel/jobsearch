/**
 * v10, audited against itself and against v9.
 *
 * The question is not only whether the RentPup rows arrived, but whether
 * anything came with them that should not have: a number turned into a
 * claim, a scope guard dropped, an implementation state escalated, or a
 * change outside RentPup. Read-only.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}\n         ${detail}`); }
};
const frozen = async (v: number) => {
  const out: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await db.from("profile_version_rows")
      .select("row_id,source_table,row_data").eq("profile_version", v).range(f, f + 999);
    out.push(...(data ?? [])); if (!data || data.length < 1000) break;
  }
  return out;
};

const v9 = await frozen(9), v10 = await frozen(10);
const { data: m9 } = await db.from("profile_versions").select("row_count,truth_hash").eq("version", 9).single();
const { data: m10 } = await db.from("profile_versions").select("row_count,truth_hash").eq("version", 10).single();
console.log(`  v10: ${m10?.row_count} rows, truth hash ${m10?.truth_hash}\n`);

check("v9 is unchanged at 261 rows with its own hash",
  m9?.row_count === 261 && String(m9?.truth_hash).startsWith("735348443ba5"), `${m9?.row_count} / ${m9?.truth_hash}`);
for (const [v, count, hash] of [[7, 254, "95a2a54d0213"], [8, 256, "cdbfa51e886b"]] as const) {
  const { data } = await db.from("profile_versions").select("row_count,truth_hash").eq("version", v).single();
  check(`v${v} is unchanged`, data?.row_count === count && String(data?.truth_hash).startsWith(hash), `${data?.row_count}`);
}
check("v10 has its own hash", m10?.truth_hash !== m9?.truth_hash, "");
check("all v10 rows load", v10.length === m10?.row_count, `${v10.length} of ${m10?.row_count}`);
const { data: live } = await db.from("profile").select("profile_version").single();
check("the live profile points at v10", live?.profile_version === 10, String(live?.profile_version));

// ---- the delta -------------------------------------------------------
const canonKeys = new Set(["updated_at", "profile_version"]);
const canon = (o: any) => JSON.stringify(Object.keys(o ?? {}).filter((k) => !canonKeys.has(k)).sort().map((k) => [k, (o ?? {})[k]]));
const by9 = new Map(v9.map((r) => [r.row_id, r]));
const by10 = new Map(v10.map((r) => [r.row_id, r]));
const added = v10.filter((r) => !by9.has(r.row_id));
const removed = v9.filter((r) => !by10.has(r.row_id));
const changed = v10.filter((r) => by9.has(r.row_id) && canon(by9.get(r.row_id)!.row_data) !== canon(r.row_data));

console.log(`\n  delta: +${added.length} -${removed.length} ~${changed.length}`);
check("seventeen rows were added", added.length === 17, String(added.length));
check("nothing was removed", removed.length === 0, JSON.stringify(removed.map((r) => r.row_id.slice(0, 8))));
check("exactly one existing row changed", changed.length === 1, JSON.stringify(changed.map((r) => `${r.source_table}:${r.row_id.slice(0, 8)}`)));
check("every addition is an evidence row", added.every((r) => r.source_table === "evidence"),
  JSON.stringify([...new Set(added.map((r) => r.source_table))]));
check("each addition carries USER_RESPONSE provenance",
  added.every((r) => r.row_data.origin === "USER_RESPONSE" && r.row_data.confidence === "SELF_REPORTED"), "");
check("the changed row is the direct-mail attribution row and only its detail moved",
  changed.length === 1 && changed[0]!.row_id.startsWith("d66fd8cd")
  && JSON.stringify(Object.keys(changed[0]!.row_data).filter((k) =>
      JSON.stringify(by9.get(changed[0]!.row_id)!.row_data[k]) !== JSON.stringify(changed[0]!.row_data[k]))) === '["detail"]',
  JSON.stringify(changed.map((r) => r.row_id.slice(0, 8))));

// ---- implementation states -------------------------------------------
const stateOf = (d: any) => (String(d.detail ?? "").match(/^(CURRENT|BUILT_BUT_PAUSED|PARTIAL|CONDITIONAL)\b/) ?? [])[1] ?? null;
const states: Record<string, number> = {};
for (const r of added) { const s = stateOf(r.row_data); states[String(s)] = (states[String(s)] ?? 0) + 1; }
console.log(`  states: ${JSON.stringify(states)}`);
check("fourteen CURRENT, one BUILT_BUT_PAUSED, one PARTIAL, one CONDITIONAL",
  states["CURRENT"] === 14 && states["BUILT_BUT_PAUSED"] === 1 && states["PARTIAL"] === 1 && states["CONDITIONAL"] === 1,
  JSON.stringify(states));
check("every added row declares its implementation state",
  added.every((r) => stateOf(r.row_data) !== null), "");

// ---- scope guards ----------------------------------------------------
check("every added row carries the capability guard",
  added.every((r) => /professional software engineering/i.test(String(r.row_data.detail))), "");
check("and names what it must not be read as",
  added.every((r) => /must NOT be read as/i.test(String(r.row_data.detail))), "");

const paused = added.find((r) => stateOf(r.row_data) === "BUILT_BUT_PAUSED")!;
check("the paused filing row states submission is manual",
  /MANUALLY by a person/.test(paused.row_data.detail)
  && /nothing is ever filed with a government automatically/.test(paused.row_data.detail), "");
check("it states the workflow has never been exercised",
  /NEVER been exercised/.test(paused.row_data.detail) && /no filing has ever been requested, submitted or confirmed/.test(paused.row_data.detail), "");
check("and that it is not available to customers today",
  /never be described as a service available to customers today/.test(paused.row_data.detail), "");

const partial = added.find((r) => stateOf(r.row_data) === "PARTIAL")!;
check("the experimentation row refuses an ongoing programme",
  /must NOT be described as an ongoing experimentation program/.test(partial.row_data.detail), "");

const attribution = added.find((r) => /attributes a property view back/.test(String(r.row_data.summary)))!;
check("the attribution row states the property-plus-timing limit",
  /NOT a unique recipient identifier and NOT cryptographic identity/.test(attribution.row_data.detail), "");
const corrected = changed[0]!.row_data;
check("the corrected row preserves that letter testing is real",
  /LETTER TESTING IS REAL/.test(corrected.detail), "");
check("and narrows website A/B without deleting it",
  /WEBSITE A\/B IS NARROWER/.test(corrected.detail) && /no page currently resolves a variant/.test(corrected.detail), "");
check("and carries the attribution limit",
  /NOT a unique recipient identifier/.test(corrected.detail), "");
check("and says when and why it was narrowed",
  /Narrowed 2026-08-31/.test(corrected.detail), "");

// ---- no numbers became claims ----------------------------------------
const NUMERIC = /\b\d[\d,.]*\s*(?:%|percent|k\b|million|letters?|mailings?|events?|accounts?|customers?|sources?|runs?|visits?|properties|sessions?)\b/i;
const numeric = added.filter((r) => NUMERIC.test(String(r.row_data.summary)));
check("no added statement contains a count, rate or volume",
  numeric.length === 0, JSON.stringify(numeric.map((r) => String(r.row_data.summary).slice(0, 70))));
check("nor does the corrected row", !NUMERIC.test(String(corrected.detail)), "");
const FORBIDDEN = /\b(revenue|paying customers|conversion rate|traction|enterprise scale|team of|software engineer\b(?!ing))/i;
const forbidden = added.filter((r) => FORBIDDEN.test(String(r.row_data.summary)));
check("no added statement claims revenue, customers, traction or scale",
  forbidden.length === 0, JSON.stringify(forbidden.map((r) => String(r.row_data.summary).slice(0, 60))));

// ---- preserved rows --------------------------------------------------
for (const [name, id] of [["the pre-revenue row", "0aa19e95"], ["the capability guardrail", "0b27a612"],
                          ["the product-building row", "e6190479"]] as const) {
  const a = v9.find((r) => r.row_id.startsWith(id));
  const b = v10.find((r) => r.row_id.startsWith(id));
  check(`${name} is unchanged`, Boolean(a && b) && canon(a!.row_data) === canon(b!.row_data), "");
}

// ---- nothing outside RentPup -----------------------------------------
for (const t of ["employment_records", "employment_relationships", "metrics", "skills", "education",
                 "location_preferences", "work_preferences", "question_bank", "projects"]) {
  const a = v9.filter((r) => r.source_table === t).map((r) => `${r.row_id}:${canon(r.row_data)}`).sort();
  const b = v10.filter((r) => r.source_table === t).map((r) => `${r.row_id}:${canon(r.row_data)}`).sort();
  check(`${t} is byte-identical to v9`, JSON.stringify(a) === JSON.stringify(b), "");
}
const nonRentpupChanged = changed.filter((r) => !/rentpup/i.test(JSON.stringify(r.row_data)));
check("no non-RentPup row changed", nonRentpupChanged.length === 0,
  JSON.stringify(nonRentpupChanged.map((r) => r.row_id.slice(0, 8))));
{
  const a = v9.find((r) => r.source_table === "profile")!.row_data;
  const b = v10.find((r) => r.source_table === "profile")!.row_data;
  const diff = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  check("the profile row differs only by the version counter",
    diff.length === 2 && diff.every((k) => canonKeys.has(k)), JSON.stringify(diff));
}

console.log(`\n${pass + fails.length} checks, ${pass} passed`);
if (fails.length) { console.log(`${fails.length} FAILED`); process.exit(1); }
console.log(`v10 is frozen and clean: ${m10?.row_count} rows, truth hash ${m10?.truth_hash}`);
