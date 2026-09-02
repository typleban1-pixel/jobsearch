/**
 * v9, verified against itself.
 *
 * No union with the live tables and no simulation: everything below
 * reads the frozen snapshot, because the frozen snapshot is what a
 * prepared resume will read. Read-only.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { composeResume } from "../lib/render/resume.ts";
import { auditClaim, type CitedSource } from "../lib/render/provenance.ts";
import { evidenceTextOf, provenanceStatements } from "../lib/render/evidenceText.ts";

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

// ---- v8 is history and has not moved --------------------------------
const { data: v8meta } = await db.from("profile_versions").select("row_count,truth_hash").eq("version", 8).single();
check("v8 still holds 256 rows", v8meta?.row_count === 256, String(v8meta?.row_count));
check("with the hash recorded when it was cut",
  String(v8meta?.truth_hash).startsWith("cdbfa51e886b"), String(v8meta?.truth_hash));
for (const [v, count, hash] of [[3, 132, "d4f3e201d1cd"], [4, 251, "dc831176b4af"], [5, 250, "e0ba771b87ac"],
                                [6, 250, "2391e1322ac8"], [7, 254, "95a2a54d0213"]] as const) {
  const { data } = await db.from("profile_versions").select("row_count,truth_hash").eq("version", v).single();
  check(`v${v} is unchanged`, data?.row_count === count && String(data?.truth_hash).startsWith(hash),
    `${data?.row_count} / ${data?.truth_hash}`);
}

// ---- v9 itself -------------------------------------------------------
const { data: v9meta } = await db.from("profile_versions").select("*").eq("version", 9).single();
const v9 = await frozen(9);
const v8rows = await frozen(8);
console.log(`\n  v9: ${v9meta?.row_count} rows, truth hash ${v9meta?.truth_hash}`);
check("every v9 row loads", v9.length === v9meta?.row_count, `${v9.length} of ${v9meta?.row_count}`);
check("v9 has its own hash", v9meta?.truth_hash !== v8meta?.truth_hash, String(v9meta?.truth_hash));
const { data: live } = await db.from("profile").select("profile_version").single();
// v9 was the live baseline when this was written and is now history.
// What still has to hold is that nothing rolled the pointer backwards;
// asserting equality would fail every time a later version is cut, and
// the current pointer belongs to whichever verify script owns it.
check("the live profile is at v9 or later", (live?.profile_version ?? 0) >= 9, String(live?.profile_version));

// ---- the delta, enumerated -------------------------------------------
const v8ById = new Map(v8rows.map((r) => [r.row_id, r]));
const v9ById = new Map(v9.map((r) => [r.row_id, r]));
// The cut stamps profile_version and updated_at on the profile row
// itself, so those two are the version counter rather than a change to
// what is true. They are excluded here and checked explicitly below.
const BOOKKEEPING = new Set(["updated_at", "profile_version"]);
const canon = (o: any) => JSON.stringify(Object.keys(o ?? {}).filter((k) => !BOOKKEEPING.has(k)).sort()
  .map((k) => [k, (o ?? {})[k]]));
const added = v9.filter((r) => !v8ById.has(r.row_id));
const removed = v8rows.filter((r) => !v9ById.has(r.row_id));
const changed = v9.filter((r) => v8ById.has(r.row_id) && canon(v8ById.get(r.row_id)!.row_data) !== canon(r.row_data));

console.log(`\n  delta v8 -> v9: +${added.length} -${removed.length} ~${changed.length}`);
for (const r of added) console.log(`    + ${r.source_table} ${r.row_id.slice(0, 8)}  ${String(r.row_data.summary ?? "").slice(0, 78)}`);
check("exactly five rows were added", added.length === 5, String(added.length));
check("nothing was removed", removed.length === 0, JSON.stringify(removed.map((r) => r.row_id.slice(0, 8))));
check("nothing previously frozen was modified", changed.length === 0,
  JSON.stringify(changed.map((r) => `${r.source_table}:${r.row_id.slice(0, 8)}`)));
check("every added row is evidence", added.every((r) => r.source_table === "evidence"),
  JSON.stringify([...new Set(added.map((r) => r.source_table))]));
check("each carries USER_RESPONSE provenance",
  added.every((r) => r.row_data.origin === "USER_RESPONSE"),
  JSON.stringify(added.map((r) => r.row_data.origin)));

// ---- the five statements, by content ---------------------------------
const has = (needle: string) => added.find((r) => String(r.row_data.summary ?? "").includes(needle));
for (const [what, needle] of [
  ["the Genius One scoping statement", "At Genius One the owner often gave an objective"],
  ["the Anytime Picture scoping statement", "At Anytime Picture the client need"],
  ["the Holley scoping statement", "At Holley the work was more defined"],
  ["the college scoping statement", "At the college some responsibilities were established"],
  ["the RentPup functionality statement", "RentPup automatically checks"],
] as const) {
  check(`${what} is frozen in v9`, Boolean(has(needle)), "");
}

const holley = has("At Holley the work was more defined")!;
check("the Holley statement narrows rather than expands",
  /within established/.test(holley.row_data.summary)
  && /rather than scoping the overall work/.test(holley.row_data.summary),
  String(holley.row_data.summary).slice(0, 120));
check("and claims no authority it did not have",
  !/(^|\s)(led|managed|owned|directed)\s/i.test(holley.row_data.summary), "");

const rentpup = has("RentPup automatically checks")!;
check("the RentPup statement establishes automatic recurring checking",
  /automatically checks/.test(rentpup.row_data.summary) && /recurring basis/.test(rentpup.row_data.summary), "");
check("and association of findings with specific properties",
  /associates the records and statuses it finds with specific properties/.test(rentpup.row_data.summary), "");
check("and its limits are recorded with it",
  /does\s+NOT establish how many sources/.test(rentpup.row_data.detail)
  && /how often checks run/.test(rentpup.row_data.detail)
  && /downloaded or read in place/.test(rentpup.row_data.detail),
  String(rentpup.row_data.detail).slice(0, 160));
check("the statement itself claims no source count or frequency",
  !/\b\d+\s+(sources|data sources)\b/i.test(rentpup.row_data.summary)
  && !/\b(daily|hourly|weekly|nightly|every \d)\b/i.test(rentpup.row_data.summary), "");

// ---- previously frozen truth is untouched ----------------------------
const sameSet = (table: string) => {
  const a = v8rows.filter((r) => r.source_table === table).map((r) => `${r.row_id}:${canon(r.row_data)}`).sort();
  const b = v9.filter((r) => r.source_table === table).map((r) => `${r.row_id}:${canon(r.row_data)}`).sort();
  return JSON.stringify(a) === JSON.stringify(b);
};
for (const t of ["employment_records", "employment_relationships", "metrics", "skills", "education",
                 "location_preferences", "work_preferences", "question_bank", "projects", "profile"]) {
  check(`${t} is byte-identical to v8`, sameSet(t), "");
}

// The profile row's only permitted difference is the counter.
{
  const a = v8rows.find((r) => r.source_table === "profile")!.row_data;
  const b = v9.find((r) => r.source_table === "profile")!.row_data;
  const differing = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  check("the profile row differs from v8 only by the version counter",
    differing.length === 2 && differing.every((k) => BOOKKEEPING.has(k)), JSON.stringify(differing));
  check("and the counter moved from 8 to 9",
    a.profile_version === 8 && b.profile_version === 9, `${a.profile_version} -> ${b.profile_version}`);
  check("no confirmed fact changed the profile row",
    a.city === b.city && a.state === b.state
    && a.relocation_destination_city === b.relocation_destination_city
    && a.relocation_is_definite === b.relocation_is_definite
    && a.willing_to_relocate === b.willing_to_relocate
    && a.relocation_assistance_required === b.relocation_assistance_required
    && a.relocation_date === b.relocation_date, "");
}

// ---- the resume, composed from v9 alone ------------------------------
const { data: prof } = await db.from("profile")
  .select("legal_first_name,legal_last_name,preferred_name").single();
const doc = composeResume(v9 as any,
  { first: prof!.legal_first_name, last: prof!.legal_last_name } as any,
  `${prof!.preferred_name} ${prof!.legal_last_name}`);

const lines = [doc.summary, ...doc.roles.flatMap((r) => r.lines), ...doc.projects.map((p) => p.line)];
check("the master resume composes from v9 alone", lines.length === 25, `${lines.length} claims`);

// Every cited id must resolve inside v9 itself.
const unresolved = lines.flatMap((l) => l.sources.filter((s) => !v9ById.has(s)));
check("every cited evidence id resolves inside v9", unresolved.length === 0,
  JSON.stringify([...new Set(unresolved)].map((u) => u.slice(0, 8))));
check("no claim cites nothing", lines.every((l) => l.sources.length > 0), "");

const profileSources: CitedSource[] = v9.map((r) => ({
  id: r.row_id, text: evidenceTextOf(r.source_table, r.row_data), statements: provenanceStatements(r.row_data) }));
const byId = new Map(profileSources.map((p) => [p.id, p]));

const verdicts: Record<string, number> = {};
for (const l of lines) {
  const a = auditClaim({ claim: l.text, cited: l.sources.map((s) => byId.get(s)!).filter(Boolean), profile: profileSources });
  verdicts[a.verdict] = (verdicts[a.verdict] ?? 0) + 1;
  if (a.verdict !== "SUPPORTED") {
    console.log(`  ${a.verdict}: ${l.text.slice(0, 90)}`);
    console.log(`      ${a.reason.slice(0, 150)}`);
  }
}
console.log(`\n  audit against v9 alone: ${JSON.stringify(verdicts)}`);
check("all 25 master claims are SUPPORTED", verdicts["SUPPORTED"] === 25, JSON.stringify(verdicts));
check("zero UNDER_PROVENANCED", !verdicts["UNDER_PROVENANCED"], "");
check("zero UNSUPPORTED", !verdicts["UNSUPPORTED"], "");
check("zero HUMAN_REVIEW", !verdicts["HUMAN_REVIEW"], "");

console.log(`\n${pass + fails.length} checks, ${pass} passed`);
if (fails.length) { console.log(`${fails.length} FAILED`); process.exit(1); }
console.log(`v9 is frozen and clean: ${v9meta?.row_count} rows, truth hash ${v9meta?.truth_hash}`);
