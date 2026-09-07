/**
 * Records a skill the person has stated, as VERIFIED truth, with its evidence.
 *
 *   node --env-file=.env.local scripts/add-verified-skill.ts \
 *     --name "CRM" --related "customer relationship management,CRM software" \
 *     --category sales --evidence "Used a CRM day to day at Genius One and for RentPup." \
 *     --project RentPup [--level EXPERIENCED] [--commit]
 *
 * The rule (see promote.ts): verification means HE supplied or confirmed
 * the fact. A statement made to the assistant in his own words is that.
 * This writes exactly what was said -- the skill by the name given, the
 * synonyms scoring may match it under, one evidence row in his words
 * (origin USER_RESPONSE, self-reported) -- links the evidence to the skill
 * and, when named, to the project, and stops. It does not cut a profile
 * version: run scripts/cut-version.ts afterwards so the change is one
 * deliberate boundary.
 *
 * Nothing here is inferred: no tool names, no dates, no proficiency
 * beyond what was passed in.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const arg = (k: string): string | null => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };
const commit = process.argv.includes("--commit");
const name = arg("name"), evidenceText = arg("evidence");
if (!name || !evidenceText) { console.error("usage: --name <skill> --evidence <his words> [--related a,b] [--category c] [--project name] [--level LEVEL] [--commit]"); process.exit(2); }
const related = (arg("related") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const category = arg("category") ?? "general";
const level = arg("level") ?? "EXPERIENCED";
const projectName = arg("project");

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const { data: existing } = await db.from("skills").select("id,name,status").ilike("name", name).maybeSingle();
const { data: project } = projectName
  ? await db.from("projects").select("id,name").ilike("name", projectName).maybeSingle()
  : { data: null };
if (projectName && !project) { console.error(`no project named ${JSON.stringify(projectName)}`); process.exit(1); }

console.log(`skill      ${name}${existing ? `  (exists: ${existing.status})` : "  (new)"}`);
console.log(`related    ${related.join(", ") || "(none)"}`);
console.log(`category   ${category}   level ${level}`);
console.log(`evidence   ${JSON.stringify(evidenceText)}  origin USER_RESPONSE, self-reported, positive`);
console.log(`project    ${project ? project.name : "(none)"}`);
if (!commit) { console.log("\ndry run; pass --commit to write, then cut a version with scripts/cut-version.ts"); process.exit(0); }

const now = new Date().toISOString();
let skillId = existing?.id ?? null;
if (existing) {
  const { error } = await db.from("skills").update({
    status: "VERIFIED", verified_at: now, last_confirmed: now, level,
    related_terms: related, category, evidence_confidence: "SELF_REPORTED",
    notes: `Confirmed by Ty in his own words on ${now.slice(0, 10)}.`,
  }).eq("id", existing.id);
  if (error) throw new Error(`skills update: ${error.message}`);
} else {
  const { data, error } = await db.from("skills").insert({
    name, category, level, status: "VERIFIED", interest: "POSITIVE", importance: "SUPPORTING",
    related_terms: related, evidence_confidence: "SELF_REPORTED", verified_at: now, last_confirmed: now,
    suggested_at: now, suggested_rationale: "Stated by Ty in his own words; not inferred from a resume.",
    notes: `Confirmed by Ty in his own words on ${now.slice(0, 10)}.`,
  }).select("id").single();
  if (error || !data) throw new Error(`skills insert: ${error?.message}`);
  skillId = data.id;
}
const { data: ev, error: evErr } = await db.from("evidence").insert({
  polarity: "POSITIVE", summary: evidenceText.slice(0, 200), detail: evidenceText,
  confidence: "SELF_REPORTED", origin: "USER_RESPONSE", classification: "NORMAL_PERSONAL", tags: ["skill", name.toLowerCase()],
}).select("id").single();
if (evErr || !ev) throw new Error(`evidence insert: ${evErr?.message}`);
const { error: linkErr } = await db.from("skill_evidence").insert({ skill_id: skillId, evidence_id: ev.id });
if (linkErr) throw new Error(`skill_evidence: ${linkErr.message}`);
if (project) {
  const { error } = await db.from("project_evidence").insert({ project_id: project.id, evidence_id: ev.id, employer_facing: true, note: `Skill evidence for ${name}, stated by Ty.` });
  if (error) throw new Error(`project_evidence: ${error.message}`);
}
console.log(`\nwritten: skill ${String(skillId).slice(0, 8)} VERIFIED, evidence ${ev.id.slice(0, 8)}${project ? `, linked to ${project.name}` : ""}`);
console.log(`next: node --env-file=.env.local scripts/cut-version.ts "add verified skill: ${name}"`);
