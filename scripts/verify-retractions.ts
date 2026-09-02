/**
 * Asks one question: can either retracted LCCC claim still be reached
 * from the LIVE profile?
 *
 * Not by string search, which is what produced a false clean the first
 * time. Every live positive statement a generator could read is run
 * through the claim guards themselves, so the test and the enforcement
 * are the same code.
 *
 * Guardrail text is exempt by design: a row whose job is to say "never
 * claim X" necessarily contains X.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { checkClaims } from "../lib/render/claimGuards.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const RETRACTED = new Set(["LCCC internship program", "LCCC program creation", "regional television commercials"]);
/** A statement that forbids a claim is not a statement making it. */
const IS_GUARDRAIL = /\b(?:must never|never be described|must not be|do not claim|not accurate|is not what|retracted|prohibited)\b/i;

interface Surface { table: string; id: string; text: string; note: string }
const surfaces: Surface[] = [];

const { data: ev } = await db.from("evidence").select("id,summary,detail,polarity");
for (const e of ev ?? []) {
  if (e.polarity !== "POSITIVE") continue;
  surfaces.push({ table: "evidence.summary", id: e.id, text: e.summary, note: `polarity=${e.polarity}` });
  if (e.detail) surfaces.push({ table: "evidence.detail", id: e.id, text: e.detail, note: `polarity=${e.polarity}` });
}
const { data: emp } = await db.from("employment_records").select("id,employer,actual_title,display_title,status,responsibilities,accomplishments");
for (const r of emp ?? []) {
  if (r.status !== "VERIFIED") continue;
  for (const s of [...(r.responsibilities ?? []), ...(r.accomplishments ?? [])])
    surfaces.push({ table: "employment_records", id: r.id, text: s, note: `${r.employer} / ${r.actual_title}` });
}
const { data: pj } = await db.from("projects").select("id,name,status,description");
for (const p of pj ?? []) {
  if (p.status !== "VERIFIED") continue;
  surfaces.push({ table: "projects", id: p.id, text: `${p.name}. ${p.description ?? ""}`, note: p.name });
}
const { data: mt } = await db.from("metrics").select("id,label,approved_wording,approved_for_use");
for (const m of mt ?? []) {
  if (!m.approved_for_use) continue;
  surfaces.push({ table: "metrics", id: m.id, text: `${m.label}. ${m.approved_wording}`, note: "approved" });
}
const { data: qb } = await db.from("question_bank").select("id,question,approved_answer");
for (const q of qb ?? []) {
  if (!q.approved_answer) continue;
  surfaces.push({ table: "question_bank", id: q.id, text: q.approved_answer, note: (q.question ?? "").slice(0, 40) });
}

console.log(`live positive statements checked: ${surfaces.length}\n`);
let reachable = 0, guardrail = 0;
for (const s of surfaces) {
  const hits = checkClaims(s.text).filter((h) => RETRACTED.has(h.subject));
  if (!hits.length) continue;
  if (IS_GUARDRAIL.test(s.text)) {
    guardrail++;
    console.log(`  GUARDRAIL  ${s.table} ${s.id.slice(0, 8)} — states the prohibition, does not make the claim`);
    continue;
  }
  reachable++;
  console.log(`  REACHABLE  ${s.table} ${s.id.slice(0, 8)} (${s.note})`);
  for (const h of hits) console.log(`      [${h.subject}] matched "${h.matched}"`);
  console.log(`      text: ${s.text.slice(0, 180)}`);
}
console.log(`\nguardrail rows (expected, allowed): ${guardrail}`);
console.log(`reachable retracted claims:         ${reachable}`);
console.log(reachable === 0 ? "\nPASS — neither retracted claim is reachable from the live profile."
                            : "\nFAIL — a retracted claim is still reachable.");
process.exit(reachable === 0 ? 0 : 1);
