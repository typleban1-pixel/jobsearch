/**
 * What a discovery pass actually bought.
 *
 *   node scripts/discovery-report.ts [--before=/path/to/before.json]
 *
 * The number that matters is not employers or boards; it is jobs in
 * Chicagoland or US-remote that reached eligibility. Everything else is
 * an input to that.
 *
 * It also isolates one specific question: how much of a pass came from
 * recognising a NEW ATS versus from checking NEW employers. Those get
 * mixed together in a headline resolve count, and they justify very
 * different follow-on work.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const beforePath = process.argv.find((a) => a.startsWith("--before="))?.split("=")[1];
/** When Workday detection landed. Attempts before this were made blind to it. */
const WORKDAY_SINCE = process.argv.find((a) => a.startsWith("--since="))?.split("=")[1]
  ?? "2026-09-01T16:00:00Z";
/** Window for "this pass". Two passes reported together describe neither. */
const PASS_FROM = process.argv.find((a) => a.startsWith("--pass-from="))?.split("=")[1] ?? WORKDAY_SINCE;
const PASS_TO = process.argv.find((a) => a.startsWith("--pass-to="))?.split("=")[1] ?? "9999";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const page = async <T,>(t: string, c: string): Promise<T[]> => {
  const o: T[] = [];
  for (let x = 0; ; x += 1000) {
    const { data, error } = await db.from(t).select(c).order("id").range(x, x + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    o.push(...((data ?? []) as T[])); if ((data ?? []).length < 1000) break;
  }
  return o;
};

const [companies, jobs, locations, candidacy, candidates] = await Promise.all([
  page<any>("companies", "id,name,domain,discovery_source,lifecycle,ats_provider,ats_token"),
  page<any>("jobs", "id,company_id,source,status,eligibility"),
  page<any>("job_locations", "id,job_id,metro,is_remote,remote_scope"),
  page<any>("job_candidacy", "id,job_id,verdict"),
  page<any>("company_token_candidates", "id,company_id,ats_provider,candidate_token,tested_at,confirmed"),
]);

const before = beforePath ? JSON.parse(readFileSync(beforePath, "utf8")) : null;
const n = (x: number | string, w = 7) => String(x).padStart(w);
const rule = (t: string) => console.log(`\n${t}\n${"-".repeat(t.length)}`);
const delta = (now: number, was: number | undefined) =>
  was === undefined ? "" : `  (${now - was >= 0 ? "+" : ""}${now - was})`;

// ---- the pass itself ---------------------------------------------------
const cutoff = WORKDAY_SINCE;
const attemptsThisPass = candidates.filter((c) => (c.tested_at ?? "") >= PASS_FROM && (c.tested_at ?? "") < PASS_TO);
const attemptedIds = new Set(attemptsThisPass.map((c) => c.company_id));
const confirmedThisPass = attemptsThisPass.filter((c) => c.confirmed);
const resolvedIds = new Set(confirmedThisPass.map((c) => c.company_id));

rule("This pass");
console.log(`  ${n(attemptedIds.size)}  employers attempted`);
console.log(`  ${n(resolvedIds.size)}  resolved`);
console.log(`  ${n(attemptedIds.size - resolvedIds.size)}  still unresolved`);
console.log(`  ${n(attemptsThisPass.filter((c) => !c.confirmed).length)}  candidate tokens tested and refused`);

const byProviderNew = new Map<string, number>();
for (const c of confirmedThisPass) byProviderNew.set(c.ats_provider, (byProviderNew.get(c.ats_provider) ?? 0) + 1);
console.log("\n  newly resolved by platform:");
for (const [k, v] of [...byProviderNew].sort((a, b) => b[1] - a[1])) console.log(`  ${n(v)}  ${k}`);

// ---- was reopening the old backlog worth it? ---------------------------
//
// A company counts as "previously dismissed" if it was attempted before
// Workday support existed and had no confirmed token at that point.
const attemptsBefore = new Map<string, { tried: boolean; confirmed: boolean }>();
for (const c of candidates) {
  if ((c.tested_at ?? "") >= cutoff) continue;
  const cur = attemptsBefore.get(c.company_id) ?? { tried: false, confirmed: false };
  cur.tried = true;
  if (c.confirmed) cur.confirmed = true;
  attemptsBefore.set(c.company_id, cur);
}
const previouslyDismissed = new Set(
  [...attemptsBefore].filter(([, v]) => v.tried && !v.confirmed).map(([id]) => id));

const rechecked = [...previouslyDismissed].filter((id) => attemptedIds.has(id));
const rescued = rechecked.filter((id) => resolvedIds.has(id));
const byCompany = new Map(companies.map((c) => [c.id, c]));
const rescuedWorkday = rescued.filter((id) => byCompany.get(id)?.ats_provider === "WORKDAY");

rule("Was reopening the old backlog worth it");
console.log(`  ${n(previouslyDismissed.size)}  employers previously attempted and left unresolved`);
console.log(`  ${n(rechecked.length)}  of those rechecked in this pass`);
console.log(`  ${n(rescued.length)}  previously unresolved -> now resolved`);
console.log(`  ${n(rescuedWorkday.length)}  previously unresolved -> now WORKDAY`);
if (rechecked.length) {
  console.log(`  ${n(`${((100 * rescued.length) / rechecked.length).toFixed(1)}%`)}  recheck yield`);
  console.log(`  ${n(`${((100 * rescuedWorkday.length) / Math.max(1, rescued.length)).toFixed(0)}%`)}  of rescues attributable to Workday recognition`);
}
const freshlyAttempted = [...attemptedIds].filter((id) => !previouslyDismissed.has(id));
const freshResolved = freshlyAttempted.filter((id) => resolvedIds.has(id));
console.log(`\n  for comparison, employers never checked before:`);
console.log(`  ${n(freshlyAttempted.length)}  attempted`);
console.log(`  ${n(freshResolved.length)}  resolved`);
if (freshlyAttempted.length) {
  console.log(`  ${n(`${((100 * freshResolved.length) / freshlyAttempted.length).toFixed(1)}%`)}  yield`);
}

// ---- population composition -------------------------------------------
//
// A single yield number hides which population produced it. The first
// pass after Workday support was skewed toward Y Combinator because
// size-knownness outranked priority score in the resolver's ordering,
// and reading its Chicago yield as representative would be wrong.
rule("Population attempted in this pass");
const population = (c: any): string => {
  const src = String(c?.discovery_source ?? "");
  if (src.includes("Combinator")) return "Y Combinator";
  if (src.includes("Chicago")) return "Wikidata Chicago";
  if (src.includes("large US")) return "Wikidata large US";
  return "other / hand-seeded";
};
const pop = new Map<string, { attempted: number; resolved: number; byProvider: Map<string, number> }>();
for (const id of attemptedIds) {
  const k = population(byCompany.get(id));
  const p = pop.get(k) ?? { attempted: 0, resolved: 0, byProvider: new Map() };
  p.attempted++;
  if (resolvedIds.has(id)) {
    p.resolved++;
    const prov = byCompany.get(id)?.ats_provider ?? "?";
    p.byProvider.set(prov, (p.byProvider.get(prov) ?? 0) + 1);
  }
  pop.set(k, p);
}
for (const [k, v] of [...pop].sort((a, b) => b[1].attempted - a[1].attempted)) {
  const rate = v.attempted ? `${((100 * v.resolved) / v.attempted).toFixed(1)}%` : "—";
  const providers = [...v.byProvider].sort((a, b) => b[1] - a[1]).map(([p, c]) => `${p} ${c}`).join(", ") || "none";
  console.log(`  ${n(v.attempted)} tried ${n(v.resolved)} resolved ${n(rate)}   ${k}`);
  console.log(`  ${" ".repeat(24)}${providers}`);
}

// ---- corpus ------------------------------------------------------------
const open = jobs.filter((j) => j.status === "OPEN");
const chicago = new Set<string>(), remoteUs = new Set<string>();
for (const l of locations) {
  if (l.metro === "Chicagoland") chicago.add(l.job_id);
  if (l.is_remote && ["US", "NORTH AMERICA"].includes(String(l.remote_scope ?? "").toUpperCase())) remoteUs.add(l.job_id);
}
const verdict = new Map(candidacy.map((c) => [c.job_id, c.verdict]));
const eligible = open.filter((j) => j.eligibility === "ELIGIBLE");

rule("Corpus");
console.log(`  ${n(open.length)}  open jobs${delta(open.length, before?.openJobs)}`);
console.log(`  ${n(chicago.size)}  Chicagoland`);
console.log(`  ${n(remoteUs.size)}  US-remote`);
console.log(`  ${n(eligible.length)}  eligible${delta(eligible.length, before?.eligible)}`);
const counts = { APPLICATION_CANDIDATE: 0, STRETCH: 0, REJECT: 0, MANUAL_REVIEW: 0 } as Record<string, number>;
for (const j of eligible) { const v = verdict.get(j.id); if (v) counts[v] = (counts[v] ?? 0) + 1; }
console.log(`  ${n(counts["APPLICATION_CANDIDATE"] ?? 0)}  APPLICATION_CANDIDATE${delta(counts["APPLICATION_CANDIDATE"] ?? 0, before?.candidate)}`);
console.log(`  ${n(counts["STRETCH"] ?? 0)}  STRETCH${delta(counts["STRETCH"] ?? 0, before?.stretch)}`);
console.log(`  ${n(counts["REJECT"] ?? 0)}  REJECT`);
console.log(`  ${n(eligible.filter((j) => !verdict.has(j.id)).length)}  eligible and not yet scored`);

rule("Boards by platform");
for (const p of ["GREENHOUSE", "LEVER", "ASHBY", "WORKDAY"]) {
  const boards = companies.filter((c) => c.ats_provider === p && c.ats_token).length;
  const mine = open.filter((j) => j.source === p);
  console.log(`  ${String(p).padEnd(12)}${n(boards)} boards${n(mine.length)} open${n(mine.filter((j) => chicago.has(j.id)).length)} chi${n(mine.filter((j) => remoteUs.has(j.id)).length)} remote`);
}
console.log(`  ${"(all)".padEnd(12)}${n(companies.filter((c) => c.ats_token).length)} boards${delta(companies.filter((c) => c.ats_token).length, before?.boards)}`);

// ---- yield by where the employer came from -----------------------------
rule("Resolution yield by discovery population");
const pops = new Map<string, { total: number; resolved: number; attempted: number }>();
for (const c of companies) {
  const k = c.discovery_source ?? "(hand-seeded)";
  const p = pops.get(k) ?? { total: 0, resolved: 0, attempted: 0 };
  p.total++;
  if (c.ats_token) p.resolved++;
  if (attemptsBefore.has(c.id) || attemptedIds.has(c.id)) p.attempted++;
  pops.set(k, p);
}
for (const [k, v] of [...pops].sort((a, b) => b[1].total - a[1].total).slice(0, 6)) {
  const rate = v.attempted ? `${((100 * v.resolved) / v.attempted).toFixed(1)}%` : "—";
  console.log(`  ${n(v.total)} known ${n(v.attempted)} tried ${n(v.resolved)} resolved ${n(rate, 7)}  ${k.slice(0, 44)}`);
}

// ---- company identity duplicates ---------------------------------------
rule("Company identity duplicates");
const byToken = new Map<string, any[]>();
for (const c of companies) {
  if (!c.ats_token) continue;
  const key = `${c.ats_provider}:${String(c.ats_token).toLowerCase()}`;
  byToken.set(key, [...(byToken.get(key) ?? []), c]);
}
const collisions = [...byToken].filter(([, v]) => v.length > 1);
console.log(`  ${n(collisions.length)}  distinct boards claimed by more than one company row`);
for (const [key, v] of collisions.slice(0, 8)) {
  console.log(`     ${key.slice(0, 56)}`);
  for (const c of v) console.log(`        ${String(c.name).slice(0, 34).padEnd(36)} ${c.domain}`);
}

rule("Backlog");
console.log(`  ${n(companies.filter((c) => c.lifecycle === "DISCOVERED").length)}  employers still unresolved${delta(companies.filter((c) => c.lifecycle === "DISCOVERED").length, before?.discovered)}`);
console.log("");
