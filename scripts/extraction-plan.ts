/**
 * The pre-flight report for bulk extraction: what would be sent, how big
 * it is, and what it would cost. Reads only. Sends nothing anywhere.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const page = async (t: string, cols: string, extra: (q: any) => any = (q) => q) => {
  const out: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await extra(db.from(t).select(cols)).order("job_id", { ascending: true }).range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...data); if (data.length < 1000) break;
  }
  return out;
};

const jobs: any[] = [];
for (let f = 0; ; f += 1000) {
  const { data, error } = await db.from("jobs")
    .select("id,eligibility,status,extracted_at").eq("status", "OPEN")
    .order("id", { ascending: true }).range(f, f + 999);
  if (error) throw new Error(error.message);
  jobs.push(...data); if (data.length < 1000) break;
}
const eligibleIds = new Set(jobs.filter((j) => j.eligibility === "ELIGIBLE" || j.eligibility === "UNCERTAIN").map((j) => j.id));

const descs = await page("job_descriptions", "job_id,description_text");
let chars = 0, counted = 0, maxChars = 0;
for (const d of descs) {
  if (!eligibleIds.has(d.job_id)) continue;
  const n = (d.description_text ?? "").length;
  chars += n; counted++; if (n > maxChars) maxChars = n;
}

// ~4 characters per token is the standard rough figure for English prose.
const inputTokens = Math.round(chars / 4);
const promptOverhead = counted * 400;      // instructions and schema per call
const outputTokens = counted * 350;        // structured requirement list
const totalIn = inputTokens + promptOverhead;

console.log("extraction pre-flight\n");
console.log(`  open jobs                    ${jobs.length}`);
console.log(`  eligible + uncertain         ${eligibleIds.size}`);
console.log(`  with a description stored    ${counted}`);
console.log(`  already extracted            ${jobs.filter((j) => j.extracted_at).length}`);
console.log(`\n  description characters       ${chars.toLocaleString()}`);
console.log(`  average per job              ${counted ? Math.round(chars / counted).toLocaleString() : 0}`);
console.log(`  largest single description   ${maxChars.toLocaleString()}`);
console.log(`\n  estimated input tokens       ${totalIn.toLocaleString()}  (${inputTokens.toLocaleString()} text + ${promptOverhead.toLocaleString()} prompt overhead)`);
console.log(`  estimated output tokens      ${outputTokens.toLocaleString()}`);
console.log(`\n  NOTE: estimates only. No request has been sent and no key has been used.`);
