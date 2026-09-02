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
import { planExtraction, EMPTY_SHA256 } from "../lib/llm/extractionDedup.ts";
import { estimateExtraction, formatEstimate } from "../lib/llm/extractionCost.ts";
import { AnthropicProvider, modelForTier } from "../lib/llm/anthropic.ts";
import { extractRequirements, sanitizeRequirement, reconcileHardness, dedupeRequirements,
  EXTRACTION_VERSION } from "../lib/llm/extractRequirements.ts";
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
    .select("id,company_id,title,source,eligibility,extracted_at,extraction_version,companies!inner(name)")
    .eq("status", "OPEN").in("eligibility", ["ELIGIBLE", "UNCERTAIN"])
    .order("id", { ascending: true }).range(from, from + 999);
  if (error) throw new Error(error.message);
  candidates.push(...data);
  if (data.length < 1000) break;
}

const targetIds = idsFile
  ? new Set((await import("node:fs")).readFileSync(idsFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean))
  : null;

// An extraction stays valid while its inputs do.
//
// Selection used to ask only whether a job had ever been extracted, so a
// posting whose description was rewritten kept its old requirements
// forever, and a daily ingest of an unchanged posting was only spared a
// second paid call because "extracted_at !== null" happened to hold.
// Validity is now the thing it actually depends on: the description that
// was read, the prompt and schema that read it, and the tier that ran.
//
// Note what is NOT re-extracted: eligibility already filtered this list
// to ELIGIBLE and UNCERTAIN, so a job deterministic rules have ruled out
// never reaches a paid call at all. See the eligibility gate above.
const current = new Map<string, { version: number; hash: string; tier: string }>();
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("job_extractions")
    .select("job_id,extraction_version,input_hash,llm_tier,succeeded")
    .is("superseded_by", null).eq("succeeded", true)
    .order("job_id", { ascending: true }).range(from, from + 999);
  if (error) throw new Error(`job_extractions: ${error.message}`);
  for (const e of data ?? []) {
    current.set(e.job_id, { version: e.extraction_version, hash: e.input_hash ?? "", tier: e.llm_tier ?? "" });
  }
  if ((data ?? []).length < 1000) break;
}

const liveHash = new Map<string, string>();
for (let i = 0; i < candidates.length; i += 100) {
  const ids = candidates.slice(i, i + 100).map((c: any) => c.id);
  const { data, error } = await db.from("job_descriptions").select("job_id,description_text").in("job_id", ids);
  if (error) throw new Error(`descriptions: ${error.message}`);
  for (const d of data ?? []) liveHash.set(d.job_id, await sha(d.description_text ?? ""));
}

const staleReason = (j: any): string | null => {
  const cur = current.get(j.id);
  if (!cur) return "never extracted";
  if (cur.version !== EXTRACTION_VERSION) return `extraction v${cur.version} < v${EXTRACTION_VERSION}`;
  const live = liveHash.get(j.id);
  if (live && cur.hash && live !== cur.hash) return "description changed since extraction";
  if (cur.tier && cur.tier !== "fast") return `tier ${cur.tier}`;
  return null;
};

const pool = candidates.filter((j: any) =>
  targetIds ? targetIds.has(j.id)
  : staleOnly ? j.extracted_at !== null && staleReason(j) !== null
  : reextract ? j.extracted_at !== null
  : staleReason(j) !== null);

// An ids-file entry that is INELIGIBLE never appears in candidates, so
// say so rather than silently extracting fewer jobs than were asked for.
if (targetIds) {
  const missing = [...targetIds].filter((id) => !candidates.some((c: any) => c.id === id));
  if (missing.length) {
    console.log(`note: ${missing.length} requested id(s) skipped; not OPEN and ELIGIBLE/UNCERTAIN`);
  }
}

{
  const reasons: Record<string, number> = {};
  for (const j of pool) { const r = staleReason(j) ?? "requested"; reasons[r] = (reasons[r] ?? 0) + 1; }
  console.log(`selection reasons: ${JSON.stringify(reasons)}`);
  const reusable = candidates.length - pool.length;
  console.log(`reusing ${reusable} valid extraction(s); no paid call for those`);
}

if (pool.length === 0) { console.log("nothing to extract for this selection"); process.exit(0); }

