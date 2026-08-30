/**
 * Miss-rate instrumentation.
 *
 * The number that decides whether pgvector is worth adding. Runs against
 * real extracted requirements; until extraction has run there are none,
 * so it also reports a corpus vocabulary probe as a standing baseline.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { TermMatcher, summarizeMisses, type MatchResult } from "../lib/matching/match.ts";
import { normalizeTerm } from "../lib/matching/normalize.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const { data: aliases } = await db.from("term_aliases").select("alias,canonical_term");
const { data: skills } = await db.from("skills")
  .select("id,name,related_terms").eq("status", "VERIFIED");

const matcher = new TermMatcher(
  (skills ?? []).map((s: any) => ({ id: s.id, name: s.name, relatedTerms: s.related_terms ?? [] })),
  (aliases ?? []) as any,
);

const stats = matcher.stats();
console.log("term matcher");
console.log(`  verified skills          ${(skills ?? []).length}`);
console.log(`  exact keys               ${stats.exactKeys}`);
console.log(`  related-term keys        ${stats.relatedKeys}`);
console.log(`  alias keys               ${stats.aliasKeys}`);

const reqs: any[] = [];
for (let f = 0; ; f += 1000) {
  const { data, error } = await db.from("job_requirements")
    .select("id,normalized_term,raw_text,is_hard_requirement")
    .order("id", { ascending: true }).range(f, f + 999);
  if (error) throw new Error(error.message);
  reqs.push(...data); if (data.length < 1000) break;
}

console.log(`\nextracted requirements   ${reqs.length}`);
if (reqs.length === 0) {
  console.log("  no requirements extracted yet, so the real miss rate is not measurable.");
  console.log("  Instrumentation is wired and will report the moment extraction runs.\n");
} else {
  const results: MatchResult[] = reqs.map((r) => matcher.match(r.normalized_term ?? r.raw_text));
  const rep = summarizeMisses(results);
  console.log(`  EXACT ${rep.byMethod.EXACT}  ALIAS ${rep.byMethod.ALIAS}  RELATED_TERM ${rep.byMethod.RELATED_TERM}  NONE ${rep.byMethod.NONE}`);
  console.log(`  miss rate: ${(rep.missRate * 100).toFixed(1)}%`);
  console.log(`\n  most frequent misses (alias candidates or genuine skill gaps):`);
  for (const m of rep.topMisses) console.log(`    ${String(m.count).padStart(4)}  ${m.term}`);
}

// Standing baseline: how far the seeded vocabulary reaches into the real
// corpus. Not a miss rate. It says how much of what the postings talk
// about the alias table can currently name at all.
const descs: any[] = [];
for (let f = 0; ; f += 1000) {
  const { data, error } = await db.from("job_descriptions")
    .select("job_id,description_text").order("job_id", { ascending: true }).range(f, f + 999);
  if (error) throw new Error(error.message);
  descs.push(...data); if (data.length < 1000) break;
}
const vocab = new Set<string>();
for (const a of aliases ?? []) { vocab.add(a.alias); vocab.add(a.canonical_term); }
// Word boundaries, not substring containment. A naive includes() reported
// "rest" in 2,226 postings and "sem" in 1,187, which are "interest" and
// "assembly". The matcher itself is unaffected: it looks terms up in a map
// of normalized forms and never scans free text. This is a probe bug, and
// it is the kind that reads as a finding if left alone.
const boundary = new Map<string, RegExp>();
for (const term of vocab) {
  if (term.length < 3) continue;
  boundary.set(term, new RegExp(`(?<![a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`));
}
const hits = new Map<string, number>();
for (const d of descs) {
  const text = normalizeTerm(d.description_text ?? "");
  for (const [term, re] of boundary) {
    if (re.test(text)) hits.set(term, (hits.get(term) ?? 0) + 1);
  }
}
const covered = [...hits.entries()].sort((a, b) => b[1] - a[1]);
console.log(`corpus vocabulary probe over ${descs.length} descriptions`);
console.log(`  seeded terms appearing at least once: ${covered.length} of ${vocab.size}`);
console.log(`  top terms by number of postings mentioning them:`);
for (const [t, n] of covered.slice(0, 15)) {
  console.log(`    ${String(n).padStart(5)}  ${t}`);
}
const unused = [...vocab].filter((t) => !hits.has(t) && t.length >= 3);
console.log(`  seeded terms never appearing: ${unused.length}${unused.length ? ` (${unused.slice(0, 10).join(", ")})` : ""}`);
