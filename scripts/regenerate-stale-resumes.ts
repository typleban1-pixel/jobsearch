#!/usr/bin/env -S node --env-file=.env.local
/**
 * Stale-resume cleanup: ensure no OPEN application can be submitted by the
 * system using a resume rendered before the recruiter-language guard existed.
 *
 * Generic and idempotent. For each open, not-submitted, not-closed application
 * whose resume was created before the guard/reliability fix:
 *   - human-approved  -> REVOKE approval (never silently swap an approved
 *     artifact): clear the approval + any submit request, drop to
 *     AWAITING_REVIEW, log AUTHORIZATION_WITHDRAWN. Then it is eligible for
 *     regeneration like any unapproved app.
 *   - STRETCH/APPLICATION_CANDIDATE on a PRODUCTION provider (i.e. the system
 *     could submit it) -> regenerate through the CURRENT builder
 *     (buildTailoredResume: recruiter-language guard + grounding + exact PDF +
 *     layout/density audit), binding the fresh resume to the same application.
 *     No LLM: the builder does not require it and a null-LLM compose still
 *     produces clean, guard-passed recruiter prose from the guarded master.
 *   - REJECT / MANUAL_REVIEW / provider-blocked -> the system cannot submit
 *     it, so no regeneration is needed; only assert no stale submit request
 *     lingers.
 *
 *   node --env-file=.env.local scripts/regenerate-stale-resumes.ts          # dry
 *   node --env-file=.env.local scripts/regenerate-stale-resumes.ts --commit # apply
 */
import { createClient } from "@supabase/supabase-js";
import { buildTailoredResume } from "../lib/applications/prepare.ts";
import { isRecruiterFacing } from "../lib/render/languageQuality.ts";
import { readPolicy, readSwitches } from "../lib/automation/policy.ts";
import { authoritativeCandidacyRows } from "../lib/applications/authoritativeCandidacy.ts";
import { FIT_FORMULA_VERSION } from "../lib/scoring/fit.ts";
import { TAXONOMY_VERSION } from "../lib/scoring/requirementClass.ts";
import { CANDIDACY_MODEL_VERSION } from "../lib/scoring/candidacy.ts";

const commit = process.argv.includes("--commit");
const FIX = "2026-09-06T03:19:00Z"; // recruiter-language guard + reliability fix (34ba0c9)
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const pg = async <T,>(t: string, c: string): Promise<T[]> => { const o:T[]=[]; for(let x=0;;x+=1000){const{data,error}=await db.from(t).select(c).range(x,x+999);if(error)throw new Error(`${t}: ${error.message}`);o.push(...(data as T[]));if(!data||data.length<1000)break;}return o; };
const CLOSED = new Set(["REJECTED","WITHDRAWN","ABANDONED"]);

const apps = (await pg<any>("applications","id,job_id,status,resume_id,submitted_at,human_approved,authorization_mode,submit_requested_at,submit_started_at,is_test"))
  .filter(a => !a.is_test && !a.submitted_at && !CLOSED.has(a.status) && a.resume_id);
const resumes = new Map((await pg<any>("resumes","id,created_at,renderer_version,content")).map(r => [r.id, r]));
// A résumé is "stale" if it predates the fix OR -- regardless of date -- its
// stored content still carries a line that fails the recruiter-language guard.
// The content check catches résumés rendered after the FIX date but before the
// tailored-path guard existed (e.g. a regen through the still-broken builder).
const hasImplLanguage = (r: any): boolean => {
  const lines = Array.isArray(r?.content?.lines) ? r.content.lines : [];
  return lines.some((l: any) => typeof l === "string" && l.trim() && !isRecruiterFacing(l));
};
const isStale = (r: any): boolean => !!r && (r.created_at < FIX || hasImplLanguage(r));
const jobs = new Map((await pg<any>("jobs","id,title,company_id,source,status,eligibility,canonical_opening_id")).map(j => [j.id, j]));
const cos = new Map((await pg<any>("companies","id,name")).map(c => [c.id, c.name]));
const { data: pr } = await db.from("profile").select("profile_version").single();
const rowOf = authoritativeCandidacyRows(await pg<any>("job_candidacy","job_id,verdict,reason_codes,hard_met,hard_total,profile_version,formula_version,taxonomy_version,model_version"),
  { profileVersion: (pr as any).profile_version, formulaVersion: FIT_FORMULA_VERSION, taxonomyVersion: TAXONOMY_VERSION, modelVersion: CANDIDACY_MODEL_VERSION });
