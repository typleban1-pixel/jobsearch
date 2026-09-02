/**
 * Resolves DISCOVERED companies to a verified board.
 *
 * Order is the whole design:
 *
 *   1. read the company's careers page and take the board it links to
 *   2. if the page fingerprints a provider without naming a token,
 *      guess tokens for THAT provider only
 *   3. otherwise guess across all three providers
 *   4. test every candidate against the live board
 *   5. promote to ACTIVE only when a board answers with postings
 *
 * Step 5 is not a formality. The hand-written candidate list paired 57
 * real companies with guessed tokens and 20 verified. A plausible token
 * that is wrong produces a company that looks checked every day and
 * contributes nothing, which is worse than not having it.
 *
 * Companies that resolve to nothing stay DISCOVERED with the attempt
 * recorded, and are retried a month later. A company without a board
 * today may have one next quarter.
 *
 *   node scripts/resolve-ats.ts --limit=50
 *   node scripts/resolve-ats.ts --limit=50 --commit
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { detectFromCareersPage, candidatesFor, corroborate, boardSample, type TokenCandidate } from "../lib/discovery/resolveAts.ts";
import { verifyBoard } from "../lib/ingest/run.ts";
import type { AtsProviderName } from "../lib/ingest/providers/types.ts";

const commit = process.argv.includes("--commit");
const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 25);
/**
 * Companies resolved at once.
 *
 * The loop was fully sequential and each company costs up to twenty HTTP
 * round trips -- eight careers-page paths at a 12s timeout, then up to
 * twelve board probes -- so a run averaged 15s per company and 150
 * companies took 37 minutes. That is the whole throughput problem: the
 * backlog is 2,658 never-attempted companies, which is eighteen days at
 * that rate.
 *
 * Concurrency is per COMPANY, and companies are different hosts, so this
 * adds no pressure on any single origin. The 120ms spacing between board
 * probes inside one company is untouched, which is where politeness to
 * the ATS APIs actually lives.
 */
const concurrency = Number(process.argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? 6);
/**
 * Team-size floor.
 *
 * The first sweep resolved 1 company in 60. The resolver was not the
 * problem: YC's directory is ordered newest-first, so page 1 is the most
 * recent batches, and a ten-person company three months old does not have
 * an applicant tracking system yet. Size is the cheapest available proxy
 * for "has hiring infrastructure".
 */
const minSize = Number(process.argv.find((a) => a.startsWith("--min-size="))?.split("=")[1] ?? 0);
const RETRY_AFTER_DAYS = 30;

/**
 * Re-check employers last attempted before a given moment.
 *
 * The thirty-day cooldown assumes a failed attempt stays failed, which
 * holds while the resolver is unchanged. It stopped holding when Workday
 * detection landed: every employer checked before that was checked by a
 * resolver that could not see the most common enterprise ATS, so their
 * "unresolved" says nothing about whether they have a board.
 */
const recheckBefore = process.argv.find((a) => a.startsWith("--recheck-before="))?.split("=")[1] ?? null;

/**
 * Organisations that empirically do not run a standard ATS.
 *
 * Museums, orchestras, libraries and civic bodies resolved far below the
 * rest of the Wikidata population. They are ordered last rather than
 * excluded: a park district with a Workday tenant is still worth having,
 * it is just not worth checking before a hospital network.
 */
const LOW_YIELD = /\b(museum|orchestra|symphony|opera|ballet|library|historical society|park district|township|archdiocese|diocese|parish|cathedral|church|temple|synagogue|cemetery|monument|memorial|landmark|zoo|aquarium|botanic|conservatory|theatre|theater|gallery|arena|stadium|ballpark|fc\b|sc\b|athletic club|country club|fraternity|sorority|lodge)\b/i;

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const page = async (t: string, c: string, x: (q: any) => any = (q) => q) => {
  const o: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await x(db.from(t).select(c)).order("id").range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break;
  } return o;
};

// Highest priority first, then never-attempted before previously-failed.
const cutoff = new Date(Date.now() - RETRY_AFTER_DAYS * 86_400_000).toISOString();
const all = await page("companies", "id,name,domain,lifecycle,priority_score,ats_detection_method,notes,current_size_min",
  (q: any) => q.eq("lifecycle", "DISCOVERED"));
const attempts = await page("company_token_candidates", "company_id,tested_at");
const lastAttempt = new Map<string, string>();
for (const a of attempts) {
  if (!a.tested_at) continue;
  const prev = lastAttempt.get(a.company_id);
  if (!prev || a.tested_at > prev) lastAttempt.set(a.company_id, a.tested_at);
}

