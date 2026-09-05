/**
 * Replays requirement PERSISTENCE from already-stored model output, without any
 * paid LLM call. For the RESPONSIBILITY incident: the model responses live in
 * job_extractions.output; only the job_requirements INSERT failed (enum). Once
 * the enum is migrated, this re-runs validation + persistence from that stored
 * output.
 *
 *   node scripts/replay-extraction-persistence.ts --job <id>            one job, dry
 *   node scripts/replay-extraction-persistence.ts --job <id> --commit   one job, write
 *   node scripts/replay-extraction-persistence.ts --ids-file f --commit  all recoverable
 *
 * Never calls the model. Uses the SAME sanitize/reconcile/dedup/match path as
 * scripts/extract.ts, so a replayed row is indistinguishable from a direct one.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { required } from "../lib/env.ts";
import { sanitizeRequirement, reconcileHardness, dedupeRequirements, EXTRACTION_VERSION } from "../lib/llm/extractRequirements.ts";
import { TermMatcher } from "../lib/matching/match.ts";
import { modelForTier } from "../lib/llm/anthropic.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const commit = process.argv.includes("--commit");
const jobArg = process.argv.indexOf("--job") > -1 ? process.argv[process.argv.indexOf("--job") + 1] : null;
const idsFileArg = process.argv.indexOf("--ids-file") > -1 ? process.argv[process.argv.indexOf("--ids-file") + 1] : null;
const ids = jobArg ? [jobArg]
  : idsFileArg ? readFileSync(idsFileArg, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
  : [];
if (!ids.length) { console.error("usage: --job <id> | --ids-file <path>  [--commit]"); process.exit(1); }

const { data: aliases } = await db.from("term_aliases").select("alias,canonical_term");
const { data: skills } = await db.from("skills").select("id,name,related_terms").eq("status", "VERIFIED");
const matcher = new TermMatcher((skills ?? []).map((s: any) => ({ id: s.id, name: s.name, relatedTerms: s.related_terms ?? [], status: "VERIFIED" })), (aliases ?? []) as any);

const reqsFromOutput = (output: any): any[] => {
  const o = typeof output === "string" ? JSON.parse(output) : output;
  const raw = o?.requirements; if (!Array.isArray(raw)) return [];
  const cleaned: any[] = [];
  for (const rr of raw) {
    const c = sanitizeRequirement(rr); if (!c) continue;
    const rec = reconcileHardness(c.requirement as any);
    if (rec.corrected) (c.requirement as any).is_hard_requirement = rec.hardness;
    cleaned.push(c.requirement);
  }
  return dedupeRequirements(cleaned as any[]).kept as any[];
};

let recovered = 0, noOutput = 0, alreadyHad = 0, errors = 0, respRows = 0;
for (const jobId of ids) {
  const { data: ex } = await db.from("job_extractions")
    .select("output,succeeded,created_at").eq("job_id", jobId).is("superseded_by", null)
    .eq("succeeded", true).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const reqs = ex ? reqsFromOutput(ex.output) : [];
  if (!ex || reqs.length === 0) { noOutput++; if (jobArg) console.log(`no recoverable output for ${jobId.slice(0, 8)}`); continue; }
  const { count: existing } = await db.from("job_requirements").select("*", { count: "exact", head: true }).eq("job_id", jobId);
  if ((existing ?? 0) > 0) { alreadyHad++; if (jobArg) console.log(`${jobId.slice(0, 8)} already has ${existing} requirements; skipping`); continue; }
  const respHere = reqs.filter((r: any) => r.kind === "RESPONSIBILITY").length;
  const rows = reqs.map((r: any) => {
    const m = matcher.match(r.normalized_term);
    return {
      job_id: jobId, kind: r.kind, raw_text: r.raw_text, normalized_term: r.normalized_term,
      skill_id: m.skillId, is_hard_requirement: r.is_hard_requirement,
      hard_requirement_reason: r.hard_requirement_reason, minimum_years: r.minimum_years,
      extraction_confidence: Math.max(0, Math.min(1, r.confidence)),
      extracted_by: `replay:anthropic:${modelForTier("fast")}`, extraction_version: EXTRACTION_VERSION,
      match_method: m.method, matched_term: m.matchedTerm,
    };
  });
  if (jobArg) console.log(`${jobId.slice(0, 8)}: ${rows.length} requirements to persist (${respHere} RESPONSIBILITY): ${reqs.slice(0, 4).map((r: any) => r.kind + ":" + String(r.normalized_term).slice(0, 24)).join(" | ")}`);
  if (!commit) { recovered++; respRows += respHere; continue; }
  const { error: de } = await db.from("job_requirements").delete().eq("job_id", jobId);
  if (de) { errors++; console.log(`  ${jobId.slice(0, 8)} clear failed: ${de.message}`); continue; }
  const { error: re } = await db.from("job_requirements").insert(rows);
  if (re) { errors++; console.log(`  ${jobId.slice(0, 8)} insert failed: ${re.message}`); continue; }
  await db.from("jobs").update({ extracted_at: new Date().toISOString(), extraction_version: EXTRACTION_VERSION, extraction_source_job_id: null, extraction_reuse_hash: null }).eq("id", jobId);
  recovered++; respRows += respHere;
}
console.log(`\nreplay ${commit ? "(COMMIT)" : "(dry)"}: recovered=${recovered} noRecoverableOutput=${noOutput} alreadyPersisted=${alreadyHad} errors=${errors} RESPONSIBILITY rows=${respRows}`);
