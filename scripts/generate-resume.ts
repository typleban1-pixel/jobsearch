/**
 * Generates the master resume from a frozen profile version.
 *
 * The old resume is source material, not a starting point. It contains
 * the two retracted LCCC claims, and editing it forward would carry
 * whatever else in it was never checked. This composes from version rows
 * instead, so the resume cannot contain anything the profile does not.
 *
 * Three gates, all blocking:
 *   - every line must cite at least one frozen row
 *   - claim guards, on each line and on the whole document
 *   - American English, including the em dash rule
 *
 *   node scripts/generate-resume.ts 5 [--write]
 */
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { composeResume, renderMarkdown, allLines, RESUME_COMPOSER_VERSION } from "../lib/render/resume.ts";
import { checkClaims, CLAIM_GUARD_VERSION } from "../lib/render/claimGuards.ts";
import { toAmericanEnglish, assertAmericanEnglish, AMERICAN_ENGLISH_VERSION } from "../lib/render/americanEnglish.ts";
import { nameFor } from "../lib/render/names.ts";
import { checkTemporalScope, TEMPORAL_SCOPE_VERSION, type DatedSource } from "../lib/render/temporalScope.ts";
import { evidenceTextOf } from "../lib/render/evidenceText.ts";

const version = Number(process.argv[2] ?? 5);
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const rows: any[] = [];
for (let f = 0; ; f += 1000) {
  const { data, error } = await db.from("profile_version_rows").select("source_table,row_id,row_data")
    .eq("profile_version", version).order("row_id").range(f, f + 999);
  if (error) throw new Error(error.message); rows.push(...data); if (data.length < 1000) break;
}
const { data: pv } = await db.from("profile_versions").select("*").eq("version", version).single();
console.log(`composing from version ${version}: ${rows.length} frozen rows, hash ${pv.truth_hash?.slice(0, 12)}`);
if (rows.length !== pv.row_count) throw new Error(`snapshot incomplete: ${rows.length} read, ${pv.row_count} recorded`);

const p = rows.find((r) => r.source_table === "profile").row_data;
const parts = { legalFirst: p.legal_first_name, legalMiddle: p.legal_middle_name, legalLast: p.legal_last_name, preferred: p.preferred_name };
const doc = composeResume(rows, parts, nameFor("RESUME", parts));
console.log(`  display name: ${doc.name} (legal name "${nameFor("LEGAL_NAME", parts)}" is not used on a resume)`);

// Gate 1: provenance. A line with no source is a line nobody can check.
const lines = allLines(doc);
const orphans = lines.filter((l) => l.sources.length === 0);
console.log(`\nprovenance: ${lines.length} lines, ${orphans.length} without a source row`);
if (orphans.length) { for (const o of orphans) console.log(`  ORPHAN: ${o.text}`); throw new Error("every line must cite a frozen row"); }
const known = new Set(rows.map((r) => r.row_id));
for (const l of lines) for (const s of l.sources) if (!known.has(s)) throw new Error(`line cites a row not in version ${version}: ${s}`);
console.log(`  all ${lines.length} lines cite rows present in version ${version}`);

// Gate 2: claim guards, per line and whole-document. Per line catches the
// offender; whole-document catches claims that only form across lines.
let violations = 0;
for (const l of lines) {
  for (const v of checkClaims(l.text)) { violations++; console.log(`  GUARD [${v.subject}] "${v.matched}"\n     in: ${l.text.slice(0, 120)}\n     ${v.reason}`); }
}
// The master PRESENTS the project as its identity line and nothing
// more, while still carrying the whole optional pool structurally.
//
// Both halves matter. The pool is gated, audited and stored as claims
// above, because that is what tailoring selects from and what the
// provenance audit has to see. But printing all of it here would make
// the static master a wall of RentPup statements and would collapse the
// distinction the architecture exists to keep: the identity line is
// what the project IS and is stable; the optional claims are what it
// DOES and have to earn their place against a specific posting. A
// master that prints them has decided they are always worth printing.
const presented = { ...doc, projects: doc.projects.map((p) => ({ ...p, optional: [] })) };
// Gate 2b: a date that governs a list must hold for every item in it.
//
// Statically composed lines never pass through the tailoring guards,
// because there is no rewrite to compare against, so this runs here on
// the finished document. See lib/render/temporalScope.ts.
let temporal = 0;
for (const l of lines) {
  const cited: DatedSource[] = l.sources.map((id) => {
    const r = rows.find((x) => x.row_id === id)!;
    const d = r.row_data;
    return { id, text: evidenceTextOf(r.source_table, d) ?? "",
      start: d.start_month ?? d.occurred_start ?? d.relationship_start ?? d.end_date ?? null,
      end: d.end_month ?? d.occurred_end ?? d.relationship_end ?? null };
  });
  for (const v of checkTemporalScope(l.text, cited)) {
    temporal++;
    console.log(`  TEMPORAL SCOPE  ${v.reason}\n     in: ${l.text.slice(0, 120)}`);
  }
}
console.log(`temporal scope v${TEMPORAL_SCOPE_VERSION}: ${temporal} violation(s)`);
if (temporal) throw new Error("a date on this resume governs something the evidence does not support that far back");