const due = all
  .filter((c: any) => c.domain)
  // Unknown size is not small size. Coercing null to 0 made a company
  // whose headcount nobody has recorded fail a floor it was never
  // measured against, which is the same mistake as treating an unstated
  // salary as below the floor. Unknown is included and ranked after the
  // known-large, never excluded.
  .filter((c: any) => minSize === 0 || c.current_size_min === null || c.current_size_min >= minSize)
  .filter((c: any) => {
    const t = lastAttempt.get(c.id);
    if (!t) return true;                                   // never checked
    if (recheckBefore && t < recheckBefore) return true;    // checked by an older resolver
    return t < cutoff;
  })
  .sort((a: any, b: any) => {
    // Never-attempted first, then everything else.
    const at = lastAttempt.get(a.id) ? 1 : 0, bt = lastAttempt.get(b.id) ? 1 : 0;
    // Organisations that empirically do not run an ATS go last. Still
    // checked, just not ahead of employers that hire at volume.
    const al = LOW_YIELD.test(a.name ?? "") ? 1 : 0, bl = LOW_YIELD.test(b.name ?? "") ? 1 : 0;
    // Priority BEFORE headcount.
    //
    // This was the other way round, and it quietly inverted the whole
    // ordering. Wikidata records a headcount for 98% of Y Combinator
    // companies and 4% of Chicago employers, so ranking by
    // "size is known" put 2,490 startups ahead of 1,017 Chicago
    // employers with a much higher priority score. Northern Trust and
    // Boeing have no recorded headcount either.
    //
    // A missing headcount means Wikidata did not record one. It is
    // UNKNOWN, and it is not evidence that an employer is small.
    const pr = b.priority_score - a.priority_score;
    // Headcount now only breaks ties within the same priority, where a
    // recorded size is a mild signal that an employer has hiring
    // infrastructure.
    const ar = a.current_size_min === null ? 1 : 0, br = b.current_size_min === null ? 1 : 0;
    return at - bt || al - bl || pr || ar - br;
  })
  .slice(0, limit);

console.log(`DISCOVERED companies: ${all.length} (${all.filter((c: any) => !c.domain).length} without a domain, skipped)`);
console.log(`team-size floor: ${minSize || "none"}`);
if (recheckBefore) console.log(`re-checking anything last attempted before ${recheckBefore}`);
console.log(`due for an attempt: ${due.length}\n`);

const stats = { direct: 0, fingerprint: 0, guess: 0, unresolved: 0, boardCalls: 0, rejected: 0 };
const byProvider: Record<string, number> = {};
const resolved: Array<{ company: any; candidate: TokenCandidate; jobCount: number }> = [];
const unresolved: Array<{ company: any; tried: number; providersSeen: string[] }> = [];