// ---- exact-hash deduplication ------------------------------------------
//
// 42.2% of open jobs carry a byte-identical description_hash with another
// job. Same input, same model, same prompt: a second call could only
// return the same answer, at full price.
//
// The LIVE hash is used, not the stored one, so a posting whose text
// changed this morning groups by what it says now. Grouping is on the
// hash alone: 817 same-company-same-title pairs in this corpus have
// different descriptions, and sharing between them would invent
// requirements for one posting out of another's words.
// ONE hash source, used for grouping, for what gets stored, and for
// every later comparison. The first validation run mixed them -- it
// grouped on the live text hash and then compared against the stored
// jobs.description_hash, which is computed differently -- so every reuse
// read as permanently stale. Whatever is written must be the same thing
// that will be checked.
const hashOf = (j: any): string | null => liveHash.get(j.id) ?? null;

// ---- a posting with no text is not extractable ------------------------
//
// The Workday list endpoint returns a title, a location and a path, and
// no description; the description needs a second fetch that the pipeline
// never made. Nineteen eligible Northern Trust postings therefore had a
// blank job_descriptions row, and the first dedup run sent one of them
// to the model, which correctly returned nothing, and copied that
// nothing to eighteen others.
//
// Paying to extract requirements from an empty string cannot succeed.
// These are held out here rather than filtered upstream so the reason is
// visible in the run, and they stay ELIGIBLE and unextracted -- a
// posting we cannot read yet is not a posting we have rejected.
// liveHash is sha256 of the description text and is already computed for
// every candidate. A missing row gives no hash; an empty row gives
// sha256(""). Both mean there is nothing to read. descById is not built
// until after selection, so it cannot be consulted here.
const hasText = (j: any) => { const h = hashOf(j); return h !== null && h !== EMPTY_SHA256; };
const withText = pool.filter(hasText);
const noText = pool.filter((j: any) => !hasText(j));
if (noText.length) {
  console.log(`\nheld back: ${noText.length} job(s) have no description text and cannot be extracted.`);
  const bySrc: Record<string, number> = {};
  for (const j of noText) bySrc[j.source ?? "?"] = (bySrc[j.source ?? "?"] ?? 0) + 1;
  console.log(`  by provider: ${JSON.stringify(bySrc)}`);
  console.log(`  they stay ELIGIBLE and unextracted. For Workday run hydrate-workday-descriptions.ts first.`);
}
if (withText.length === 0) { console.log("\nnothing extractable in this selection"); process.exit(0); }

const plan = planExtraction(withText.map((j: any) => ({ id: j.id, descriptionHash: hashOf(j) })));
const followersOf = new Map<string, any[]>();
for (const [leaderId, fs] of plan.followers) {
  followersOf.set(leaderId, fs.map((f) => withText.find((j: any) => j.id === f.id)).filter(Boolean));
}
if (plan.reused > 0) {
  console.log(`deduplication: ${pool.length} job(s) -> ${plan.uniqueInputs} distinct description(s); `
    + `${plan.reused} will reuse a result rather than making a call`);
}
const leaderPool = plan.leaders.map((l) => withText.find((j: any) => j.id === l.id)).filter(Boolean) as any[];

const estimate = estimateExtraction({ jobs: withText.length, calls: leaderPool.length, price: { in: 1.0, out: 5.0 } });
console.log(`planned cost: ${formatEstimate(estimate)}`);

// A run without --commit used to CALL THE MODEL and then throw the
// answer away: `commit` gated persistence only, never the paid request.
// So "dry run: nothing written" was true and deeply misleading -- the
// money was spent and nothing was kept. It cost a real, if small, amount
// to discover, and would have kept costing it every time anyone checked
// what a run would do.
//
// Without --commit this now stops here, having printed the plan and the
// cost, which is what a dry run was always meant to be.
if (!commit) {
  console.log(`\n(dry run: no model call was made and nothing was written.`);
  console.log(` ${leaderPool.length} call(s) would be made for ${withText.length} extractable job(s). Pass --commit to spend.)`);
  process.exit(0);
}

