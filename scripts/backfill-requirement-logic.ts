/**
 * Records employer-authored alternatives on existing requirements.
 *
 *   node scripts/backfill-requirement-logic.ts            report only
 *   node scripts/backfill-requirement-logic.ts --write    persist
 *
 * Deterministic and free. No model is called and no posting is
 * re-extracted: the grouping is derived from the quoted text already
 * stored, by finding a requirement whose raw_text is a proper sub-span
 * of another's with an "or" before it. That is the exact shape
 * extraction produces when it splits an alternation, because it quotes
 * the whole sentence for the first alternative and the tail for the
 * second.
 *
 * IDEMPOTENT. A row that already carries a group is never rewritten, so
 * running this twice changes nothing the second time, and a grouping a
 * person confirmed by hand is never overwritten by the detector.
 *
 * CONSERVATIVE. It groups only what it can see in the text. An ordinary
 * "or" inside a single requirement forms no group, because nothing else
 * quotes a sub-span of it. Where the detector is unsure it does nothing,
 * which leaves today's behaviour in place rather than guessing at a
 * relationship the employer may not have written.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { detectAlternativeGroups } from "../lib/scoring/requirementLogic.ts";

const write = process.argv.includes("--write");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const page = async (t: string, c: string) => {
  const o: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from(t).select(c).order("id", { ascending: true }).range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    o.push(...data); if (data.length < 1000) break;
  }
  return o;
};

// Report mode works before the migration is applied, so the numbers can
// be reviewed before any schema change is made.
let rows: any[];
let schemaReady = true;
try {
  rows = await page("job_requirements",
    "id,job_id,raw_text,normalized_term,is_hard_requirement,alternative_group,alternative_source");
} catch (e) {
  if (!/alternative_group/.test((e as Error).message)) throw e;
  schemaReady = false;
  console.log("(migration 0079 is not applied yet: reporting only)\n");
  rows = (await page("job_requirements", "id,job_id,raw_text,normalized_term,is_hard_requirement"))
    .map((r: any) => ({ ...r, alternative_group: null, alternative_source: null }));
}

const already = rows.filter((r: any) => r.alternative_group).length;
console.log(`requirement rows: ${rows.length}`);
console.log(`already grouped: ${already}\n`);

const byJob = new Map<string, any[]>();
for (const r of rows) byJob.set(r.job_id, [...(byJob.get(r.job_id) ?? []), r]);

interface Planned { id: string; group: string; conjunct: string; jobId: string }
const planned: Planned[] = [];
let jobsTouched = 0;
let groupsFormed = 0;
let groupsWithMultipleHard = 0;
const samples: string[] = [];

for (const [jobId, reqs] of byJob) {
  const detected = detectAlternativeGroups(reqs.map((r: any) => ({ id: r.id, rawText: r.raw_text ?? "" })));
  if (!detected.size) continue;

  const groups = new Map<string, string[]>();
  for (const [id, g] of detected) groups.set(g, [...(groups.get(g) ?? []), id]);

  let touchedThisJob = false;
  for (const [g, members] of groups) {
    // A group of one is not an alternation.
    if (members.length < 2) continue;
    // Never overwrite an existing grouping, whoever set it.
    if (members.some((id) => reqs.find((r: any) => r.id === id)?.alternative_group)) continue;

    groupsFormed++;
    touchedThisJob = true;
    const hard = members.filter((id) => reqs.find((r: any) => r.id === id)?.is_hard_requirement === "HARD");
    if (hard.length > 1) groupsWithMultipleHard++;

    for (const id of members) {
      // Each detected member is its own alternative. The detector reads
      // "A or B" and cannot see a conjunction inside an alternative, so
      // it never invents one: every member gets a distinct conjunct key.
      // "A or (B and C)" needs a person or the model, and this leaves
      // that grouping to them rather than guessing.
      planned.push({ id, group: g, conjunct: id, jobId });
    }

    if (samples.length < 8) {
      const texts = members.map((id) => String(reqs.find((r: any) => r.id === id)?.raw_text ?? "").replace(/\s+/g, " "));
      samples.push(`  ${hard.length} HARD of ${members.length}\n     A: ${texts[0]?.slice(0, 118)}\n     B: ${texts[1]?.slice(0, 118)}`);
    }
  }
  if (touchedThisJob) jobsTouched++;
}

console.log(`groups the detector would form: ${groupsFormed}`);
console.log(`  of those, groups with more than one HARD member: ${groupsWithMultipleHard}`);
console.log(`rows to be updated: ${planned.length}`);
console.log(`jobs affected: ${jobsTouched}\n`);
console.log("samples:");
for (const s of samples) console.log(s);

// ---- the false-positive check, run every time -----------------------
//
// The failure this must never produce is grouping an ordinary "or"
// inside one requirement. Every grouped row is re-checked here: its text
// must genuinely be a sub-span relationship with another member, not
// merely a sentence containing the word.
console.log("\nfalse-positive check:");
const norm = (s: string) => String(s).replace(/\s+/g, " ").trim().toLowerCase();
let suspicious = 0;
const byGroup = new Map<string, Planned[]>();
for (const p of planned) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p]);
for (const [g, members] of byGroup) {
  const texts = members.map((m) => norm(rows.find((r: any) => r.id === m.id)?.raw_text ?? ""));
  const containment = texts.some((a) => texts.some((b) => a !== b && a.includes(b) && b.length >= 12));
  if (!containment) { suspicious++; console.log(`  SUSPICIOUS ${g}: no sub-span relationship`); }
}
console.log(`  groups without a genuine sub-span relationship: ${suspicious}`);
if (suspicious > 0) { console.error("\nrefusing to write: the detector produced a grouping it cannot justify"); process.exit(1); }

if (!schemaReady) { console.log("\nApply migration 0079 before writing."); process.exit(0); }
if (!write) { console.log("\nreport only. Pass --write to persist."); process.exit(0); }

let updated = 0;
for (const p of planned) {
  const { error } = await db.from("job_requirements").update({
    alternative_group: p.group,
    conjunct_key: p.conjunct,
    alternative_source: "DETERMINISTIC_TEXT",
  }).eq("id", p.id).is("alternative_group", null);   // idempotent: never overwrite
  if (error) { console.log(`  ${p.id}: ${error.message}`); continue; }
  updated++;
}
console.log(`\nupdated ${updated} row(s) across ${jobsTouched} job(s).`);
console.log("Employer source text was not modified.");