const sw = await readSwitches(db);

const stale = apps.filter(a => isStale(resumes.get(a.resume_id)));
console.log(`stale open resumes before: ${stale.length}${commit ? "" : "   (dry run — pass --commit to apply)"}\n`);

let regenerated = 0, revoked = 0, skipped = 0; const skipReasons: string[] = [];
async function regen(a: any, tag: string) {
  const j = jobs.get(a.job_id);
  const { data: version } = await db.from("job_versions").select("*").eq("job_id", a.job_id).eq("is_current", true).maybeSingle();
  if (!version) { skipped++; skipReasons.push(`${tag}: no current job_version`); return; }
  if (!commit) { console.log(`  WOULD REGEN ${tag}`); regenerated++; return; }
  const out = await buildTailoredResume(db, a.id, j, version, null);
  if (out.provenanceFailure || !out.resumeId) { skipped++; skipReasons.push(`${tag}: regen failed (${out.provenanceFailure ?? "no resume"})`); console.log(`  FAILED  ${tag}: ${out.provenanceFailure ?? "no resume"}`); return; }
  regenerated++;
  console.log(`  REGEN   ${tag} -> resume ${out.resumeId.slice(0,8)} pages=${out.pages} sha=${(out.artifactSha256??"").slice(0,10)}`);
}

for (const a of stale) {
  const j = jobs.get(a.job_id); const r = rowOf.get(a.job_id); const rz = resumes.get(a.resume_id);
  const prov = sw.byProvider[j.source]; const providerProd = prov?.capability === "PRODUCTION" && !prov.paused;
  const tag = `${(cos.get(j.company_id)||"?").slice(0,16)} — ${j.title.slice(0,38)} [${a.id.slice(0,8)}]`;
  const verdict = r?.verdict ?? "NONE";

  if (a.human_approved) {
    // Never silently swap an approved artifact: revoke, re-require review.
    if (commit) {
      await db.from("applications").update({
        human_approved: false, human_approved_at: null, authorization_mode: null,
        policy_authorized_at: null, policy_snapshot: null,
        approved_artifact_sha256: null, approved_content_sha256: null, approved_answers_sha256: null,
        submit_requested_at: null, submit_started_at: null, status: "AWAITING_REVIEW",
      }).eq("id", a.id);
      await db.from("application_events").insert({ application_id: a.id, event: "AUTHORIZATION_WITHDRAWN", actor: "stale-resume-cleanup",
        detail: `Approval revoked: it was bound to a resume (${a.resume_id}) rendered before the recruiter-language guard. Re-review required; the resume is being regenerated.` });
    }
    revoked++;
    console.log(`  REVOKE  ${tag} (was human-approved on a pre-fix resume; re-review required)`);
    if (providerProd && (verdict === "STRETCH" || verdict === "APPLICATION_CANDIDATE")) await regen(a, tag);
    continue;
  }
  if (providerProd && (verdict === "STRETCH" || verdict === "APPLICATION_CANDIDATE")) { await regen(a, tag); continue; }
  // Not submittable by the system: assert no stale submit request lingers.
  skipped++; skipReasons.push(`${tag}: ${verdict} on ${j.source}${providerProd?"":" (provider blocked)"} — not system-submittable`);
  if (commit && (a.submit_requested_at || a.submit_started_at)) {
    await db.from("applications").update({ submit_requested_at: null, submit_started_at: null }).eq("id", a.id);
    console.log(`  CLEARED stale submit request on ${tag}`);
  }
}

console.log(`\nregenerated: ${regenerated} · approvals revoked: ${revoked} · skipped (not system-submittable): ${skipped}`);
if (skipReasons.length) { console.log("skipped:"); for (const s of skipReasons) console.log(`  - ${s}`); }
