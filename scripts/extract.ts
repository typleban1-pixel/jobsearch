/**
 * Requirement extraction.
 *
 *   node scripts/extract.ts --limit 25 --pilot          sample, verbose
 *   node scripts/extract.ts --limit 9999 --commit       full pass
 *   node scripts/extract.ts --stale --commit            jobs behind the current version
 *   node scripts/extract.ts --reextract --limit 10      redo already-extracted jobs
 *
 * Resumable by construction: the default selection is jobs with no
 * extraction at all, so a run that dies partway is continued by running
 * it again.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { AnthropicProvider, modelForTier } from "../lib/llm/anthropic.ts";
import { extractRequirements, sanitizeRequirement, EXTRACTION_VERSION } from "../lib/llm/extractRequirements.ts";
import { checkGrounding, findUncoveredRequirementSentences } from "../lib/llm/grounding.ts";
import { TermMatcher } from "../lib/matching/match.ts";
import { classOfKind } from "../lib/scoring/kinds.ts";
import type { LlmUsage } from "../lib/llm/provider.ts";

const arg = (n: string, d: number) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
};
const limit = arg("limit", 25);
const concurrency = arg("concurrency", 8);
const BUDGET_CENTS = arg("budget", 100);
const commit = process.argv.includes("--commit");
const pilot = process.argv.includes("--pilot");
const reextract = process.argv.includes("--reextract");
const staleOnly = process.argv.includes("--stale");
/** Explicit job-id list, one per line. Used to re-run a review queue only. */
const idsFileIdx = process.argv.indexOf("--ids-file");
const idsFile = idsFileIdx > -1 ? process.argv[idsFileIdx + 1] : null;

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });
const llm = new AnthropicProvider();

const { data: aliases } = await db.from("term_aliases").select("alias,canonical_term");
const { data: verifiedSkills } = await db.from("skills").select("id,name,related_terms").eq("status", "VERIFIED");
const matcher = new TermMatcher(
  (verifiedSkills ?? []).map((s: any) => ({ id: s.id, name: s.name, relatedTerms: s.related_terms ?? [] })),
  (aliases ?? []) as any,
);

const candidates: any[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("jobs")
    .select("id,company_id,title,eligibility,extracted_at,extraction_version,companies!inner(name)")
    .eq("status", "OPEN").in("eligibility", ["ELIGIBLE", "UNCERTAIN"])
    .order("id", { ascending: true }).range(from, from + 999);
  if (error) throw new Error(error.message);
  candidates.push(...data);
  if (data.length < 1000) break;
}

const targetIds = idsFile
  ? new Set((await import("node:fs")).readFileSync(idsFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean))
  : null;

const pool = candidates.filter((j: any) =>
  targetIds ? targetIds.has(j.id)
  : staleOnly ? j.extracted_at !== null && j.extraction_version !== EXTRACTION_VERSION
  : reextract ? j.extracted_at !== null
  : j.extracted_at === null);

if (pool.length === 0) { console.log("nothing to extract for this selection"); process.exit(0); }

let selected: any[];
if (limit >= pool.length) {
  selected = pool;
} else {
  const perCompany = new Map<string, any[]>();
  for (const j of pool) {
    const arr = perCompany.get(j.company_id) ?? [];
    if (arr.length < 3) { arr.push(j); perCompany.set(j.company_id, arr); }
  }
  selected = [];
  outer: for (let round = 0; round < 3; round++) {
    for (const arr of perCompany.values()) {
      if (arr[round]) selected.push(arr[round]);
      if (selected.length >= limit) break outer;
    }
  }
}

// Chunked. 1,447 uuids in a single .in() builds a ~54 KB URL and
// PostgREST rejects anything past its ~16 KB header limit; this is the
// same trap that broke listJobsForCompany during the Phase 2 cold load.
const descById = new Map<string, string>();
for (let i = 0; i < selected.length; i += 100) {
  const ids = selected.slice(i, i + 100).map((s) => s.id);
  const { data, error } = await db.from("job_descriptions").select("job_id,description_text").in("job_id", ids);
  if (error) throw new Error(`descriptions: ${error.message}`);
  for (const d of data ?? []) descById.set(d.job_id, d.description_text ?? "");
}

console.log(`extraction: ${selected.length} jobs, tier=fast (${modelForTier("fast")}), ` +
  `extraction_version=${EXTRACTION_VERSION}, concurrency=${concurrency}, budget ${BUDGET_CENTS}c`);
