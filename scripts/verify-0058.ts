/**
 * 0058, checked against what it was supposed to do. Read-only.
 *
 * The question is not only whether the links arrived, but whether
 * anything came with them: an extra link, a printable guardrail, a
 * changed evidence row, or a disturbed frozen version.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}\n         ${d}`); }
};
const A = "a7f1c3e2-5b64-4d09-9c17-2e8b4f6a1d30";
const B = "b3d90a15-7c42-4e8b-a561-9f0c7d2e4b88";

const links = await db.from("project_evidence").select("project_id,evidence_id,employer_facing,note");
check("project_evidence exists", !links.error, links.error?.message ?? "");
if (links.error) { console.log("\nnothing further can be checked"); process.exit(1); }
const rows = links.data!;
check("23 links exist", rows.length === 23, String(rows.length));
check("exactly 17 are employer-facing",
  rows.filter((r) => r.employer_facing).length === 17, String(rows.filter((r) => r.employer_facing).length));
check("exactly 6 are linked and not printable",
  rows.filter((r) => !r.employer_facing).length === 6, String(rows.filter((r) => !r.employer_facing).length));
check("every link carries a note", rows.every((r) => (r.note ?? "").length > 20), "");

const { data: projects } = await db.from("projects").select("id,name,status");
const rentpup = projects!.find((p) => p.name === "RentPup")!;
check("every link points at RentPup", rows.every((r) => r.project_id === rentpup.id), "");
check("no other project gained links",
  new Set(rows.map((r) => r.project_id)).size === 1, JSON.stringify([...new Set(rows.map((r) => r.project_id))]));

// ---- the guardrails cannot enter employer-facing composition --------
const NEVER_PRINTABLE = ["6ce1d8db", "d66fd8cd", "0aa19e95", "0b27a612", A.slice(0, 8), B.slice(0, 8)];
for (const p of NEVER_PRINTABLE) {
  const link = rows.find((r) => String(r.evidence_id).startsWith(p));
  check(`${p} is linked and not employer-facing`, Boolean(link) && link!.employer_facing === false,
    link ? `employer_facing=${link.employer_facing}` : "not linked at all");
}

// ---- the two new evidence rows ---------------------------------------
const ev = await db.from("evidence").select("id,polarity,summary,detail,origin,confidence,classification");
if (ev.error) throw new Error(ev.error.message);
const rowA = ev.data!.find((e) => e.id === A), rowB = ev.data!.find((e) => e.id === B);
check("row A exists as POSITIVE", Boolean(rowA) && rowA!.polarity === "POSITIVE", rowA?.polarity ?? "missing");
check("row B exists as VERIFIED_ABSENCE", Boolean(rowB) && rowB!.polarity === "VERIFIED_ABSENCE", rowB?.polarity ?? "missing");
check("row A keeps the three facts apart",
  /IMPLEMENTATION METHOD/.test(rowA?.detail ?? "") && /ARCHITECTURE UNDERSTANDING/.test(rowA?.detail ?? "")
  && /AUTHORSHIP BOUNDARY/.test(rowA?.detail ?? "") && /must never be merged/.test(rowA?.detail ?? ""), "");
check("row A forbids the AI-assistance qualifier being dropped",
  /may not be dropped/.test(rowA?.detail ?? ""), "");
check("row A carries the standard RentPup scope guard",
  /professional software engineering/.test(rowA?.detail ?? ""), "");
check("row B is worded exactly as approved",
  (rowB?.summary ?? "") === "The user does not claim to have personally hand-coded RentPup's full implementation and does not claim "
    + "traditional backend or software-engineering expertise. RentPup was built through AI-assisted development, and this "
    + "boundary must not be interpreted as evidence of missing product, systems, implementation, troubleshooting, or "
    + "architecture-understanding capability.", JSON.stringify(rowB?.summary?.slice(0, 90)));
check("row B says it must never reduce Fit", /never reduce Fit/.test(rowB?.detail ?? ""), "");
check("row B is a restriction on claims, not on capability",
  /restriction on what may be CLAIMED, not evidence of missing capability/.test(rowB?.detail ?? ""), "");
check("both new rows are USER_RESPONSE / SELF_REPORTED",
  [rowA, rowB].every((r) => r?.origin === "USER_RESPONSE" && r?.confidence === "SELF_REPORTED"), "");
check("the evidence table grew by exactly two", ev.data!.length === 161, String(ev.data!.length));

const log = await db.from("truth_change_log").select("row_id,actor,operation").in("row_id", [A, B]);
// An insert trigger on evidence writes its own entry with actor
// "unknown", so a row normally ends up with two: 864 existing evidence
// rows already look like this. What matters is that each new row has an
// INSERT attributed to the human who confirmed it.
for (const [name, id] of [["row A", A], ["row B", B]] as const) {
  const mine = (log.data ?? []).filter((l) => l.row_id === id && l.actor === "user:human_confirmed" && l.operation === "INSERT");
  check(`${name} is attributed to user:human_confirmed in the change log`, mine.length === 1,
    JSON.stringify((log.data ?? []).filter((l) => l.row_id === id)));
}

// ---- nothing frozen moved --------------------------------------------
for (const [v, count, hash] of [[7, 254, "95a2a54d0213"], [8, 256, "cdbfa51e886b"],
                                [9, 261, "735348443ba5"], [10, 278, "d98c3b35e57d"]] as const) {
  const { data } = await db.from("profile_versions").select("row_count,truth_hash").eq("version", v).single();
  check(`v${v} is unchanged`, data?.row_count === count && String(data?.truth_hash).startsWith(hash),
    `${data?.row_count} rows / ${data?.truth_hash}`);
}
const { data: live } = await db.from("profile").select("profile_version").single();
check("no version has been cut yet", live?.profile_version === 10, String(live?.profile_version));
const { count: frozenLinks } = await db.from("profile_version_rows").select("row_id", { count: "exact", head: true })
  .eq("source_table", "project_evidence");
check("no frozen version contains links yet", (frozenLinks ?? 0) === 0, String(frozenLinks));

console.log(`\n${pass + fails.length} checks, ${pass} passed`);
if (fails.length) { console.log(`${fails.length} FAILED`); process.exit(1); }
console.log("0058 applied cleanly");
