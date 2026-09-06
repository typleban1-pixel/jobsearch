#!/usr/bin/env -S node --env-file=.env.local
/**
 * SHADOW-MODE direct-ATS / remote discovery measurement.
 *
 * The standing discovery sources are company-first and Chicago-anchored
 * (Wikidata-Chicago, Wikidata-large-US, YC), so a US-remote employer whose
 * jobs this person could do never enters the universe unless it also happens
 * to be a large or Chicago company. This measures what a substance-first,
 * board-first source would add -- WITHOUT touching the live universe and
 * WITHOUT paying for a single LLM extraction.
 *
 * The candidate boards below were found by web-searching the ATS board hosts
 * (boards.greenhouse.io / jobs.lever.co / jobs.ashbyhq.com) for the target
 * SUBSTANCE (implementation, AI enablement/adoption, automation/workflow,
 * business/product operations, transformation, process improvement,
 * program/project where implementation is central) in Chicago + US-remote.
 * A productionized source would run those searches on a schedule; here the
 * discovered tokens are the input so the funnel can be measured cheaply.
 *
 * For each candidate board it: decides NEW vs already-in-universe (exact, by
 * unique(provider,token)); fetches the live public board (free); normalizes;
 * and runs the SAME gates the real pipeline uses -- isPlausibleJob (title)
 * and assessEligibility (Chicago / US-remote / salary floor). It flags likely
 * duplicates of the existing universe by (employer-name, normalized-title).
 * Nothing is written. Output is a JSON + human funnel with a projected (never
 * spent) extraction cost.
 *
 *   node --env-file=.env.local scripts/shadow-discovery.ts
 */
import { createClient } from "@supabase/supabase-js";
import { getProvider } from "../lib/ingest/providers/index.ts";
import { assessEligibility, PROPOSED_RULES } from "../lib/scoring/eligibility.ts";
import { isPlausibleJob } from "../lib/discovery/plausibleFilter.ts";

