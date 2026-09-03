/**
 * Turns completed batch results into requirements.
 *
 *   node scripts/batch-consume.ts          report only
 *   node scripts/batch-consume.ts --write  persist
 *
 * Reads results the provider has ALREADY produced. It never creates a
 * batch, never resends, never retries: the only network call is a GET of
 * the results file, which costs nothing.
 *
 * VALIDATION IS THE SYNCHRONOUS PATH'S, NOT A SECOND ONE
 *
 * sanitizeRequirement, reconcileHardness and dedupeRequirements are the
 * same functions extract.ts calls, in the same order. A batch result
 * that would have been rejected synchronously is rejected here, and one
 * that survives is written by the same shape of insert. If the two ever
 * diverge the whole cost comparison stops meaning anything.
 *
 * IDEMPOTENCE
 *
 * A job is marked extracted only after its own requirements are
 * persisted, and a request already marked persisted is skipped. Rerunning
 * cannot duplicate a requirement or re-mark a job, and makes no paid
 * call either way.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { modelForTier } from "../lib/llm/anthropic.ts";
import { sanitizeRequirement, reconcileHardness, dedupeRequirements,
         EXTRACTION_VERSION } from "../lib/llm/extractRequirements.ts";
import { getBatch, getResults } from "../lib/llm/batchClient.ts";
import { TermMatcher } from "../lib/matching/match.ts";

const WRITE = process.argv.includes("--write");
const MODEL = modelForTier("fast");
/** Batch is half the synchronous rate. */
const BATCH_PRICE = { in: 0.5, out: 2.5 };

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const page = async (t: string, c: string, ord = "id") => { const o: any[] = [];
  for (let x = 0; ; x += 1000) { const { data, error } = await db.from(t).select(c).order(ord).range(x, x + 999);
    if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break; } return o; };

const skills = await page("skills", "id,name,related_terms,status");
const aliases = await page("term_aliases", "alias,canonical_term");
const matcher = new TermMatcher(skills.map((s: any) => ({ id: s.id, name: s.name, relatedTerms: s.related_terms ?? [], status: s.status })), aliases as any);

const { data: batches } = await db.from("extraction_batches").select("*")
  .in("status", ["COMPLETED", "PROCESSING"]).not("provider_batch_id", "is", null);
console.log(`batches to consume: ${(batches ?? []).length}`);

let validated = 0, persisted = 0, marked = 0, skipped = 0, invalid = 0, totalReqs = 0;
let measuredIn = 0, measuredOut = 0, measuredCents = 0, unmeasured = 0;
const failures: string[] = [];

