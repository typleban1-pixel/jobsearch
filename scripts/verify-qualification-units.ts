/**
 * One qualification demand, at most one qualification unit.
 *
 * Asserted in both directions, because a rule that only prevents credit
 * is satisfied by a system that credits nothing. A posting sentence that
 * IS met must contribute exactly one satisfied unit, and one that is NOT
 * met must contribute exactly one unmet unit.
 *
 * The demand is identified by the sentence it came from. Two education
 * concepts tracing to the same raw_text are two units for one demand,
 * and that is a defect unless they genuinely differ in what they ask
 * for: a different level or a different hardness makes them separate
 * demands the extractor happened to pull from one sentence.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

async function paged<T>(table: string, cols: string, f: (q: any) => any = (q) => q, order = "id"): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(db.from(table).select(cols)).order(order).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as T[]));
    if ((data as T[]).length < 1000) break;
  }
  return out;
}

const scores = await paged<any>("job_scores", "job_id,fit_breakdown", (q) => q.eq("is_current", true), "job_id");
const jobIds = scores.map((s) => s.job_id);

const reqRaw = new Map<string, string>();
for (let i = 0; i < jobIds.length; i += 100) {
  const rows = await paged<any>("job_requirements", "id,raw_text", (q) => q.in("job_id", jobIds.slice(i, i + 100)));
  for (const r of rows) reqRaw.set(r.id, r.raw_text ?? "");
}

let jobs = 0, demands = 0, satisfied = 0, unsatisfied = 0, mergedDemands = 0;
const violations: string[] = [];

for (const s of scores) {
  const detail: any[] = s.fit_breakdown?.conceptDetail ?? [];
  const quals = detail.filter((c) => c.requirementClass === "EDUCATION" || c.requirementClass === "GATING_CREDENTIAL");
  if (!quals.length) continue;
  jobs++;

  // One bucket per (sentence, level, hardness): the identity of a demand.
  const buckets = new Map<string, any[]>();
  for (const c of quals) {
    const raws = [...new Set((c.requirementIds ?? []).map((id: string) => reqRaw.get(id) ?? ""))];
    if ((c.requirementIds ?? []).length > 1) mergedDemands++;
    for (const raw of raws) {
      const key = `${raw}␟${c.educationLevel ?? ""}␟${c.hardness ?? ""}`;
      buckets.set(key, [...(buckets.get(key) ?? []), c]);
    }
  }

  for (const [key, members] of buckets) {
    demands++;
    const anyCredited = members.some((m) => m.resolution === "DIRECT" || m.resolution === "TRANSFERABLE");
    if (anyCredited) satisfied++; else unsatisfied++;
    if (members.length > 1) {
      const [raw] = key.split("␟");
      violations.push(
        `  job ${s.job_id}\n    one sentence produced ${members.length} qualification units at the same level and hardness\n` +
        `    sentence: ${String(raw).slice(0, 110)}\n` +
        members.map((m) => `      ${m.resolution} :: ${m.label}`).join("\n"),
      );
    }
  }
}

console.log(`jobs carrying a qualification requirement: ${jobs}`);
console.log(`distinct qualification demands:            ${demands}`);
console.log(`  satisfied (one unit each):               ${satisfied}`);
console.log(`  unsatisfied (one unit each):             ${unsatisfied}`);
console.log(`demands assembled from several extracted rows: ${mergedDemands}`);

if (violations.length) {
  console.log(`\n${violations.length} demands contributed more than one unit:`);
  for (const v of violations.slice(0, 10)) console.log(v);
  process.exit(1);
}
console.log("\nno qualification demand contributes more than one unit, satisfied or unsatisfied");
