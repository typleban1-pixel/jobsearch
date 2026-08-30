/** Seeds capability_relations. Idempotent, inspectable, versioned. */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { CAPABILITY_RELATIONS } from "../data/capability-relations.ts";
import { toConcept } from "../lib/matching/concepts.ts";

const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: skills } = await db.from("skills").select("name,status");
const verified = new Set((skills ?? []).filter((s: any) => s.status === "VERIFIED").map((s: any) => s.name));
const bad = CAPABILITY_RELATIONS.filter((r) => !verified.has(r.satisfied_by_skill));

const byRel: Record<string, number> = {};
for (const r of CAPABILITY_RELATIONS) byRel[r.relation] = (byRel[r.relation] ?? 0) + 1;
console.log(`${CAPABILITY_RELATIONS.length} relations: ${JSON.stringify(byRel)}`);
console.log(`distinct requirement concepts: ${new Set(CAPABILITY_RELATIONS.map((r) => r.requirement_concept)).size}`);
if (bad.length) {
  console.log(`\nrelations pointing at a skill that is NOT verified (would resolve UNKNOWN anyway):`);
  for (const r of bad) console.log(`  ${r.requirement_concept} -> ${r.satisfied_by_skill}`);
}
if (!commit) { console.log("\ndry run"); process.exit(0); }

const rows = CAPABILITY_RELATIONS.map((r) => ({
  requirement_concept: toConcept(r.requirement_concept).concept,
  satisfied_by_skill: r.satisfied_by_skill,
  relation: r.relation, rationale: r.rationale, origin: "SEED", version: 1,
}));
const { error } = await db.from("capability_relations").upsert(rows, { onConflict: "requirement_concept,satisfied_by_skill" });
if (error) { console.error(error.message); process.exit(1); }
const { count } = await db.from("capability_relations").select("*", { count: "exact", head: true });
console.log(`\ncapability_relations now holds ${count} rows`);
