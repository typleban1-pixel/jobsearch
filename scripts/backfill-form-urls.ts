/**
 * Resolves the application form url for Greenhouse jobs.
 *
 *   node scripts/backfill-form-urls.ts             report only
 *   node scripts/backfill-form-urls.ts --commit    write them
 *   node scripts/backfill-form-urls.ts --eligible  only OPEN+ELIGIBLE jobs
 *
 * Derivation is deterministic and comes from the board token ingest
 * already holds on companies.ats_token. Verification is a call to the
 * boards API per job, because the point is not that a url exists but
 * that it names the same posting: the id must come back unchanged and
 * the employer must be the one we think it is.
 *
 * Fails closed. A job whose form cannot be resolved keeps a null
 * application_form_url, and the browser adapter refuses rather than
 * following an Apply link on an employer page.
 *
 * apply_url is never touched. It stays the employer's canonical link.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { greenhouseFormUrl, verifyGreenhouseForm, verifyFormPage, sameEmployer } from "../lib/ingest/applicationUrl.ts";

const commit = process.argv.includes("--commit");
const eligibleOnly = process.argv.includes("--eligible");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const page = async (t: string, c: string, f: (q: any) => any = (q) => q) => {
  const out: any[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await f(db.from(t).select(c)).order("id").range(from, from + 499);
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...data); if (data.length < 500) break;
  }
  return out;
};

const companies = new Map((await page("companies", "id,name,ats_provider,ats_token"))
  .map((c: any) => [c.id, c]));

let q = (x: any) => x.eq("source", "GREENHOUSE").eq("status", "OPEN");
if (eligibleOnly) q = (x: any) => x.eq("source", "GREENHOUSE").eq("status", "OPEN").eq("eligibility", "ELIGIBLE");
const jobs = await page("jobs", "id,title,external_id,company_id,apply_url,application_form_url,eligibility", q);

console.log(`${jobs.length} open Greenhouse job(s)${eligibleOnly ? ", eligible only" : ""}`);
const before = jobs.filter((j: any) => j.application_form_url).length;
console.log(`  already carrying a form url: ${before}`);

// Two checks, at the level each one actually belongs to.
//
// Whether the embed route serves a form is a property of the BOARD, not
// of one posting: every job on a board shares the route shape. Whether a
// board and id name this exact posting is a property of the JOB. Doing
// the page fetch per job meant 2,786 HTML requests, which Greenhouse
// throttled after about 312 -- so the board check runs once per board
// and the identity check runs per job against the API.
const boards = [...new Set(jobs.map((j: any) => companies.get(j.company_id)?.ats_token).filter(Boolean))] as string[];
const boardOk = new Map<string, { ok: boolean; why: string }>();
console.log(`\nchecking the form route on ${boards.length} board(s)`);
for (const token of boards) {
  // Several samples, because one closed requisition is not a broken
  // board. Sampling a single job condemned zocdoc and papa on the
  // strength of a job id the board no longer holds.
  const samples = jobs.filter((j: any) => companies.get(j.company_id)?.ats_token === token).slice(0, 3);
  let verdict: { ok: boolean; why: string } = { ok: false, why: "no job to sample" };
  for (const sample of samples) {
    const employer = companies.get(sample.company_id)?.name ?? "";
    const built = greenhouseFormUrl(token, sample.external_id);
    if (!built.ok) { verdict = { ok: false, why: built.why }; continue; }
    const p = await verifyFormPage(built.url, employer);
    verdict = p.ok ? { ok: true, why: p.title } : { ok: false, why: p.why };
    if (p.ok) break;
  }
  boardOk.set(token, verdict);
  console.log(`  ${verdict.ok ? "ok  " : "FAIL"} ${token.padEnd(18)} ${verdict.why.slice(0, 54)}`);
}

const BATCH = 8;
const resolved: Array<{ id: string; url: string; title: string }> = [];
const refused: Array<{ title: string; employer: string; why: string }> = [];

for (let i = 0; i < jobs.length; i += BATCH) {
  const slice = jobs.slice(i, i + BATCH);
  await Promise.all(slice.map(async (j: any) => {
    const co = companies.get(j.company_id);
    const employer = co?.name ?? "(unknown employer)";
    if (!co?.ats_token) { refused.push({ title: j.title, employer, why: "no board token recorded" }); return; }

    const built = greenhouseFormUrl(co.ats_token, j.external_id);
    if (!built.ok) { refused.push({ title: j.title, employer, why: built.why }); return; }

    const v = await verifyGreenhouseForm(co.ats_token, j.external_id);
    if (!v.ok) { refused.push({ title: j.title, employer, why: v.why }); return; }
    // A board that answers with a different company is the failure this
    // whole check exists for.
    if (v.job.companyName && !sameEmployer(v.job.companyName, employer)) {
      refused.push({ title: j.title, employer, why: `board reports ${JSON.stringify(v.job.companyName)}` });
      return;
    }
    // And this board's embed route must have been shown to serve a form.
    const board = boardOk.get(co.ats_token);
    if (!board?.ok) {
      refused.push({ title: j.title, employer, why: `board form route unusable: ${board?.why ?? "unchecked"}` });
      return;
    }
    resolved.push({ id: j.id, url: v.url, title: j.title });
  }));
  if ((i / BATCH) % 10 === 0) process.stdout.write(`\r  verified ${Math.min(i + BATCH, jobs.length)}/${jobs.length}`);
}
process.stdout.write("\r".padEnd(40) + "\r");

console.log(`\nresolved: ${resolved.length}`);
console.log(`refused:  ${refused.length}`);
const byReason: Record<string, number> = {};
for (const r of refused) byReason[r.why.replace(/\d{4,}/g, "#")] = (byReason[r.why.replace(/\d{4,}/g, "#")] ?? 0) + 1;
for (const [why, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(n).padStart(5)}  ${why}`);
}

if (!commit) { console.log(`\nnothing written; pass --commit`); process.exit(0); }

let written = 0;
const now = new Date().toISOString();
for (const r of resolved) {
  const { error } = await db.from("jobs")
    .update({ application_form_url: r.url, application_form_url_verified_at: now })
    .eq("id", r.id);
  if (error) { console.error(`  ${r.title}: ${error.message}`); continue; }
  written++;
}
console.log(`\nwrote a verified form url onto ${written} job(s)`);

const after = (await page("jobs", "id,application_form_url", q)).filter((j: any) => j.application_form_url).length;
console.log(`open Greenhouse jobs with a resolvable form url: ${before} -> ${after} of ${jobs.length}`);
