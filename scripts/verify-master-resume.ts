/**
 * The master resume, judged by the same guards a tailored resume faces.
 *
 * Existing text gets no exemption. Two under-cited lines were found this
 * way: both read as true, both cited only a metric row while asserting
 * things only the employment record supported.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { checkGrounding } from "../lib/render/grounding.ts";
import { evidenceTextOf } from "../lib/render/evidenceText.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

async function paged<T>(table: string, cols: string, f: (q: any) => any, order = "id"): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(db.from(table).select(cols)).order(order).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

const { data: masters, error: mErr } = await db.from("resumes").select("id,label").eq("is_master", true);
if (mErr) throw new Error(mErr.message);
if (masters?.length !== 1) throw new Error(`expected exactly one master resume, found ${masters?.length ?? 0}`);
const master = masters[0]!;
// The profile version is part of the label because resumes are pinned by
// the frozen rows their claims cite, not by a column.
const version = Number(master.label.match(/profile version (\d+)/)?.[1]);
if (!Number.isFinite(version)) throw new Error(`cannot read profile version from label: ${master.label}`);
const claims = await paged<any>("resume_claims", "claim,evidence_ids", (q) => q.eq("resume_id", master.id));
const rows = await paged<any>("profile_version_rows", "row_id,source_table,row_data", (q) => q.eq("profile_version", version), "row_id");

const text = new Map<string, string>();
for (const r of rows) {
  const t = evidenceTextOf(r.source_table, r.row_data);
  if (t) text.set(r.row_id, t);
}
const metrics = rows.filter((r) => r.source_table === "metrics").map((r) => r.row_data.approved_wording as string);
const entities = [
  ...rows.filter((r) => r.source_table === "employment_records").map((r) => r.row_data.employer),
  ...rows.filter((r) => r.source_table === "education").map((r) => r.row_data.institution),
  ...rows.filter((r) => r.source_table === "skills").map((r) => r.row_data.name),
  ...rows.filter((r) => r.source_table === "projects").map((r) => r.row_data.name),
  "Cleveland Clinic", "Amazon", "Sportsman Network", "Adobe Creative Suite", "Leavitt School of Health",
].filter(Boolean) as string[];

console.log(`${master.label}\n  profile version ${version}, ${claims.length} claims\n`);
let pass = 0;
const failures: string[] = [];
for (const c of claims) {
  const ids: string[] = c.evidence_ids ?? [];
  const src = ids.filter((i) => text.has(i)).map((i) => text.get(i)!).join(" ");
  const v = checkGrounding({ claim: c.claim, evidenceIds: ids, sourceText: src, approvedMetrics: metrics, knownEntities: entities });
  if (v.ok) pass++;
  else failures.push(`  [${v.failedCheck}] ${c.claim.slice(0, 90)}\n      ${v.failureDetail}`);
}
console.log(`${pass}/${claims.length} claims pass every grounding check`);
for (const f of failures) console.log(f);
if (failures.length) process.exit(1);
console.log("\nno unsupported employer-facing claim in the master resume");
