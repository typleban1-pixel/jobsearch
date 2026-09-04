/**
 * The Resume Builder and the application pipeline must be ONE tailoring
 * engine. This proves it, offline (llm=null dry run, no paid API):
 *
 *  A. Convergence: the stored-job path (composeTailoredResume) and the
 *     pasted-text path (composeFromRequirements) produce the IDENTICAL
 *     document from the same requirements.
 *  B. Differentiation: two genuinely different postings select a
 *     different theme set and a different capability/summary emphasis,
 *     so tailoring actually responds to the job, not a fixed template.
 */
import { createClient } from "@supabase/supabase-js";
import { composeTailoredResume, composeFromRequirements } from "../lib/applications/prepare.ts";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let n = 0, bad = 0; const ok = (c: boolean, w: string) => { n++; if (!c) { bad++; console.error(`FAIL ${w}`); } };

const page = async (t: string, c: string, f: (q: any) => any) => { const { data } = await f(db.from(t).select(c)); return data ?? []; };
const digest = (doc: any) => JSON.stringify({
  summary: doc?.summary, location: doc?.location,
  roles: (doc?.roles ?? []).map((r: any) => ({ t: r.title, b: r.bullets })),
  projects: (doc?.projects ?? []).map((p: any) => p.bullets ?? p),
  skills: doc?.skillGroups,
});

// Two extracted jobs with requirements, ideally different functions.
const jobs = await page("jobs", "id,title,city,state,metro,remote_policy,canonical_opening_id",
  (q) => q.eq("status", "OPEN").not("extracted_at", "is", null).limit(40));
const withReqs: any[] = [];
for (const j of jobs) {
  const reqs = await page("job_requirements", "normalized_term,raw_text,is_hard_requirement", (q) => q.eq("job_id", j.id));
  if (reqs.length >= 3) withReqs.push({ job: j, reqs });
  if (withReqs.length >= 2) break;
}
ok(withReqs.length >= 2, `found ${withReqs.length} extracted jobs with >=3 requirements`);

const docs: any[] = [];
for (const { job, reqs } of withReqs) {
  const version = { id: null, title: job.title, city: job.city, state: job.state, metro: job.metro, remote_policy: job.remote_policy };
  // A: stored-job path
  const a = await composeTailoredResume(db, job, version, null);
  // B: pasted-text path, same requirements in hand
  const b = await composeFromRequirements(db, {
    requirements: reqs, title: job.title,
    location: { city: job.city, state: job.state, metro: job.metro, remote_policy: job.remote_policy },
  }, null);
  ok(!!a.doc && !!b.doc, `${job.title.slice(0,30)}: both paths produced a doc`);
  ok(digest(a.doc) === digest(b.doc), `${job.title.slice(0,30)}: stored-job and pasted-text paths converge to the identical doc`);
  docs.push({ title: job.title, digest: digest(a.doc), themes: a.themes?.terms ?? [] });
}

// B. Differentiation between two different jobs.
if (docs.length >= 2) {
  ok(JSON.stringify(docs[0].themes) !== JSON.stringify(docs[1].themes),
    `two different jobs select different themes (${docs[0].themes.slice(0,3).join("/")} vs ${docs[1].themes.slice(0,3).join("/")})`);
  ok(docs[0].digest !== docs[1].digest, "two different jobs produce meaningfully different documents");
}

console.log(`${n - bad}/${n} assertions passed`);
process.exit(bad ? 1 : 0);