async function resolveOne(company: any): Promise<void> {
  const detection = await detectFromCareersPage(company.domain, { timeoutMs: 12_000 });

  let candidates: TokenCandidate[] = [...detection.candidates];
  if (candidates.length === 0) {
    // A fingerprinted provider turns a guess across three boards into a
    // guess across one, which is both cheaper and likelier to be right.
    const providers = (detection.providersSeen.length > 0
      ? detection.providersSeen
      : ["GREENHOUSE", "LEVER", "ASHBY"]) as AtsProviderName[];
    candidates = candidatesFor(company.name, company.domain, providers);
  }

  let hit: { candidate: TokenCandidate; jobCount: number; why: string } | null = null;
  const tested: Array<{ c: TokenCandidate; ok: boolean; jobCount: number; error: string | null }> = [];
  for (const c of candidates.slice(0, 12)) {
    const v = await verifyBoard(c.provider, c.token);
    stats.boardCalls++;
    if (!v.ok) {
      tested.push({ c, ok: false, jobCount: v.jobCount, error: v.error });
      await new Promise((r) => setTimeout(r, 120));
      continue;
    }

    // The board exists. That is not the same as it being THIS company's.
    const sample = await boardSample(c.provider, c.token);
    const corr = corroborate({ name: company.name, domain: company.domain }, c, sample);
    tested.push({
      c, ok: corr.ok, jobCount: v.jobCount,
      error: corr.ok ? null : `not corroborated: ${corr.reason}`,
    });
    if (corr.ok) { hit = { candidate: c, jobCount: v.jobCount, why: corr.reason }; break; }
    stats.rejected++;
    console.log(`     rejected ${c.provider}:${c.token} — ${corr.reason.slice(0, 76)}`);
    await new Promise((r) => setTimeout(r, 120));
  }

  if (hit) {
    if (hit.candidate.method === "CAREERS_PAGE") stats.direct++;
    else if (detection.providersSeen.length > 0) stats.fingerprint++;
    else stats.guess++;
    byProvider[hit.candidate.provider] = (byProvider[hit.candidate.provider] ?? 0) + 1;
    resolved.push({ company, candidate: hit.candidate, jobCount: hit.jobCount });
    console.log(`  RESOLVED  ${company.name.slice(0, 30).padEnd(30)} ${(hit.candidate.provider + ":" + hit.candidate.token).padEnd(26)} ${String(hit.jobCount).padStart(4)} jobs  ${hit.candidate.method}  [${hit.why.slice(0, 44)}]`);
  } else {
    stats.unresolved++;
    unresolved.push({ company, tried: tested.length, providersSeen: detection.providersSeen });
    console.log(`  unresolved ${company.name.slice(0, 33).padEnd(33)} tried ${tested.length} candidate(s)${detection.providersSeen.length ? `, page fingerprints ${detection.providersSeen.join(",")}` : ""}`);
  }

  if (commit) {
    // Every attempt is recorded, resolved or not, so a company that never
    // resolves is auditable rather than silently absent.
    const rows = tested.map((t) => ({
      company_id: company.id, company_name: company.name,
      ats_provider: t.c.provider, candidate_token: t.c.token,
      source: t.c.method, source_url: t.c.sourceUrl,
      tested_at: new Date().toISOString(),
      test_result: t.ok ? `verified, ${t.jobCount} postings` : (t.error ?? "no postings"),
      job_count: t.jobCount, confirmed: t.ok,
    }));
    // One statement, not one per candidate. At 5.9 candidates per
    // company this was 5.9 round trips of pure bookkeeping per company.
    if (rows.length) {
      await db.from("company_token_candidates")
        .upsert(rows, { onConflict: "ats_provider,candidate_token" });
    }
    if (hit) {
      const { error } = await db.from("companies").update({
        ats_provider: hit.candidate.provider,
        ats_token: hit.candidate.token,
        ats_detection_method: hit.candidate.method === "CAREERS_PAGE"
          ? `careers page: ${hit.candidate.sourceUrl}`
          : detection.providersSeen.length > 0
            ? `token guess, provider fingerprinted from ${company.domain}`
            : "token guess, no provider signal",
        lifecycle: "ACTIVE",
        verified_at: new Date().toISOString(),
        open_job_count: hit.jobCount,
        open_job_count_at: new Date().toISOString(),
      }).eq("id", company.id);
      if (error) console.log(`     ! could not activate: ${error.message}`);
    }
  }
}

// Bounded parallelism. A worker pool rather than fixed batches, so one
// slow company does not idle the others waiting for it.
const queue = [...due];
const started = Date.now();
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
  for (;;) {
    const company = queue.shift();
    if (!company) return;
    try { await resolveOne(company); }
    catch (e) {
      // One company's failure must not end the run: the backlog is the
      // point, and a single unreachable domain is not a reason to stop.
      stats.unresolved++;
      console.log(`  ERROR      ${String(company.name).slice(0, 33).padEnd(33)} ${String(e).split("\n")[0]!.slice(0, 70)}`);
    }
  }
}));

console.log(`\n${"".padEnd(60, "-")}`);
console.log(`concurrency          ${concurrency}`);
console.log(`wall clock           ${((Date.now() - started) / 1000).toFixed(0)}s  (${((Date.now() - started) / 1000 / Math.max(1, due.length)).toFixed(1)}s per company)`);
console.log(`attempted            ${due.length}`);
console.log(`resolved directly    ${stats.direct}   (careers page named the board)`);
console.log(`resolved by guess    ${stats.fingerprint + stats.guess}   (${stats.fingerprint} with a provider fingerprint, ${stats.guess} blind)`);
console.log(`unresolved           ${stats.unresolved}   (stay DISCOVERED, retried after ${RETRY_AFTER_DAYS} days)`);
console.log(`provider breakdown   ${JSON.stringify(byProvider)}`);
console.log(`live board calls     ${stats.boardCalls}`);
console.log(`rejected as another company\u2019s board: ${stats.rejected}`);
console.log(`jobs behind the newly resolved boards: ${resolved.reduce((n, r) => n + r.jobCount, 0)}`);
if (!commit) console.log(`\n(dry run: nothing written, nothing activated)`);