let selected: any[];
if (limit >= leaderPool.length) {
  selected = leaderPool;
} else {
  const perCompany = new Map<string, any[]>();
  for (const j of leaderPool) {
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
let hardnessCorrections = 0, duplicatesRemoved = 0;
let reused = 0, reuseRefused = 0, reuseFailed = 0, idempotencySkips = 0;
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

    // Re-read immediately before spending. 33 jobs in the historical
    // corpus were extracted twice under the SAME extraction version,
    // which is the one duplicate class that is not a version migration.
    // The pool was computed at start-up; anything that has since been
    // extracted at this version by another run must not be paid for
    // again.
    {
      const { data: fresh } = await db.from("jobs")
        .select("extracted_at,extraction_version").eq("id", job.id).maybeSingle();
      if (fresh?.extracted_at && fresh.extraction_version === EXTRACTION_VERSION && !reextract && !targetIds) {
        idempotencySkips++;
        continue;
      }
    }
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
      // The quote outranks the label. A requirement whose own words say
      // "minimum of" cannot be optional, whatever the model called it.
      const rec = reconcileHardness(clean.requirement as any);
      if (rec.corrected) {
        hardnessCorrections++;
        anomalies.push({ job: job.title, company,
          note: `PREFERRED -> HARD on mandatory wording: "${String(clean.requirement.raw_text).slice(0, 60)}"` });
        (clean.requirement as any).is_hard_requirement = rec.hardness;
      }
      reqs.push(clean.requirement);
    }
    // Same capability twice is one requirement, not two.
    const deduped = dedupeRequirements(reqs as any[]);
    if (deduped.removed > 0) {
      duplicatesRemoved += deduped.removed;
      anomalies.push({ job: job.title, company, note: `${deduped.removed} duplicate requirement(s) collapsed` });
    }
    reqs.length = 0;
    reqs.push(...(deduped.kept as any[]));
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
        // The leader made the call itself, so it borrows from nobody.
        extraction_source_job_id: null, extraction_reuse_hash: null,
      }).eq("id", job.id);

      // ---- propagate to the jobs that share this exact description ----
      //
      // Written from the SAME requirement rows the model returned, with
      // the same version and the same extracted_by, so a follower is
      // indistinguishable from having been extracted directly -- which
      // it is, because the input was identical.
      //
      // The hash is re-checked here rather than trusted from planning
      // time. A description that changed between the plan and this
      // moment is no longer the same text, and reuse would be a guess.
      const followers = followersOf.get(job.id) ?? [];
      const groupHash = hashOf(job);
      for (const f of followers) {
        const fHash = hashOf(f);
        if (!groupHash || !fHash || fHash !== groupHash || groupHash === EMPTY_SHA256) {
          anomalies.push({ job: f.title, company: (f.companies as any)?.name ?? "?",
            note: "description changed after planning; reuse refused, left for its own extraction" });
          reuseRefused++;
          continue;
        }
        try {
          const { error: fd } = await db.from("job_requirements").delete().eq("job_id", f.id);
          if (fd) throw new Error(fd.message);
          if (reqs.length) {
            const { error: fe } = await db.from("job_requirements").insert(reqs.map((r) => {
              const m = matcher.match(r.normalized_term);
              return {
                job_id: f.id, kind: r.kind, raw_text: r.raw_text, normalized_term: r.normalized_term,
                skill_id: m.skillId, is_hard_requirement: r.is_hard_requirement,
                hard_requirement_reason: r.hard_requirement_reason, minimum_years: r.minimum_years,
                extraction_confidence: Math.max(0, Math.min(1, r.confidence)),
                extracted_by: `anthropic:${modelForTier("fast")}`, extraction_version: EXTRACTION_VERSION,
                match_method: m.method, matched_term: m.matchedTerm,
              };
            }));
            if (fe) throw new Error(fe.message);
          }
          const { error: fu } = await db.from("jobs").update({
            extracted_at: new Date().toISOString(), extraction_version: EXTRACTION_VERSION,
            extraction_source_job_id: job.id, extraction_reuse_hash: groupHash,
          }).eq("id", f.id);
          if (fu) throw new Error(fu.message);
          reused++;
        } catch (e) {
          reuseFailed++;
          failures.push({ job: f.title, company: (f.companies as any)?.name ?? "?",
            error: `reuse: ${String(e).slice(0, 160)}` });
        }
      }
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
console.log(`hardness corrections  ${hardnessCorrections}  (PREFERRED -> HARD on mandatory wording)`);
console.log(`duplicates collapsed  ${duplicatesRemoved}`);
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
