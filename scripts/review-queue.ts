/**
 * Builds the re-extraction review queue.
 *
 * Deliberately narrow. Re-extracting 1,471 postings to fix a failure mode
 * that affects a handful would cost another $17 and discard 19,723 good
 * requirements, so this identifies only postings whose extraction looks
 * thin against what the posting visibly contains.
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });
const pg = async (t: string, c: string) => {
  const o: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from(t).select(c).order("id", { ascending: true }).range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    o.push(...data); if (data.length < 1000) break;
  }
  return o;
};

const jobs = (await pg("jobs", "id,title,company_id,extracted_at,eligibility")).filter((j: any) => j.extracted_at);
const reqs = await pg("job_requirements", "job_id");
const cos = await pg("companies", "id,name");
const cn = new Map(cos.map((c: any) => [c.id, c.name]));
const count = new Map<string, number>();
for (const r of reqs) count.set(r.job_id, (count.get(r.job_id) ?? 0) + 1);

const ids = jobs.map((j: any) => j.id);
const desc = new Map<string, string>();
for (let i = 0; i < ids.length; i += 100) {
  const { data } = await db.from("job_descriptions").select("job_id,description_text").in("job_id", ids.slice(i, i + 100));
  for (const d of data ?? []) desc.set(d.job_id, d.description_text ?? "");
}

// Headers that introduce a requirements section, including the prose
// forms that caused the miss.
const REQ_SECTION = /\b(minimum requirements|basic qualifications|qualifications|requirements|who you are|what you'?ll bring|what you bring|about you|the ideal candidate|we'?re looking for|you'?ll need|skills? (?:and|&) experience|experience (?:you|we))\b/i;

const rows = jobs.map((j: any) => {
  const text = desc.get(j.id) ?? "";
  const n = count.get(j.id) ?? 0;
  return { j, n, len: text.length, density: text.length ? n / (text.length / 1000) : 0, hasSection: REQ_SECTION.test(text) };
});
const scored = rows.filter((r) => r.len > 1500);
const mean = scored.reduce((a, r) => a + r.density, 0) / scored.length;

const flagged = scored.filter((r) =>
  r.n === 0 ||
  r.density < mean * 0.25 ||
  (r.hasSection && r.density < mean * 0.5));

console.log(`extracted postings over 1,500 chars: ${scored.length}`);
console.log(`mean density: ${mean.toFixed(2)} requirements per 1,000 chars\n`);
console.log(`review queue: ${flagged.length}  (${((flagged.length * 100) / scored.length).toFixed(1)}%)`);
console.log(`  zero requirements:            ${flagged.filter((r) => r.n === 0).length}`);
console.log(`  under 25% of mean density:    ${flagged.filter((r) => r.n > 0 && r.density < mean * 0.25).length}`);
console.log(`  requirements section present but under 50% density: ${flagged.filter((r) => r.n > 0 && r.density >= mean * 0.25 && r.hasSection).length}`);

console.log(`\nqueue:`);
for (const r of flagged.sort((a, b) => a.density - b.density).slice(0, 30)) {
  console.log(`  ${String(r.n).padStart(3)} reqs / ${String(r.len).padStart(5)} ch  d=${r.density.toFixed(2)}  ${String(cn.get(r.j.company_id)).slice(0, 16).padEnd(17)} ${String(r.j.title).slice(0, 46)}`);
}
if (flagged.length > 30) console.log(`  ... and ${flagged.length - 30} more`);

writeFileSync("/tmp/review-queue.txt", flagged.map((r) => r.j.id).join("\n"));
console.log(`\nwrote ${flagged.length} job ids to /tmp/review-queue.txt`);
