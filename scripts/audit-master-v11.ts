/**
 * The v11 master, against every gate that applies to it. Read-only.
 *
 * generate-resume runs citation provenance, claim guards and American
 * English as it builds. This adds the ones it does not: semantic
 * provenance per claim, the implementation-state guard, chronology,
 * project-link integrity, and orphan sources in both directions.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { composeResume, allLines, type FrozenRow } from "../lib/render/resume.ts";
import { assertChronologyIntact } from "../lib/render/chronology.ts";
import { evidenceTextOf, provenanceStatements } from "../lib/render/evidenceText.ts";
import { auditClaim, type CitedSource } from "../lib/render/provenance.ts";
import { checkGrounding } from "../lib/render/grounding.ts";
import { checkClaims } from "../lib/render/claimGuards.ts";
import { assertAmericanEnglish } from "../lib/render/americanEnglish.ts";
import { implementationState, mayBeReframed, projectClaims } from "../lib/render/projectEvidence.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}\n         ${d}`); }
};

const rows: FrozenRow[] = [];
for (let f = 0; ; f += 1000) {
  const q = await db.from("profile_version_rows").select("row_id,source_table,row_data").eq("profile_version", 11).range(f, f + 999);
  if (q.error) throw new Error(q.error.message); rows.push(...(q.data as any)); if (q.data.length < 1000) break;
}
const { data: prof } = await db.from("profile").select("*").single();
const doc = composeResume(rows as any, { first: prof!.legal_first_name, last: prof!.legal_last_name } as any,
  `${prof!.preferred_name} ${prof!.legal_last_name}`);
const lines = allLines(doc);
const byRow = new Map(rows.map((r) => [r.row_id, r]));
const sources: CitedSource[] = rows.map((r) => ({
  id: r.row_id, text: evidenceTextOf(r.source_table, r.row_data) ?? "", statements: provenanceStatements(r.row_data),
}));
const byId = new Map(sources.map((s) => [s.id, s]));
console.log(`  v11 master: ${lines.length} lines (${doc.roles.reduce((n, r) => n + r.lines.length, 0)} role bullets, `
  + `${doc.projects[0]?.optional.length ?? 0} optional project claims)\n`);

// ---- provenance ------------------------------------------------------
const verdicts: Record<string, number> = {};
for (const l of lines) {
  const a = auditClaim({ claim: l.text, cited: l.sources.map((s) => byId.get(s)!).filter(Boolean), profile: sources });
  verdicts[a.verdict] = (verdicts[a.verdict] ?? 0) + 1;
  if (a.verdict !== "SUPPORTED") console.log(`     ${a.verdict}: ${l.text.slice(0, 70)} :: ${a.reason.slice(0, 120)}`);
}
check("every master claim is SUPPORTED", verdicts["SUPPORTED"] === lines.length, JSON.stringify(verdicts));

// ---- orphans, both directions ----------------------------------------
check("no line lacks a source", lines.every((l) => l.sources.length > 0), "");
const unknown = lines.flatMap((l) => l.sources).filter((s) => !byRow.has(s));
check("no line cites a row outside v11", unknown.length === 0, JSON.stringify([...new Set(unknown)]));
const projectRow = rows.find((r) => r.source_table === "projects" && r.row_data.name === "RentPup")!;
const linked = rows.filter((r) => r.source_table === "project_evidence");
check("every link resolves to an evidence row in v11",
  linked.every((r) => byRow.has(String(r.row_data.evidence_id))), "");
check("every link points at a project present in v11",
  linked.every((r) => rows.some((x) => x.source_table === "projects" && x.row_id === r.row_data.project_id)), "");

// ---- project-link integrity ------------------------------------------
const claims = projectClaims(projectRow.row_id, rows);
check("the pool is exactly the 17 employer-facing links", claims.length === 17, String(claims.length));
check("no unprintable link reached the pool",
  claims.every((c) => linked.find((l) => l.row_data.evidence_id === c.line.sources[0])!.row_data.employer_facing === true), "");
check("every pool claim is its evidence's own summary, verbatim",
  claims.every((c) => c.line.text === String(byRow.get(c.line.sources[0]!)!.row_data.summary).trim()), "");
check("every pool claim cites exactly one row",
  claims.every((c) => c.line.sources.length === 1), "");
check("the identity line is not one of the optional claims",
  !claims.some((c) => c.line.text === doc.projects[0]!.line.text), "");
check("the master presents the pool structurally", (doc.projects[0]?.optional.length ?? 0) === 17,
  String(doc.projects[0]?.optional.length));

// ---- implementation state --------------------------------------------
const states: Record<string, number> = {};
for (const c of claims) states[c.state] = (states[c.state] ?? 0) + 1;
console.log(`  implementation states in the pool: ${JSON.stringify(states)}`);
check("three pool claims have fixed wording", claims.filter((c) => !c.reframable).length === 3,
  String(claims.filter((c) => !c.reframable).length));
check("the fixed ones are exactly the non-CURRENT states",
  claims.every((c) => c.reframable === mayBeReframed(c.state)), "");
for (const c of claims.filter((x) => !x.reframable)) {
  const src = byRow.get(c.line.sources[0]!)!;
  const state = implementationState(src.row_data);
  const same = checkGrounding({ claim: c.line.text, evidenceIds: c.line.sources,
    sourceText: evidenceTextOf(src.source_table, src.row_data), original: c.line.text, implementationState: state });
  check(`${state} claim passes in its own words`,
    same.checks.find((x) => x.check === "NO_STATE_ESCALATION")!.ok, String(same.failedCheck));
  const reworded = checkGrounding({ claim: c.line.text.split(".")[0] + ".", evidenceIds: c.line.sources,
    sourceText: evidenceTextOf(src.source_table, src.row_data), original: c.line.text, implementationState: state });
  check(`${state} claim is refused when its qualifier is cut`,
    !reworded.checks.find((x) => x.check === "NO_STATE_ESCALATION")!.ok, "");
}
const paused = claims.find((c) => c.state === "BUILT_BUT_PAUSED")!;
check("the paused filing claim carries its full pause sentence",
  /deliberately switched off in August 2026 pending legal review/.test(paused.line.text), "");

// ---- guards ----------------------------------------------------------
let guardHits = 0;
for (const l of lines) for (const v of checkClaims(l.text)) { guardHits++; console.log(`     GUARD [${v.subject}] "${v.matched}" in ${l.text.slice(0, 60)}`); }
check("no claim guard fires on any master line", guardHits === 0, String(guardHits));
try { assertAmericanEnglish(lines.map((l) => l.text).join("\n")); check("american english", true); }
catch (e: any) { check("american english", false, e.message); }
check("no em dash", !lines.some((l) => l.text.includes("—")), "");
check("no repeated whitespace", !lines.some((l) => / {2}/.test(l.text)), "");

// ---- chronology ------------------------------------------------------
try { assertChronologyIntact(doc, doc); check("chronology intact", true); }
catch (e: any) { check("chronology intact", false, e.message); }
check("every employment record still appears", doc.roles.length === 4, String(doc.roles.length));

// ---- the guardrail rows are unreachable ------------------------------
const B = "b3d90a15-7c42-4e8b-a561-9f0c7d2e4b88";
const A = "a7f1c3e2-5b64-4d09-9c17-2e8b4f6a1d30";
for (const [n, id] of [["the authorship boundary", B], ["architecture understanding", A],
                       ["the pre-revenue row", "0aa19e95"]] as const) {
  check(`${n} is cited by no master line`, !lines.some((l) => l.sources.some((s) => s.startsWith(id.slice(0, 8)))), "");
}

console.log(`\n${pass + fails.length} checks, ${pass} passed`);
if (fails.length) { console.log(`${fails.length} FAILED`); process.exit(1); }
console.log("the v11 master passes every gate");
