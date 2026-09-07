#!/usr/bin/env -S node --env-file=.env.local
/**
 * Re-decide standing POLICY_AUTHORIZED applications under the CURRENT policy.
 *
 * An automation policy authorizes an application at a moment in time. When the
 * policy later tightens -- a new material-gap guard, a higher evidence bar --
 * applications authorized under the old rule are still sitting in
 * READY_TO_SUBMIT with a POLICY_AUTHORIZED marker. The worker re-decides them
 * on its next run and will not submit them, and the submit-listener never
 * claims one without an explicit submit request, so they cannot be submitted.
 * But until the next worker run they READ as authorized in the portal, which
 * is a false record of authorization.
 *
 * This closes that window generically: for every non-submitted, machine-
 * authorized (never human-approved) application, it runs decide() again with
 * today's policy and today's authoritative candidacy. If the current policy
 * would NOT autonomously submit it, the machine authorization is withdrawn and
 * the application drops to AWAITING_REVIEW, where a person can still send it.
 * Nothing a person approved is ever touched. It hardcodes no job or employer;
 * the decision is entirely decide()'s.
 *
 *   node --env-file=.env.local scripts/reconcile-authorizations.ts          # report only
 *   node --env-file=.env.local scripts/reconcile-authorizations.ts --commit # apply
 */
import { createClient } from "@supabase/supabase-js";
import { decide, readPolicy, readSwitches, type Candidate } from "../lib/automation/policy.ts";
import { authoritativeCandidacyRows, productionApplications } from "../lib/applications/authoritativeCandidacy.ts";
import { FIT_FORMULA_VERSION } from "../lib/scoring/fit.ts";
import { TAXONOMY_VERSION } from "../lib/scoring/requirementClass.ts";
import { CANDIDACY_MODEL_VERSION } from "../lib/scoring/candidacy.ts";

const commit = process.argv.includes("--commit");
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const page = async <T,>(t: string, c: string): Promise<T[]> => {
  const out: T[] = [];
  for (let x = 0; ; x += 1000) {
    const { data, error } = await db.from(t).select(c).range(x, x + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...(data as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
};

const [allApps, jobs, candidacy, companies, profileRow] = await Promise.all([
  page<any>("applications", "id,job_id,status,submitted_at,human_approved,authorization_mode,all_fields_confident,resume_id,submit_requested_at,submit_started_at,is_test"),
  page<any>("jobs", "id,title,company_id,source,status,eligibility,salary_min,canonical_opening_id"),
  page<any>("job_candidacy", "job_id,verdict,reason_codes,hard_met,hard_total,profile_version,formula_version,taxonomy_version,model_version"),
  page<any>("companies", "id,name"),
  db.from("profile").select("profile_version").single(),
]);
const jobById = new Map(jobs.map((j) => [j.id, j]));
const coName = new Map(companies.map((c) => [c.id, c.name]));
const versions = {
  profileVersion: (profileRow as any).data.profile_version,
  formulaVersion: FIT_FORMULA_VERSION, taxonomyVersion: TAXONOMY_VERSION, modelVersion: CANDIDACY_MODEL_VERSION,
};
const rowOf = authoritativeCandidacyRows(candidacy, versions);
const policy = await readPolicy(db);
const switches = await readSwitches(db);

// Only real, machine-authorized, not-yet-submitted applications. A person's
// approval (human_approved) is never re-litigated here.
const candidates = productionApplications(allApps).filter(
  (a) => !a.submitted_at && !a.human_approved && a.authorization_mode === "POLICY_AUTHORIZED",
);

console.log(`${candidates.length} standing POLICY_AUTHORIZED application(s) to re-decide under current policy\n`);
let withdrawn = 0, kept = 0;
for (const a of candidates) {
  const job = jobById.get(a.job_id);
  if (!job) continue;
  const r = rowOf.get(a.job_id);
  const d = decide({
    jobId: job.id, companyId: job.company_id, provider: job.source,
    candidacy: r?.verdict ?? null,
    candidacyReasonCode: r?.reason_codes?.[0] ?? null,
    hardMet: r?.hard_met ?? null, hardTotal: r?.hard_total ?? null,
    eligibility: job.eligibility, matchScore: null, baseSalaryMin: job.salary_min ?? null,
    allFieldsConfident: Boolean(a.all_fields_confident),
    blockedAnswers: 0, resumeClaimsAllGrounded: true, artifactValid: true,
    submittedToday: 0,
  } as Candidate, policy, switches);

  const tag = `${(coName.get(job.company_id) ?? "?").slice(0, 22)} — ${job.title.slice(0, 44)}`;
  if (d.action === "SUBMIT") { kept++; console.log(`  KEEP     ${tag}`); continue; }
  withdrawn++;
  console.log(`  WITHDRAW ${tag}\n           ${r?.verdict} ${r?.hard_met}/${r?.hard_total} [${(r?.reason_codes ?? []).join(",")}] -> ${d.action}: ${d.why}`);
  if (commit) {
    const { error } = await db.from("applications").update({
      authorization_mode: null, policy_authorized_at: null, policy_snapshot: null,
      approved_artifact_sha256: null, approved_content_sha256: null,
      submit_requested_at: null, submit_started_at: null,
      status: "AWAITING_REVIEW",
    }).eq("id", a.id);
    if (error) { console.log(`           FAILED: ${error.message}`); continue; }
    await db.from("application_events").insert({
      application_id: a.id, event: "AUTHORIZATION_WITHDRAWN", actor: "reconcile",
      detail: `Machine authorization withdrawn: current policy no longer submits this autonomously (${d.why}). Moved to review; a person may still send it.`,
    });
  }
}
console.log(`\n${withdrawn} withdrawn to review · ${kept} still policy-eligible${commit ? "" : "  (report only; pass --commit to apply)"}`);