const markdownRaw = renderMarkdown(presented);
for (const v of checkClaims(markdownRaw)) {
  if (lines.some((l) => checkClaims(l.text).some((x) => x.subject === v.subject))) continue;
  violations++; console.log(`  GUARD (document level) [${v.subject}] "${v.matched}"`);
}
console.log(`\nclaim guards v${CLAIM_GUARD_VERSION}: ${violations} violations`);
if (violations) throw new Error("resume makes claims the profile does not support");

// Gate 3: American English, applied to the rendered document.
const PROTECT = ["Lorain County Community College", "Genius One, Inc.", "Holley Performance",
                 "Anytime Picture LLC", "Western Governors University", "Leavitt School of Health",
                 "Sportsman Network", "Cleveland Clinic", "Adobe Creative Suite", "Vimeo OTT", "RentPup", "Onshape"];
const norm = toAmericanEnglish(markdownRaw, { protect: PROTECT });
console.log(`american english v${AMERICAN_ENGLISH_VERSION}: ${norm.changes.length} normalizations`);
for (const c of norm.changes.slice(0, 12)) console.log(`   ${c.from} -> ${c.to}`);
const markdown = norm.text;
assertAmericanEnglish(markdown, { protect: PROTECT });
if (markdown.includes("—")) throw new Error("em dash present in employer-facing text");
console.log("  no em dash present");

const outPath = `/tmp/master-resume-v${version}.md`;
writeFileSync(outPath, markdown);
console.log(`\nwrote ${outPath} (${markdown.split("\n").length} lines)`);

if (!process.argv.includes("--write")) { console.log("not persisted. pass --write to store as the master resume."); process.exit(0); }

// The previous master is demoted, never edited and never deleted. A
// correction to employer-facing output has to be inspectable afterwards:
// the old row keeps its own claims and citations, and the new one points
// back at it.
const { data: prior } = await db.from("resumes").select("id,label,is_master").eq("is_master", true);
let previousMasterId: string | null = null;
for (const r of prior ?? []) {
  await db.from("resumes").update({ is_master: false }).eq("id", r.id);
  previousMasterId = r.id;
  console.log(`demoted prior master: ${r.label} (${r.id})`);
}
const reason = process.argv.find((a) => a.startsWith("--reason="))?.split("=").slice(1).join("=") ?? null;
const { data: saved, error: saveErr } = await db.from("resumes").insert({
  label: `Master resume, profile version ${version}${reason ? ` (${reason})` : ""}`,
  is_master: true,
  derived_from: previousMasterId,
  strategy: "Generalist positioning. Composed from frozen version rows, no model-written prose.",
  content: { doc, markdown, profileVersion: version, truthHash: pv.truth_hash,
             composerVersion: RESUME_COMPOSER_VERSION, claimGuardVersion: CLAIM_GUARD_VERSION,
             americanEnglishVersion: AMERICAN_ENGLISH_VERSION },
  file_path: outPath,
}).select("id").single();
if (saveErr) throw new Error(saveErr.message);
console.log(`stored resume ${saved.id}`);

const claims = lines.map((l) => ({ resume_id: saved.id, claim: l.text, evidence_ids: l.sources }));
const { error: cErr } = await db.from("resume_claims").insert(claims);
if (cErr) throw new Error(cErr.message);
console.log(`stored ${claims.length} resume_claims rows, each carrying its source row ids`);
