/**
 * Upserts the reliability-project capability_relations (data/candidacy-relations.json)
 * into the profile ontology. Idempotent: skips a (requirement_concept,
 * satisfied_by_skill) pair that already exists. Tagged origin so it is
 * identifiable and reversible.
 *
 *   node scripts/apply-candidacy-relations.ts            # dry run
 *   node scripts/apply-candidacy-relations.ts --write    # insert
 *   node scripts/apply-candidacy-relations.ts --revert   # delete this origin
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const ORIGIN = "CANDIDACY_RELIABILITY_2026_09";
const WRITE = process.argv.includes("--write");
const REVERT = process.argv.includes("--revert");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

if (REVERT) {
  const { data, error } = await db.from("capability_relations").delete().eq("origin", ORIGIN).select("requirement_concept");
  if (error) throw new Error(error.message);
  console.log(`reverted ${data?.length ?? 0} relations with origin ${ORIGIN}`);
  process.exit(0);
}

const proposed = JSON.parse(readFileSync("data/candidacy-relations.json", "utf8")).relations as any[];
const { data: verifiedSkills } = await db.from("skills").select("name").eq("status", "VERIFIED");
const verified = new Set((verifiedSkills ?? []).map((s) => s.name));
const { data: existing } = await db.from("capability_relations").select("requirement_concept,satisfied_by_skill");
const have = new Set((existing ?? []).map((r) => `${r.requirement_concept.toLowerCase()}::${r.satisfied_by_skill}`));

const toInsert = [];
for (const r of proposed) {
  if (!verified.has(r.satisfied_by_skill)) { console.log(`  SKIP (skill not verified): ${r.requirement_concept} -> ${r.satisfied_by_skill}`); continue; }
  if (have.has(`${r.requirement_concept.toLowerCase()}::${r.satisfied_by_skill}`)) { console.log(`  EXISTS: ${r.requirement_concept} -> ${r.satisfied_by_skill}`); continue; }
  toInsert.push({ requirement_concept: r.requirement_concept, satisfied_by_skill: r.satisfied_by_skill,
    relation: r.relation, rationale: r.rationale, origin: ORIGIN, version: 1 });
}
console.log(`\n${toInsert.length} to insert, ${proposed.length - toInsert.length} skipped/existing`);
for (const r of toInsert) console.log(`  + ${r.requirement_concept} -> ${r.satisfied_by_skill} (${r.relation})`);
if (!WRITE) { console.log("\ndry run; pass --write to insert"); process.exit(0); }
if (toInsert.length) {
  const { error } = await db.from("capability_relations").insert(toInsert);
  if (error) throw new Error(error.message);
}
console.log(`\ninserted ${toInsert.length} relations (origin ${ORIGIN})`);
process.exit(0);