console.log(`selection: ${staleOnly ? "stale version" : reextract ? "re-extract" : "not yet extracted"}\n`);

let spentCents = 0;
let attempted = 0, succeeded = 0, failed = 0, totalReqs = 0, groundingFlags = 0, coercionCount = 0, persistFailed = 0;
let budgetStopped = false;
const usages: LlmUsage[] = [];
const failures: Array<{ job: string; company: string; error: string }> = [];
const anomalies: Array<{ job: string; company: string; note: string }> = [];
const classCounts: Record<string, number> = {};
const started = Date.now();

let cursor = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
  for (;;) {
    if (budgetStopped) return;
    const i = cursor++;
    if (i >= selected.length) return;
    const job = selected[i]!;
    const company = (job.companies as any)?.name ?? "?";
    const description = descById.get(job.id) ?? "";

    if (spentCents > BUDGET_CENTS) {
      if (!budgetStopped) { budgetStopped = true; console.log(`\nBUDGET REACHED at ${spentCents.toFixed(1)}c, stopping`); }
      return;
    }
    attempted++;

    let out, usage;
    try {
      const r = await extractRequirements(llm, { title: job.title, company, descriptionText: description });
      out = r.content; usage = r.usage;
    } catch (e) {
      failed++;
      const msg = String(e).slice(0, 220);
      failures.push({ job: job.title, company, error: msg });
      if (commit) {
        // A failed extraction is recorded, not forgotten. Otherwise the
        // job looks merely unattempted and the next run silently retries
        // it forever without anyone noticing a systematic failure.
        await db.from("job_extractions").insert({
          job_id: job.id, extraction_version: EXTRACTION_VERSION, llm_tier: "fast",
          input_hash: await sha(description), output: {}, requirements_extracted: 0,
          succeeded: false, error: msg,
        });
        await db.from("llm_calls").insert({
          tier: "fast", purpose: "extract_requirements", subject_type: "JOB", subject_id: job.id,
          succeeded: false, error: msg,
        });
      }
      continue;
    }

    spentCents += usage.estimatedCostCents;
    usages.push(usage);
    succeeded++;

    // Validate at the boundary. Anything the model got wrong is corrected
    // and reported here, never handed to Postgres to reject.
    const reqs: any[] = [];
    for (const rawReq of out.requirements ?? []) {
      const clean = sanitizeRequirement(rawReq as any);
      if (!clean) {
        anomalies.push({ job: job.title, company, note: "dropped a requirement with no quote or term" });
        continue;
      }
      for (const c of clean.coercions) {
        coercionCount++;
        anomalies.push({ job: job.title, company, note: `coerced ${c.field}: "${c.got}" -> ${c.used}` });
      }
      reqs.push(clean.requirement);
    }
    totalReqs += reqs.length;
    for (const r of reqs) classCounts[classOfKind(r.kind)] = (classCounts[classOfKind(r.kind)] ?? 0) + 1;

    let jobFlags = 0;
    for (const r of reqs) {
      if (checkGrounding(description, r, job.title).grounding !== "VERBATIM") { jobFlags++; groundingFlags++; }
    }

    if (reqs.length === 0) anomalies.push({ job: job.title, company, note: "extraction returned zero requirements" });
    if (reqs.length > 30) anomalies.push({ job: job.title, company, note: `${reqs.length} requirements extracted` });
    if (description.length < 300) anomalies.push({ job: job.title, company, note: `description only ${description.length} chars` });
    if (jobFlags > 0) anomalies.push({ job: job.title, company, note: `${jobFlags} requirement(s) not found verbatim in the posting` });

    if (pilot) {
      console.log(`\n[${i + 1}] ${company} — ${job.title}  (${job.eligibility}, ${description.length} chars)`);
      console.log(`    model remote: ${out.remote_policy_stated}${out.remote_geographic_restriction ? ` (${out.remote_geographic_restriction})` : ""}  ${usage.inputTokens}/${usage.outputTokens} tok  ${usage.estimatedCostCents.toFixed(3)}c`);
      for (const r of reqs) {
        console.log(`      ${r.is_hard_requirement.padEnd(9)} ${String(r.minimum_years ?? "-").padStart(3)}y conf=${r.confidence.toFixed(2)} ${r.kind.padEnd(16)} ${r.normalized_term}`);
      }
    }

    if (commit) try {
      const { data: prior } = await db.from("job_extractions")
        .select("id").eq("job_id", job.id).is("superseded_by", null);
      const { data: ins, error } = await db.from("job_extractions").insert({
        job_id: job.id, extraction_version: EXTRACTION_VERSION, llm_tier: "fast",
        input_hash: await sha(description), output: out as any,
        requirements_extracted: reqs.length, succeeded: true,
      }).select("id").single();
      if (error) throw new Error(`job_extractions: ${error.message}`);
      for (const p of prior ?? []) {
        const { error: se } = await db.from("job_extractions").update({ superseded_by: ins.id }).eq("id", p.id);
        if (se) throw new Error(`supersede: ${se.message}`);
      }
      await db.from("llm_calls").insert({
        tier: "fast", purpose: "extract_requirements", subject_type: "JOB", subject_id: job.id,
        input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
        estimated_cost_cents: usage.estimatedCostCents, duration_ms: usage.latencyMs, succeeded: true,
      });
      const { error: de } = await db.from("job_requirements").delete().eq("job_id", job.id);
      if (de) throw new Error(`clear requirements: ${de.message}`);
      if (reqs.length) {
        const { error: re } = await db.from("job_requirements").insert(reqs.map((r) => {
          const m = matcher.match(r.normalized_term);
          return {
            job_id: job.id, kind: r.kind, raw_text: r.raw_text, normalized_term: r.normalized_term,
            skill_id: m.skillId, is_hard_requirement: r.is_hard_requirement,
            hard_requirement_reason: r.hard_requirement_reason, minimum_years: r.minimum_years,
            extraction_confidence: Math.max(0, Math.min(1, r.confidence)),
            extracted_by: `anthropic:${modelForTier("fast")}`, extraction_version: EXTRACTION_VERSION,
            match_method: m.method, matched_term: m.matchedTerm,
          };
        }));
        if (re) throw new Error(`job_requirements: ${re.message}`);
      }
      await db.from("jobs").update({
        extracted_at: new Date().toISOString(), extraction_version: EXTRACTION_VERSION,
      }).eq("id", job.id);
    } catch (e) {
      // A persistence failure fails THIS job. Throwing here would reject
      // the enclosing Promise.all and abandon every other worker, which
      // is exactly how one malformed row ended a 1,447 job run.
      persistFailed++;
      const msg = String(e).slice(0, 220);
      failures.push({ job: job.title, company, error: `persist: ${msg}` });
    }

    if (!pilot && succeeded % 50 === 0) {
      const rate = succeeded / ((Date.now() - started) / 1000);
      const left = (selected.length - succeeded - failed) / Math.max(rate, 0.01);
      console.log(`  ${succeeded}/${selected.length} ok, ${failed} failed, ${spentCents.toFixed(0)}c spent, ` +
        `${rate.toFixed(1)}/s, ~${(left / 60).toFixed(0)}min left`);
    }
  }
}));

