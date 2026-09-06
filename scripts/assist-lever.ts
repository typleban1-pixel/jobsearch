#!/usr/bin/env -S node --env-file=.env.local
/**
 * ASSISTED-SUBMIT preparation for Lever.
 *
 * Prepares autonomous-SAFE Lever STRETCH/APPLICATION_CANDIDATE jobs for human
 * finish: revalidate candidacy, run the full prepare pipeline (answers +
 * current guarded tailored résumé + exact PDF + layout audit + live Lever form
 * snapshot), and leave the application in AWAITING_REVIEW so the portal shows
 * "Ready to finish on Lever". It NEVER fills the live form or submits -- the
 * on-demand fill (scripts/fill-lever.ts) does that later, locally, when a
 * person is present to solve the hCaptcha. One job at a time; each browser is
 * opened for the snapshot and closed before the next (no persistent sessions).
 *
 * Selection guards (all must pass; candidacy semantics unchanged):
 *   provider LEVER + capability ASSISTED_SUBMIT, job OPEN + ELIGIBLE,
 *   authoritative candidacy STRETCH or APPLICATION_CANDIDATE, NOT a material
 *   qualification gap, no already-submitted application on the opening.
 *
 *   node --env-file=.env.local scripts/assist-lever.ts [--limit N] [--commit]
 */
import { createClient } from "@supabase/supabase-js";
import { prepareApplication } from "../lib/applications/prepare.ts";
import { snapshotLeverLive } from "../lib/browser/leverPrepare.ts";
import { AnthropicProvider } from "../lib/llm/anthropic.ts";
import { authoritativeCandidacyRows } from "../lib/applications/authoritativeCandidacy.ts";
import { hasMaterialQualificationGap } from "../lib/applications/revalidate.ts";
import { FIT_FORMULA_VERSION } from "../lib/scoring/fit.ts";
import { TAXONOMY_VERSION } from "../lib/scoring/requirementClass.ts";
import { CANDIDACY_MODEL_VERSION } from "../lib/scoring/candidacy.ts";

const commit = process.argv.includes("--commit");
const li = process.argv.indexOf("--limit");
const limit = li >= 0 ? Number(process.argv[li + 1]) : 3;
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const llm = new AnthropicProvider();
const pg = async <T,>(t: string, c: string, f: (q: any) => any = (q) => q): Promise<T[]> => { const o: T[] = []; for (let x = 0; ; x += 1000) { const { data, error } = await f(db.from(t).select(c)).range(x, x + 999); if (error) throw new Error(`${t}: ${error.message}`); o.push(...(data as T[])); if (!data || data.length < 1000) break; } return o; };

const { data: pr } = await db.from("profile").select("profile_version").single();
const rowOf = authoritativeCandidacyRows(await pg<any>("job_candidacy", "job_id,verdict,reason_codes,hard_met,hard_total,profile_version,formula_version,taxonomy_version,model_version"),
  { profileVersion: (pr as any).profile_version, formulaVersion: FIT_FORMULA_VERSION, taxonomyVersion: TAXONOMY_VERSION, modelVersion: CANDIDACY_MODEL_VERSION });
const jobs = (await pg<any>("jobs", "id,title,company_id,source,status,eligibility,application_form_url,url,canonical_opening_id")).filter((j) => j.source === "LEVER" && j.status === "OPEN" && j.eligibility === "ELIGIBLE");
const cos = new Map((await pg<any>("companies", "id,name")).map((c) => [c.id, c.name]));
const apps = await pg<any>("applications", "id,job_id,submitted_at,status");
const submittedOpenings = new Set(apps.filter((a) => a.submitted_at).map((a) => jobs.find((j) => j.id === a.job_id)?.canonical_opening_id).filter(Boolean));
const hasApp = new Set(apps.map((a) => a.job_id));

const eligible = jobs.filter((j) => {
  const r = rowOf.get(j.id); if (!r) return false;
  if (r.verdict !== "STRETCH" && r.verdict !== "APPLICATION_CANDIDATE") return false;
  if (hasMaterialQualificationGap({ candidacyVerdict: r.verdict, candidacyReasonCode: r.reason_codes?.[0] ?? null, hardMet: r.hard_met, hardTotal: r.hard_total })) return false;
  if (j.canonical_opening_id && submittedOpenings.has(j.canonical_opening_id)) return false;
  return true;
});
console.log(`Lever ASSISTED-safe candidates: ${eligible.length}; preparing up to ${limit}${commit ? "" : "  (dry run — pass --commit to prepare)"}\n`);

let prepared = 0, blocked = 0, failed = 0;
for (const j of eligible.slice(0, limit)) {
  const r = rowOf.get(j.id)!;
  const tag = `${(cos.get(j.company_id) || "?").slice(0, 18)} — ${j.title.slice(0, 40)} [${r.verdict} ${r.hard_met}/${r.hard_total}]`;
  if (!commit) { console.log(`  WOULD PREPARE ${tag}`); prepared++; continue; }
  try {
    const res = await prepareApplication(db, j.id, llm, {
      liveSnapshot: async (job) => job.applyUrl ? snapshotLeverLive({ applyUrl: job.applyUrl, reviewedOffice: job.reviewedOffice }) : { ok: false, reason: "no apply URL" },
    });
    if (res.refusedReason) { failed++; console.log(`  REFUSED  ${tag}: ${res.refusedReason.slice(0, 80)}`); continue; }
    if (res.status === "BLOCKED_NEEDS_INPUT") { blocked++; console.log(`  NEEDS-ANSWER ${tag}: ${res.blocked} blocked (HUMAN_FACT) -> shows as 'needs your answer'`); continue; }
    prepared++;
    console.log(`  PREPARED ${tag} -> ${res.status}, resume ${res.resumeId?.slice(0, 8)}, ${res.tailoring.accepted} lines, pdf ${res.tailoring.artifactSha256?.slice(0, 10)} (${res.tailoring.pages}pg)`);
  } catch (e) { failed++; console.log(`  FAILED   ${tag}: ${(e as Error).message.slice(0, 120)}`); }
}
console.log(`\nprepared (ready to finish on Lever): ${prepared} · needs-answer: ${blocked} · failed/refused: ${failed}`);
