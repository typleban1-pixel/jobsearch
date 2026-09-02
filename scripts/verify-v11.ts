/**
 * v11, audited against itself and against v10.
 *
 * The delta should be exactly the linkage table plus the two confirmed
 * evidence rows. Anything else means including project_evidence in the
 * snapshot disturbed something it had no business touching.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}\n         ${d}`); }
};
const frozen = async (v: number) => {
  const out: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await db.from("profile_version_rows").select("row_id,source_table,row_data").eq("profile_version", v).range(f, f + 999);
    out.push(...(data ?? [])); if (!data || data.length < 1000) break;
  }
  return out;
};
const A = "a7f1c3e2-5b64-4d09-9c17-2e8b4f6a1d30";
const B = "b3d90a15-7c42-4e8b-a561-9f0c7d2e4b88";

const v10 = await frozen(10), v11 = await frozen(11);
const { data: m10 } = await db.from("profile_versions").select("row_count,truth_hash").eq("version", 10).single();
const { data: m11 } = await db.from("profile_versions").select("row_count,truth_hash").eq("version", 11).single();
console.log(`  v11: ${m11?.row_count} rows, truth hash ${m11?.truth_hash}\n`);

check("all v11 rows load", v11.length === m11?.row_count, `${v11.length} of ${m11?.row_count}`);
check("v11 has its own hash", m11?.truth_hash !== m10?.truth_hash, "");
for (const [v, count, hash] of [[7, 254, "95a2a54d0213"], [8, 256, "cdbfa51e886b"],
                                [9, 261, "735348443ba5"], [10, 278, "d98c3b35e57d"]] as const) {
  const { data } = await db.from("profile_versions").select("row_count,truth_hash").eq("version", v).single();
  check(`v${v} is unchanged`, data?.row_count === count && String(data?.truth_hash).startsWith(hash), `${data?.row_count} / ${data?.truth_hash}`);
}

// ---- the delta -------------------------------------------------------
const canonKeys = new Set(["updated_at", "profile_version"]);
const canon = (o: any) => JSON.stringify(Object.keys(o ?? {}).filter((k) => !canonKeys.has(k)).sort().map((k) => [k, (o ?? {})[k]]));
const by10 = new Map(v10.map((r) => [`${r.source_table}:${r.row_id}`, r]));
const by11 = new Map(v11.map((r) => [`${r.source_table}:${r.row_id}`, r]));
const key = (r: any) => `${r.source_table}:${r.row_id}`;
const added = v11.filter((r) => !by10.has(key(r)));
const removed = v10.filter((r) => !by11.has(key(r)));
const changed = v11.filter((r) => by10.has(key(r)) && canon(by10.get(key(r))!.row_data) !== canon(r.row_data));
console.log(`\n  delta: +${added.length} -${removed.length} ~${changed.length}`);
check("25 rows were added", added.length === 25, String(added.length));
check("nothing was removed", removed.length === 0, JSON.stringify(removed.map((r) => key(r))));
check("nothing existing changed", changed.length === 0, JSON.stringify(changed.map((r) => key(r))));
check("23 of the additions are project_evidence links",
  added.filter((r) => r.source_table === "project_evidence").length === 23,
  String(added.filter((r) => r.source_table === "project_evidence").length));
check("2 of the additions are the confirmed evidence rows",
  added.filter((r) => r.source_table === "evidence").map((r) => r.row_id).sort().join(",") === [A, B].sort().join(","),
  JSON.stringify(added.filter((r) => r.source_table === "evidence").map((r) => r.row_id)));
check("nothing else was added", new Set(added.map((r) => r.source_table)).size === 2,
  JSON.stringify([...new Set(added.map((r) => r.source_table))]));

// ---- the linkage, frozen ---------------------------------------------
const frozenLinks = v11.filter((r) => r.source_table === "project_evidence");
check("17 frozen links are employer-facing",
  frozenLinks.filter((r) => r.row_data.employer_facing === true).length === 17, "");
check("6 frozen links are not printable",
  frozenLinks.filter((r) => r.row_data.employer_facing === false).length === 6, "");
const rentpup = v11.find((r) => r.source_table === "projects" && r.row_data.name === "RentPup")!;
check("every frozen link points at RentPup",
  frozenLinks.every((r) => r.row_data.project_id === rentpup.row_id), "");
const evIds = new Set(v11.filter((r) => r.source_table === "evidence").map((r) => r.row_id));
check("every linked statement is present in v11",
  frozenLinks.every((r) => evIds.has(String(r.row_data.evidence_id))), "");
check("link row ids do not collide with evidence row ids",
  frozenLinks.every((r) => !evIds.has(r.row_id)), "");
for (const p of ["6ce1d8db", "d66fd8cd", "0aa19e95", "0b27a612", A.slice(0, 8), B.slice(0, 8)]) {
  const l = frozenLinks.find((r) => String(r.row_data.evidence_id).startsWith(p));
  check(`${p} is frozen as not printable`, Boolean(l) && l!.row_data.employer_facing === false, "");
}

// ---- nothing outside the linkage moved -------------------------------
for (const t of ["employment_records", "employment_relationships", "metrics", "skills", "education",
                 "location_preferences", "work_preferences", "question_bank", "projects"]) {
  const a = v10.filter((r) => r.source_table === t).map((r) => `${r.row_id}:${canon(r.row_data)}`).sort();
  const b = v11.filter((r) => r.source_table === t).map((r) => `${r.row_id}:${canon(r.row_data)}`).sort();
  check(`${t} is byte-identical to v10`, JSON.stringify(a) === JSON.stringify(b), "");
}
{
  const a = v10.filter((r) => r.source_table === "evidence").filter((r) => r.row_id !== A && r.row_id !== B)
    .map((r) => `${r.row_id}:${canon(r.row_data)}`).sort();
  const b = v11.filter((r) => r.source_table === "evidence").filter((r) => r.row_id !== A && r.row_id !== B)
    .map((r) => `${r.row_id}:${canon(r.row_data)}`).sort();
  check("every pre-existing evidence row is byte-identical to v10", JSON.stringify(a) === JSON.stringify(b), "");
}
{
  const a = v10.find((r) => r.source_table === "profile")!.row_data;
  const b = v11.find((r) => r.source_table === "profile")!.row_data;
  const diff = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  check("the profile row differs only by the version counter",
    diff.length === 2 && diff.every((k) => canonKeys.has(k)), JSON.stringify(diff));
}
const { data: live } = await db.from("profile").select("profile_version").single();
check("the live profile points at v11", live?.profile_version === 11, String(live?.profile_version));

// ---- the two new rows, frozen as approved ----------------------------
const fa = v11.find((r) => r.row_id === A)!, fb = v11.find((r) => r.row_id === B)!;
check("row A is frozen as POSITIVE with all three facts", fa.row_data.polarity === "POSITIVE"
  && /IMPLEMENTATION METHOD/.test(fa.row_data.detail) && /AUTHORSHIP BOUNDARY/.test(fa.row_data.detail), "");
check("row B is frozen as VERIFIED_ABSENCE that never reduces Fit",
  fb.row_data.polarity === "VERIFIED_ABSENCE" && /never reduce Fit/.test(fb.row_data.detail), "");
const NUMERIC = /\b\d[\d,.]*\s*(?:%|percent|k\b|million|customers?|sources?|accounts?)\b/i;
check("neither new row carries a count, rate or volume",
  !NUMERIC.test(fa.row_data.summary) && !NUMERIC.test(fb.row_data.summary), "");

console.log(`\n${pass + fails.length} checks, ${pass} passed`);
if (fails.length) { console.log(`${fails.length} FAILED`); process.exit(1); }
console.log(`v11 is frozen and clean: ${m11?.row_count} rows, truth hash ${m11?.truth_hash}`);
