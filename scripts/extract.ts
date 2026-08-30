/**
 * Requirement extraction.
 *
 *   node scripts/extract.ts --limit 25 --pilot     verbose, per-job review
 *   node scripts/extract.ts --limit 25 --commit    persist
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { AnthropicProvider, modelForTier } from "../lib/llm/anthropic.ts";
import { extractRequirements, EXTRACTION_VERSION } from "../lib/llm/extractRequirements.ts";
import { checkGrounding, findUncoveredRequirementSentences } from "../lib/llm/grounding.ts";
import { TermMatcher } from "../lib/matching/match.ts";
import type { LlmUsage } from "../lib/llm/provider.ts";

const arg = (n: string, d: number) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
};
const limit = arg("limit", 25);
const commit = process.argv.includes("--commit");
const pilot = process.argv.includes("--pilot");
/** Re-run over jobs already extracted, superseding the earlier version. */
const reextract = process.argv.includes("--reextract");
const BUDGET_CENTS = arg("budget", 100);

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });
const llm = new AnthropicProvider();

const { data: aliases } = await db.from("term_aliases").select("alias,canonical_term");
const { data: verifiedSkills } = await db.from("skills").select("id,name,related_terms").eq("status", "VERIFIED");
const matcher = new TermMatcher(
  (verifiedSkills ?? []).map((s: any) => ({ id: s.id, name: s.name, relatedTerms: s.related_terms ?? [] })),
  (aliases ?? []) as any,
);

// A spread across companies rather than the first N of one board.
const { data: candidates, error: candErr } = await db.from("jobs")
  .select("id,company_id,title,eligibility,extracted_at,companies!inner(name)")
  .eq("status", "OPEN").in("eligibility", ["ELIGIBLE", "UNCERTAIN"])
  .order("company_id", { ascending: true }).limit(1600);
if (candErr) throw new Error(candErr.message);

const pool = (candidates ?? []).filter((j: any) =>
  reextract ? j.extracted_at !== null : j.extracted_at === null);
if (pool.length === 0) {
  console.log(reextract ? "no extracted jobs to re-extract" : "no unextracted eligible jobs remain");
  process.exit(0);
}

const perCompany = new Map<string, any[]>();
for (const j of pool) {
  const arr = perCompany.get(j.company_id) ?? [];
  if (arr.length < 3) { arr.push(j); perCompany.set(j.company_id, arr); }
}
const selected: any[] = [];
outer: for (let round = 0; round < 3; round++) {
  for (const arr of perCompany.values()) {
    if (arr[round]) selected.push(arr[round]);
    if (selected.length >= limit) break outer;
  }
}

const ids = selected.map((s) => s.id);
const { data: descs } = await db.from("job_descriptions").select("job_id,description_text").in("job_id", ids);
const descById = new Map((descs ?? []).map((d: any) => [d.job_id, d.description_text ?? ""]));

let spentCents = 0;
const usages: LlmUsage[] = [];
let flagged = 0, totalReqs = 0;
const missRows: Array<{ term: string; method: string }> = [];

console.log(`extraction pilot: ${selected.length} jobs, tier=fast (${modelForTier("fast")}), budget ${BUDGET_CENTS}c\n`);

