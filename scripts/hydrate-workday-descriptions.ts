/**
 * Fetches the description for Workday postings that have none.
 *
 * The Workday list endpoint returns titles, locations and paths but no
 * description text; the provider records that gap as a warning and moves
 * on ("the listing carries no description; it needs a per-job fetch").
 * Nothing ever made that second call, so every Workday posting reached
 * candidacy with no requirements to compare against.
 *
 * One extra GET per posting against the same public CXS endpoint the
 * listing came from. Descriptions only: this writes job_descriptions and
 * touches no verdict, score or status.
 *
 *   node scripts/hydrate-workday-descriptions.ts            report only
 *   node scripts/hydrate-workday-descriptions.ts --write    persist
 *   node scripts/hydrate-workday-descriptions.ts --limit N  cap the run
 *   node scripts/hydrate-workday-descriptions.ts --all      ineligible too
 *
 * Defaults to ELIGIBLE postings only. A description on a job eligibility
 * has already ruled out cannot change an application decision, and there
 * are 3,787 of those against 468 that can.
 */
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { htmlToText } from "../lib/ingest/normalize/text.ts";
import { USER_AGENT } from "../lib/ingest/providers/greenhouse.ts";

const write = process.argv.includes("--write");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
const ALL = process.argv.includes("--all");
const PENDING = process.argv.includes("--pending"); // ELIGIBLE + UNCERTAIN: the states a body can still move
// Re-fetch even where a description exists. Needed after a change to
// htmlToText: the stored text was produced by the old normalizer and
// may be truncated at a decoded "<".
const REFRESH = process.argv.includes("--refresh");
const CONCURRENCY = 6;
const PAUSE_MS = 120;

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const page = async (t: string, cols: string, extra: (q: any) => any = (q) => q, order = "id") => {
  const out: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await extra(db.from(t).select(cols)).order(order, { ascending: true }).range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...data); if (data.length < 1000) break;
  }
  return out;
};

/**
 * "https://ntrs.wd1.myworkdayjobs.com/northerntrust/job/Chicago-IL/Head_R159495"
 *   -> "https://ntrs.wd1.myworkdayjobs.com/wday/cxs/ntrs/northerntrust/job/Chicago-IL/Head_R159495"
 *
 * The tenant is the first label of the host, which is how the provider's
 * own split() derives it for the listing endpoint.
 */
export function detailUrl(jobUrl: string): string | null {
  try {
    const u = new URL(jobUrl);
    const tenant = u.hostname.split(".")[0];
    const parts = u.pathname.split("/").filter(Boolean);
    if (!tenant || parts.length < 2) return null;
    const site = parts[0];
    const rest = parts.slice(1).join("/");
    return `https://${u.hostname}/wday/cxs/${tenant}/${site}/${rest}`;
  } catch { return null; }
}

const jobs = await page("jobs", "id,url,title",
  (q) => {
    const base = q.eq("source", "WORKDAY").eq("status", "OPEN");
    if (ALL) return base;
    if (PENDING) return base.in("eligibility", ["ELIGIBLE", "UNCERTAIN"]);
    return base.eq("eligibility", "ELIGIBLE");
  });
const haveDesc = new Set(
  (await page("job_descriptions", "job_id,description_text", (q) => q, "job_id"))
    .filter((d: any) => (d.description_text ?? "").length > 0)
    .map((d: any) => d.job_id));

const todo = jobs.filter((j: any) => (REFRESH || !haveDesc.has(j.id)) && j.url).slice(0, LIMIT);
console.log(`Workday open${ALL ? "" : " ELIGIBLE"} jobs ${jobs.length}, already described ${jobs.length - todo.length}, to fetch ${todo.length}`);
if (!write) { console.log("\ndry run. pass --write to persist."); process.exit(0); }

let ok = 0, empty = 0, failed = 0, chars = 0;
const rows: any[] = [];
const failures: string[] = [];

async function one(j: any): Promise<void> {
  const url = detailUrl(j.url);
  if (!url) { failed++; failures.push(`${j.title}: unparseable url`); return; }
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
    if (!res.ok) { failed++; failures.push(`${j.title}: HTTP ${res.status}`); return; }
    const body: any = await res.json();
    const html = body?.jobPostingInfo?.jobDescription ?? "";
    const text = htmlToText(String(html));
    if (!text) { empty++; return; }
    ok++; chars += text.length;
    rows.push({
      job_id: j.id, description_text: text,
      fetched_at: new Date().toISOString(),
      content_hash: createHash("sha256").update(text).digest("hex"),
    });
  } catch (e) { failed++; failures.push(`${j.title}: ${(e as Error).message.slice(0, 60)}`); }
}

for (let i = 0; i < todo.length; i += CONCURRENCY) {
  await Promise.all(todo.slice(i, i + CONCURRENCY).map(one));
  if (i % 120 === 0 && i) console.log(`  ${i}/${todo.length}  ok ${ok} empty ${empty} failed ${failed}`);
  await new Promise((r) => setTimeout(r, PAUSE_MS));
}

for (let i = 0; i < rows.length; i += 200) {
  const { error } = await db.from("job_descriptions").upsert(rows.slice(i, i + 200), { onConflict: "job_id" });
  if (error) throw new Error(error.message);
}

console.log(`\nfetched ${ok}, empty ${empty}, failed ${failed}`);
console.log(`wrote ${rows.length} descriptions, ${chars.toLocaleString()} characters, avg ${ok ? Math.round(chars / ok) : 0}`);
for (const f of failures.slice(0, 8)) console.log(`  ${f}`);
