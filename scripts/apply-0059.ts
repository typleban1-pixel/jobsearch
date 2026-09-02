/**
 * Applies 0059_office_tool_skills.sql. Pure DML, so it runs through the
 * ordinary client rather than the SQL editor; the statements mirror the
 * migration exactly.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const NOTE = (n: string) => `HUMAN_CONFIRMED 2026-08-31: Ty states he is very proficient. No certification, no years of experience and no employer-specific usage are claimed.`;
const SKILLS = [
  { name: "Microsoft Excel", related_terms: ["excel", "ms excel", "spreadsheets", "spreadsheet"] },
  { name: "Google Sheets", related_terms: ["sheets", "gsheets", "google spreadsheet"] },
  { name: "Google Docs", related_terms: ["docs", "gdocs", "google document"] },
  { name: "Microsoft PowerPoint", related_terms: ["powerpoint", "ms powerpoint", "ppt", "slide deck", "slide decks", "presentation software"] },
].map((s) => ({ ...s, category: "operations", status: "VERIFIED", level: "EXPERIENCED",
  interest: "NEUTRAL", importance: "SUPPORTING", evidence_confidence: "SELF_REPORTED",
  verified_at: new Date().toISOString(), notes: NOTE(s.name) }));

const ins = await db.from("skills").upsert(SKILLS, { onConflict: "name", ignoreDuplicates: true }).select("id,name");
if (ins.error) throw new Error(`skills: ${ins.error.message}`);
console.log(`skills inserted: ${ins.data.length}`);

const ALIASES = [
  ["excel", "Microsoft Excel", "the bare product name as postings write it"],
  ["ms excel", "Microsoft Excel", null], ["microsoft excel", "Microsoft Excel", null],
  ["sheets", "Google Sheets", null], ["google sheets", "Google Sheets", null],
  ["docs", "Google Docs", null], ["google docs", "Google Docs", null],
  ["powerpoint", "Microsoft PowerPoint", null], ["ms powerpoint", "Microsoft PowerPoint", null],
  ["microsoft powerpoint", "Microsoft PowerPoint", null],
] as const;
const al = await db.from("term_aliases").upsert(
  ALIASES.map(([alias, canonical_term, note]) => ({ alias, canonical_term, note, origin: "CURATED" })),
  { onConflict: "alias" }).select("alias");
if (al.error) throw new Error(`aliases: ${al.error.message}`);
console.log(`aliases upserted: ${al.data.length}`);

const { data: all } = await db.from("skills").select("id,name,level,status")
  .in("name", SKILLS.map((s) => s.name));
const { data: prof } = await db.from("profile").select("profile_version").single();
const log = await db.from("truth_change_log").insert((all ?? []).map((s: any) => ({
  source_table: "skills", row_id: s.id, operation: "INSERT",
  changed_fields: ["name", "status", "level"],
  new_data: { name: s.name, level: s.level, status: s.status,
    basis: "HUMAN_CONFIRMED 2026-08-31: proficiency stated by the user after the Candidate #6 screening read the requirement as absent." },
  profile_version_at_time: prof!.profile_version, actor: "user:human_confirmed",
})));
if (log.error) throw new Error(`change log: ${log.error.message}`);
console.log(`change-log rows: ${(all ?? []).length}`);
for (const s of all ?? []) console.log(`  ${s.status} ${s.level}  ${s.name}  ${s.id}`);
