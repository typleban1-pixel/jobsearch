/**
 * Sweeps discovery sources and records companies as DISCOVERED.
 *
 * Finds NAMES. Resolves nothing, verifies nothing, activates nothing:
 * scripts/resolve-ats.ts does that, and keeping the two apart is what
 * stops a wrong guess from looking like a company that does not exist.
 *
 *   node scripts/discover.ts            report only
 *   node scripts/discover.ts --commit   write companies and source rows
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { ycombinator } from "../lib/discovery/sources/ycombinator.ts";
import { wikidataChicago, wikidataLargeUs } from "../lib/discovery/sources/wikidata.ts";
import type { DiscoverySource } from "../lib/discovery/types.ts";

const commit = process.argv.includes("--commit");
const maxPages = Number(process.argv.find((a) => a.startsWith("--pages="))?.split("=")[1] ?? 20);
const startPage = Number(process.argv.find((a) => a.startsWith("--from="))?.split("=")[1] ?? 1);
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

// Chicago first, because that is the market and it was entirely absent.
// Large US employers second: a company headquartered anywhere with tens
// of thousands of staff very likely has Chicago openings, and is exactly
// the cohort running the ATSs we cannot yet read.
const ALL: Record<string, DiscoverySource> = {
  "wikidata-chicago": wikidataChicago,
  "wikidata-large-us": wikidataLargeUs,
  ycombinator,
};
const only = process.argv.find((a) => a.startsWith("--source="))?.split("=")[1];
const SOURCES: DiscoverySource[] = only
  ? [ALL[only] ?? (() => { throw new Error(`no source "${only}". Have: ${Object.keys(ALL).join(", ")}`); })()]
  : Object.values(ALL);

const page = async (t: string, c: string) => {
  const o: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from(t).select(c).order("id").range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break;
  } return o;
};

const existing = await page("companies", "id,name,domain,ats_provider,ats_token");
const byDomain = new Map(existing.filter((c: any) => c.domain).map((c: any) => [c.domain.toLowerCase(), c]));
const byName = new Map(existing.map((c: any) => [c.name.toLowerCase().trim(), c]));
console.log(`already known: ${existing.length} companies (${byDomain.size} with a domain)\n`);

let totalFound = 0, totalNew = 0;
for (const source of SOURCES) {
  console.log(`${source.label}`);
  console.log(`  ${source.coverage}`);
  const { companies, pagesFetched, warnings } = await source.fetch({ maxPages, startPage });
  totalFound += companies.length;
  for (const w of warnings.slice(0, 5)) console.log(`  warning: ${w}`);

  // Dedup on domain first, name second. Two directories naming the same
  // employer differently resolve to one company through the domain.
  const fresh = companies.filter((c) =>
    !(c.domain && byDomain.has(c.domain)) && !byName.has(c.name.toLowerCase().trim()));
  totalNew += fresh.length;
  console.log(`  fetched ${companies.length} companies over ${pagesFetched} pages, ${fresh.length} not already known`);

  const byPriority: Record<string, number> = {};
  for (const c of fresh) {
    const b = c.priorityScore >= 80 ? "80+ target region" : c.priorityScore >= 60 ? "60 US or remote" : "35 elsewhere";
    byPriority[b] = (byPriority[b] ?? 0) + 1;
  }
  console.log(`  by priority: ${JSON.stringify(byPriority)}`);

  if (!commit) { console.log("  (dry run, nothing written)\n"); continue; }

  const { data: srcRow, error: srcErr } = await db.from("company_sources").upsert({
    label: source.label, method: source.method,
    config: { maxPages, startPage }, enabled: true,
    last_run_at: new Date().toISOString(),
    companies_found: companies.length, companies_added: fresh.length,
    notes: source.coverage,
  }, { onConflict: "label" }).select("id").single();
  if (srcErr) throw new Error(`company_sources: ${srcErr.message}`);

  // One row per domain, within this batch as well as against the corpus.
  // A directory can list a parent and two subsidiaries all pointing at the
  // same website, and the domain is unique, so the batch has to be
  // deduped before it is written rather than after the insert fails.
  const seenInBatch = new Set<string>();
  const writable = fresh.filter((c) => {
    const d = (c.domain ?? "").toLowerCase();
    if (!d || seenInBatch.has(d)) return false;
    seenInBatch.add(d);
    return true;
  });
  if (writable.length !== fresh.length) {
    console.log(`  ${fresh.length - writable.length} share a domain with another entry in this batch; kept the first of each`);
  }

  for (let i = 0; i < writable.length; i += 200) {
    const slice = writable.slice(i, i + 200).map((c) => ({
      name: c.name, domain: c.domain,
      ats_provider: "UNKNOWN", lifecycle: "DISCOVERED",
      discovery_method: c.method, discovery_source: c.sourceLabel, discovery_source_url: c.sourceUrl,
      industries: c.industries, priority_score: c.priorityScore, priority_reason: c.priorityReason,
      current_size_min: c.sizeMin, current_size_max: c.sizeMax,
      notes: c.notes,
    }));
    const { error } = await db.from("companies").insert(slice);
    if (error) throw new Error(`companies insert at ${i}: ${error.message}`);
    // Keep the in-run dedup maps honest for later sources.
    for (const c of writable.slice(i, i + 200)) {
      if (c.domain) byDomain.set(c.domain, c);
      byName.set(c.name.toLowerCase().trim(), c);
    }
  }
  console.log(`  wrote ${writable.length} companies as DISCOVERED, source row ${srcRow.id}\n`);
}

console.log(`total: ${totalFound} fetched, ${totalNew} new${commit ? " and written" : " (dry run)"}`);