// Discovered via substance-restricted board-host search (see header).
const CANDIDATES: Record<string, string[]> = {
  GREENHOUSE: ["remotecom","hightouch","precisionaq","triplewhale","samsara","knowbe4","gitlab","loop","onbe","aevexaerospace","andurilindustries","spacex","doubleverify","gigaenergy","dropbox"],
  LEVER: ["levelai","appen-2","jobgether","loadsmart","outreach","wpromote","enablecomp","gohighlevel","crypto","zoox","bounteous","Xpansiv"],
  ASHBY: ["fiddler-ai","evenup","taktile","gainsight","ramp","meridianlink","typescouts","savvymoney","hopper"],
};
// Rough per-extraction cost for projecting (never spent here). Steady-state
// extraction is a single small LLM call per unique description hash.
const EST_COST_PER_EXTRACTION_USD = 0.012;
// Reposter / aggregator boards: they re-list many other employers' jobs, so
// their postings are neither this employer's nor cleanly attributable. A real
// source must exclude them; flagged here so they never inflate the headline.
const AGGREGATORS = new Set(["jobgether"]);
// A board so large that its plausible-but-UNCLEAR-location roles swamp the
// funnel (defense/aerospace megaboards). Reported separately, not as headline.
const MEGABOARD_MIN_POSTINGS = 800;

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const pg = async <T,>(t: string, c: string): Promise<T[]> => {
  const o: T[] = [];
  for (let x = 0; ; x += 1000) {
    const { data, error } = await db.from(t).select(c).range(x, x + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    o.push(...(data as T[])); if (!data || data.length < 1000) break;
  }
  return o;
};
const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ---- existing universe -------------------------------------------------
const companies = await pg<any>("companies", "id,name,ats_provider,ats_token");
const jobs = await pg<any>("jobs", "id,company_id,title,status");
const tokenSeen = new Set(companies.map((c) => `${c.ats_provider}:${(c.ats_token ?? "").toLowerCase()}`));
const companyNameById = new Map(companies.map((c) => [c.id, c.name]));
const universeOpenings = new Set<string>();          // employerNorm::titleNorm
for (const j of jobs) {
  if (j.status && j.status !== "OPEN") continue;
  const cn = norm(companyNameById.get(j.company_id) ?? "");
  if (cn) universeOpenings.add(`${cn}::${norm(j.title)}`);
}

// best-effort employer name for a board (Greenhouse exposes it cheaply)
async function boardName(provider: string, token: string): Promise<string> {
  if (provider === "GREENHOUSE") {
    try {
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}`);
      if (r.ok) { const j: any = await r.json(); if (j?.name) return j.name; }
    } catch { /* fall through */ }
  }
  return token;
}

type Row = {
  provider: string; token: string; employer: string; isNew: boolean;
  aggregator: boolean; megaboard: boolean;
  fetched: boolean; postings: number; plausible: number;
  eligible: number; eligibleRemote: number; eligibleChicago: number;
  uncertain: number;                // plausible AND UNCERTAIN location
  relevant: number;                 // plausible AND (eligible or uncertain)
  dupVsUniverse: number; netNew: number; netNewConfirmed: number;
  sampleNetNew: string[];
};

const rows: Row[] = [];
for (const [provider, tokens] of Object.entries(CANDIDATES)) {
  const prov = getProvider(provider);
  for (const token of tokens) {
    const isNew = !tokenSeen.has(`${provider}:${token.toLowerCase()}`);
    const employer = await boardName(provider, token);
    const row: Row = { provider, token, employer, isNew, aggregator: AGGREGATORS.has(token.toLowerCase()), megaboard: false, fetched: false, postings: 0, plausible: 0, eligible: 0, eligibleRemote: 0, eligibleChicago: 0, uncertain: 0, relevant: 0, dupVsUniverse: 0, netNew: 0, netNewConfirmed: 0, sampleNetNew: [] };
    try {
      const res = await prov.fetchBoard(token);
      row.fetched = res.ok;
      if (res.ok) {
        row.postings = res.postings.length;
        row.megaboard = res.postings.length >= MEGABOARD_MIN_POSTINGS;
        const empNorm = norm(employer);
        for (const rp of res.postings) {
          let nj: any;
          try { nj = prov.normalize(rp); } catch { continue; }
          const plausible = isPlausibleJob({ title: nj.title, seniority: nj.seniority, isIC: nj.isIndividualContributor }).plausible;
          if (!plausible) continue;
          row.plausible++;
          const e = assessEligibility({
            salaryMin: nj.salaryMin, salaryMax: nj.salaryMax, salaryPeriod: nj.salaryPeriod,
            city: nj.city, state: nj.state, country: nj.country, metro: nj.metro,
            remotePolicy: nj.remotePolicy, remoteRestriction: nj.remoteRestriction, locationRaw: nj.locationRaw,
          }, PROPOSED_RULES);
          const verdict = (e as any).status;
          const ok = verdict === "ELIGIBLE" || verdict === "UNCERTAIN";
          if (!ok) continue;
          row.relevant++;
          const confirmed = verdict === "ELIGIBLE";
          if (confirmed) {
            row.eligible++;
            if (nj.metro === "Chicagoland" || ["IL","IN"].includes(nj.state ?? "")) row.eligibleChicago++;
            else row.eligibleRemote++;
          } else row.uncertain++;
          const dup = empNorm ? universeOpenings.has(`${empNorm}::${norm(nj.title)}`) : false;
          if (dup) row.dupVsUniverse++;
          else {
            row.netNew++;
            if (confirmed) row.netNewConfirmed++;
            if (confirmed && row.sampleNetNew.length < 4) row.sampleNetNew.push(`${nj.title} [${nj.remotePolicy}${nj.metro ? "/" + nj.metro : ""}]`);
          }
        }
      }
    } catch (err) { row.fetched = false; }
    rows.push(row);
    process.stderr.write(`  ${row.isNew ? "NEW " : "known"} ${provider.padEnd(10)} ${token.padEnd(18)} ${row.fetched ? row.postings + " postings, " + row.relevant + " relevant, " + row.netNew + " net-new" : "FETCH FAILED"}\n`);
  }
}

// ---- aggregate ---------------------------------------------------------
const sum = (f: (r: Row) => number, pred: (r: Row) => boolean = () => true) => rows.filter(pred).reduce((a, r) => a + f(r), 0);
const newRows = rows.filter((r) => r.isNew && r.fetched);
// The clean set: new boards that are neither reposting aggregators nor
// UNCLEAR-swamped megaboards. This is what a tuned source would actually feed.
const clean = (r: Row) => r.isNew && r.fetched && !r.aggregator && !r.megaboard;
const agg = {
  candidateBoards: rows.length,
  fetchedOk: rows.filter((r) => r.fetched).length,
  fetchFailed: rows.filter((r) => !r.fetched).length,
  newBoards: rows.filter((r) => r.isNew).length,
  knownBoards: rows.filter((r) => !r.isNew).length,
  newEmployers: new Set(newRows.map((r) => norm(r.employer))).size,
  excludedAggregators: rows.filter((r) => r.isNew && r.aggregator).map((r) => `${r.token}(${r.postings})`),
  excludedMegaboards: rows.filter((r) => r.isNew && r.megaboard).map((r) => `${r.employer}(${r.postings})`),
  RAW: {
    newBoardPostings: sum((r) => r.postings, (r) => r.isNew),
    newBoardPlausible: sum((r) => r.plausible, (r) => r.isNew),
    newBoardRelevantInclUncertain: sum((r) => r.relevant, (r) => r.isNew),
  },
  CLEAN: {
    boards: rows.filter(clean).length,
    postings: sum((r) => r.postings, clean),
    plausible: sum((r) => r.plausible, clean),
    confirmedEligible: sum((r) => r.eligible, clean),
    confirmedRemote: sum((r) => r.eligibleRemote, clean),
    confirmedChicago: sum((r) => r.eligibleChicago, clean),
    uncertainLocation: sum((r) => r.uncertain, clean),
    netNewConfirmed: sum((r) => r.netNewConfirmed, clean),
    providerDist: Object.fromEntries(Object.keys(CANDIDATES).map((p) => [p, sum((r) => r.netNewConfirmed, (r) => clean(r) && r.provider === p)])),
    // Cost to extract only the CONFIRMED-eligible net-new from clean boards.
    projectedExtractionCostUsd: +(sum((r) => r.netNewConfirmed, clean) * EST_COST_PER_EXTRACTION_USD).toFixed(2),
  },
};

console.log("\n" + "=".repeat(66));
console.log("SHADOW DIRECT-ATS / REMOTE DISCOVERY  (measure only; nothing written)");
console.log("=".repeat(66));
console.log(JSON.stringify(agg, null, 2));
console.log("\nCLEAN new boards (non-aggregator, non-megaboard) by confirmed net-new:");
for (const r of rows.filter(clean).filter((r) => r.netNewConfirmed > 0).sort((a, b) => b.netNewConfirmed - a.netNewConfirmed)) {
  console.log(`  ${r.provider.padEnd(10)} ${r.employer.slice(0, 22).padEnd(24)} confirmed net-new ${String(r.netNewConfirmed).padStart(3)}  (of ${r.postings} postings; +${r.uncertain} uncertain-loc)`);
  for (const s of r.sampleNetNew) console.log(`             · ${s.slice(0, 74)}`);
}
console.log("\nCandidate boards ALREADY in the universe (no expansion value):");
console.log("  " + rows.filter((r) => !r.isNew).map((r) => `${r.provider}:${r.token}`).join(", "));
console.log("\nCaveats: applicant counts NOT measured (no evidence collected); aggregator");
console.log("presence NOT measured; duplicate detection is heuristic (employer-name +");
console.log("normalized-title), so net-new is an upper bound. Extraction cost is PROJECTED.");