for (const [i, job] of selected.entries()) {
  const description = descById.get(job.id) ?? "";
  const company = (job.companies as any)?.name ?? "?";
  if (spentCents > BUDGET_CENTS) { console.log("BUDGET REACHED, stopping"); break; }

  let out, usage;
  try {
    const r = await extractRequirements(llm, { title: job.title, company, descriptionText: description });
    out = r.content; usage = r.usage;
  } catch (e) {
    console.log(`\n[${i + 1}] ${company} — ${job.title}\n  EXTRACTION FAILED: ${String(e).slice(0, 200)}`);
    continue;
  }
  spentCents += usage.estimatedCostCents;
  usages.push(usage);

  const reqs = out.requirements ?? [];
  totalReqs += reqs.length;

  console.log(`\n[${i + 1}] ${company} — ${job.title}`);
  console.log(`    eligibility=${job.eligibility}  description=${description.length} chars`);
  console.log(`    remote stated by posting: ${out.remote_policy_stated}${out.remote_geographic_restriction ? ` (${out.remote_geographic_restriction})` : ""}`);
  console.log(`    tokens in=${usage.inputTokens} out=${usage.outputTokens}  cost=${usage.estimatedCostCents.toFixed(4)}c  ${usage.latencyMs}ms`);
  console.log(`    requirements: ${reqs.length}`);

  for (const r of reqs) {
    const g = checkGrounding(description, r);
    const m = matcher.match(r.normalized_term);
    missRows.push({ term: r.normalized_term, method: m.method });
    const alias = m.method === "ALIAS" || m.method === "RELATED_TERM" ? ` alias->${m.matchedTerm}` : "";
    const warn = g.grounding === "UNGROUNDED" ? "  <-- NOT FOUND IN POSTING"
               : g.grounding === "TERM_ONLY" ? "  <-- paraphrased" : "";
    if (g.grounding !== "VERBATIM") flagged++;
    console.log(
      `      ${r.is_hard_requirement.padEnd(9)} ${String(r.minimum_years ?? "-").padStart(3)}y ` +
      `conf=${r.confidence.toFixed(2)} ${r.kind.padEnd(16)} ${r.normalized_term}${alias}${warn}`,
    );
    if (pilot) console.log(`                  quote: "${String(r.raw_text).slice(0, 100)}"`);
  }

  const lowConf = reqs.filter((r) => r.confidence < 0.6);
  const unclear = reqs.filter((r) => r.is_hard_requirement === "UNCLEAR");
  if (lowConf.length) console.log(`    low confidence (<0.6): ${lowConf.map((r) => r.normalized_term).join(", ")}`);
  if (unclear.length) console.log(`    UNCLEAR hardness: ${unclear.map((r) => r.normalized_term).join(", ")}`);
  if (out.notes) console.log(`    model notes: ${out.notes}`);

  const uncovered = findUncoveredRequirementSentences(description, reqs);
  if (uncovered.length && pilot) {
    console.log(`    possibly missed (${uncovered.length} requirement-like sentences unmatched):`);
    for (const s of uncovered.slice(0, 3)) console.log(`      "${s.slice(0, 110)}"`);
  }

  if (commit) {
    // Re-extraction supersedes rather than duplicates. job_extractions is
    // append-only history, so the earlier attempt stays readable: without
    // it there would be no evidence that the previous version was wrong,
    // which is the whole reason the table is separate from
    // job_requirements.
    const { data: prior } = await db.from("job_extractions")
      .select("id").eq("job_id", job.id).is("superseded_by", null);

    const { data: ins, error } = await db.from("job_extractions").insert({
      job_id: job.id, extraction_version: EXTRACTION_VERSION, llm_tier: "fast",
      input_hash: await sha(description), output: out as any,
      requirements_extracted: reqs.length, succeeded: true,
    }).select("id").single();
    if (error) throw new Error(`job_extractions: ${error.message}`);
    for (const p of prior ?? []) {
      const { error: supErr } = await db.from("job_extractions")
        .update({ superseded_by: ins.id }).eq("id", p.id);
      if (supErr) throw new Error(`supersede: ${supErr.message}`);
    }
    // job_requirements holds the CURRENT reading and is replaced. The
    // superseded extraction above still carries the old one verbatim.
    const { error: delErr } = await db.from("job_requirements").delete().eq("job_id", job.id);
    if (delErr) throw new Error(`clear requirements: ${delErr.message}`);
    await db.from("llm_calls").insert({
      tier: "fast", purpose: "extract_requirements", subject_type: "JOB", subject_id: job.id,
      input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
      estimated_cost_cents: usage.estimatedCostCents, duration_ms: usage.latencyMs, succeeded: true,
    });
    if (reqs.length) {
      const { error: rErr } = await db.from("job_requirements").insert(reqs.map((r) => {
        const m = matcher.match(r.normalized_term);
        return {
          job_id: job.id, kind: r.kind, raw_text: r.raw_text,
          normalized_term: r.normalized_term, skill_id: m.skillId,
          is_hard_requirement: r.is_hard_requirement,
          hard_requirement_reason: r.hard_requirement_reason,
          minimum_years: r.minimum_years,
          extraction_confidence: Math.max(0, Math.min(1, r.confidence)),
          extracted_by: `anthropic:${modelForTier("fast")}`,
          extraction_version: EXTRACTION_VERSION,
          match_method: m.method, matched_term: m.matchedTerm,
        };
      }));
      if (rErr) throw new Error(`job_requirements: ${rErr.message}`);
    }
    await db.from("jobs").update({
      extracted_at: new Date().toISOString(), extraction_version: EXTRACTION_VERSION,
    }).eq("id", job.id);
  }
}

const totalIn = usages.reduce((a, u) => a + u.inputTokens, 0);
const totalOut = usages.reduce((a, u) => a + u.outputTokens, 0);
console.log(`\n${"=".repeat(64)}`);
console.log(`jobs extracted        ${usages.length}`);
console.log(`requirements          ${totalReqs}  (avg ${(totalReqs / Math.max(1, usages.length)).toFixed(1)}/job)`);
console.log(`grounding flags       ${flagged} of ${totalReqs}`);
console.log(`tokens                in ${totalIn.toLocaleString()}  out ${totalOut.toLocaleString()}`);
console.log(`cost                  ${spentCents.toFixed(3)} cents  ($${(spentCents / 100).toFixed(4)})`);
console.log(`per job               ${(spentCents / Math.max(1, usages.length)).toFixed(4)} cents`);
console.log(`projected for 1,471   $${((spentCents / Math.max(1, usages.length)) * 1471 / 100).toFixed(2)}`);
const byMethod: Record<string, number> = {};
for (const m of missRows) byMethod[m.method] = (byMethod[m.method] ?? 0) + 1;
console.log(`match methods         ${JSON.stringify(byMethod)}  (all NONE is expected: profile is empty)`);
console.log(commit ? "\npersisted." : "\ndry run: nothing written.");

async function sha(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