for (const b of batches ?? []) {
  const provider = await getBatch(b.provider_batch_id);
  if (!provider?.results_url) { console.log(`  ${b.id.slice(0, 8)}: no results yet`); continue; }
  const lines = await getResults(provider.results_url);
  console.log(`  ${b.id.slice(0, 8)}: ${lines.length} result line(s)`);

  const { data: reqRows } = await db.from("extraction_batch_requests").select("*").eq("batch_id", b.id);
  const byCustom = new Map((reqRows ?? []).map((r: any) => [r.custom_id, r]));
  const descs = new Map<string, string>();
  for (const r of reqRows ?? []) {
    const { data: d } = await db.from("job_descriptions").select("description_text").eq("job_id", r.job_id).maybeSingle();
    descs.set(r.job_id, d?.description_text ?? "");
  }

  for (const line of lines) {
    const row: any = byCustom.get(line.custom_id);
    if (!row) { failures.push(`${line.custom_id}: no local request row`); continue; }
    // Already consumed. Rerunning must not write anything again.
    if (row.result_persisted_at) { skipped++; continue; }
    if (line.result.type !== "succeeded") { continue; }

    const msg: any = (line.result as any).message;
    // Structured output arrives as a forced tool call, exactly as the
    // synchronous provider parses it.
    const toolUse = (msg?.content ?? []).find((c: any) => c.type === "tool_use" && c.name === "emit");
    if (!toolUse) {
      invalid++; failures.push(`${row.job_id.slice(0, 8)}: no emit tool call in the response`);
      if (WRITE) await db.from("extraction_batch_requests").update({ status: "FAILED", error: "no emit tool call" }).eq("id", row.id);
      continue;
    }
    if (msg?.stop_reason === "max_tokens") {
      // The same fail-closed rule as the synchronous path: a truncated
      // result is discarded, never stored as partial.
      invalid++; failures.push(`${row.job_id.slice(0, 8)}: truncated at max_tokens; discarded`);
      if (WRITE) await db.from("extraction_batch_requests").update({ status: "FAILED", error: "truncated at max_tokens" }).eq("id", row.id);
      continue;
    }

    // ---- the synchronous validation pipeline, unchanged --------------
    const out = toolUse.input ?? {};
    const reqs: any[] = [];
    for (const raw of out.requirements ?? []) {
      const clean = sanitizeRequirement(raw as any);
      if (!clean) continue;
      const rec = reconcileHardness(clean.requirement as any);
      if (rec.corrected) (clean.requirement as any).is_hard_requirement = rec.hardness;
      reqs.push(clean.requirement);
    }
    const deduped = dedupeRequirements(reqs as any[]);
    const kept = deduped.kept as any[];
    validated++;
    totalReqs += kept.length;

    // Usage as the provider measured it. Never invented.
    const u = msg?.usage;
    let cents: number | null = null;
    if (typeof u?.input_tokens === "number" && typeof u?.output_tokens === "number") {
      cents = (u.input_tokens / 1e6) * BATCH_PRICE.in * 100 + (u.output_tokens / 1e6) * BATCH_PRICE.out * 100;
      measuredIn += u.input_tokens; measuredOut += u.output_tokens; measuredCents += cents;
    } else { unmeasured++; }

    if (!WRITE) continue;

    try {
      // Requirements first, then the mark. A job is extracted only once
      // its own rows are down.
      const { error: de } = await db.from("job_requirements").delete().eq("job_id", row.job_id);
      if (de) throw new Error(de.message);
      if (kept.length) {
        const { error: ie } = await db.from("job_requirements").insert(kept.map((r) => {
          const m = matcher.match(r.normalized_term);
          return {
            job_id: row.job_id, kind: r.kind, raw_text: r.raw_text, normalized_term: r.normalized_term,
            skill_id: m.skillId, is_hard_requirement: r.is_hard_requirement,
            hard_requirement_reason: r.hard_requirement_reason, minimum_years: r.minimum_years,
            extraction_confidence: Math.max(0, Math.min(1, r.confidence)),
            extracted_by: `anthropic:${MODEL}`, extraction_version: EXTRACTION_VERSION,
            match_method: m.method, matched_term: m.matchedTerm,
          };
        }));
        if (ie) throw new Error(ie.message);
      }
      persisted++;
      await db.from("jobs").update({
        extracted_at: new Date().toISOString(), extraction_version: EXTRACTION_VERSION,
        extraction_source_job_id: null, extraction_reuse_hash: null,
      }).eq("id", row.job_id);
      marked++;
      // The spend ledger. Recorded against the same subject the
      // synchronous path uses, with the batch id kept for provenance.
      await db.from("llm_calls").insert({
        tier: "fast", purpose: "extract_requirements", subject_type: "JOB", subject_id: row.job_id,
        input_tokens: u?.input_tokens ?? null, output_tokens: u?.output_tokens ?? null,
        estimated_cost_cents: cents, succeeded: true, cache_hit: false,
        error: `batch:${b.provider_batch_id}`,
      });
      await db.from("extraction_batch_requests").update({ result_persisted_at: new Date().toISOString() }).eq("id", row.id);
    } catch (e) {
      failures.push(`${row.job_id.slice(0, 8)}: persist failed: ${String(e).slice(0, 140)}`);
      if (WRITE) await db.from("extraction_batch_requests").update({ error: `persist: ${String(e).slice(0, 200)}` }).eq("id", row.id);
    }
  }
  // The ledger is the source of truth, not this run's tally. A rerun
  // consumes nothing and measures nothing, and writing that zero over a
  // real figure would erase the record of what was actually spent.
  if (WRITE) {
    const { data: ledger } = await db.from("llm_calls")
      .select("estimated_cost_cents").like("error", `batch:${b.provider_batch_id}`);
    const total = (ledger ?? []).reduce((n: number, c: any) => n + Number(c.estimated_cost_cents ?? 0), 0);
    if (total > 0) await db.from("extraction_batches").update({ actual_cost_cents: total }).eq("id", b.id);
  }
}

console.log(`\nvalidated locally      ${validated}`);
console.log(`already consumed       ${skipped}`);
console.log(`invalid / discarded    ${invalid}`);
console.log(`persisted requirements ${persisted} job(s), ${totalReqs} requirement(s)`);
console.log(`marked extracted       ${marked}`);
console.log(`measured tokens        in ${measuredIn}, out ${measuredOut}`);
console.log(`measured cost          $${(measuredCents / 100).toFixed(4)} (batch pricing, from provider usage)`);
if (unmeasured) console.log(`results with NO usage reported: ${unmeasured} (cost not fabricated for these)`);
if (failures.length) { console.log(`\nfailures (${failures.length}):`); for (const f of failures) console.log(`  ${f}`); }
if (!WRITE) console.log(`\n(report only; pass --write to persist. No paid call is made either way.)`);