const totalIn = usages.reduce((a, u) => a + u.inputTokens, 0);
const totalOut = usages.reduce((a, u) => a + u.outputTokens, 0);
console.log(`\n${"=".repeat(60)}`);
console.log(`attempted             ${attempted}`);
console.log(`succeeded             ${succeeded}`);
console.log(`failed                ${failed}`);
console.log(`requirements          ${totalReqs}  (avg ${(totalReqs / Math.max(1, succeeded)).toFixed(1)}/job)`);
console.log(`grounding flags       ${groundingFlags} of ${totalReqs}`);
console.log(`field coercions       ${coercionCount}`);
console.log(`persist failures      ${persistFailed}`);
console.log(`class distribution    ${JSON.stringify(classCounts)}`);
console.log(`tokens                in ${totalIn.toLocaleString()}  out ${totalOut.toLocaleString()}`);
console.log(`cost                  ${spentCents.toFixed(2)}c  ($${(spentCents / 100).toFixed(2)})`);
console.log(`wall time             ${((Date.now() - started) / 60000).toFixed(1)} min`);
if (failures.length) {
  console.log(`\nfailures (${failures.length}):`);
  for (const f of failures.slice(0, 20)) console.log(`  ${f.company} — ${f.job}: ${f.error}`);
}
if (anomalies.length) {
  console.log(`\nanomalies (${anomalies.length}):`);
  for (const a of anomalies.slice(0, 25)) console.log(`  ${a.company} — ${a.job}: ${a.note}`);
}
console.log(commit ? "\npersisted." : "\ndry run: nothing written.");

async function sha(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
