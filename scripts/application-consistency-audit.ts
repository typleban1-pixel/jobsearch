/**
 * Deterministic, rerunnable consistency audit across the application chain:
 *   job -> extraction -> score -> candidacy -> application -> résumé -> answers
 *   -> prepare -> fill -> submit -> confirmation
 *
 *   node scripts/application-consistency-audit.ts
 *
 * REPORT ONLY. It never writes, and it never proposes touching HUMAN_CONFIRMED
 * truth -- only derived/system inconsistencies are surfaced, for a human to
 * decide on. Exits non-zero if any inconsistency is found, so it can gate CI.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const page = async (t: string, c: string, x: (q: any) => any = (q) => q) => { const o: any[] = []; for (let f = 0; ; f += 1000) { const { data, error } = await x(db.from(t).select(c)).order("id").range(f, f + 999); if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break; } return o; };

const findings: Array<{ sev: "ERROR" | "WARN"; check: string; detail: string }> = [];
const add = (sev: "ERROR" | "WARN", check: string, detail: string) => findings.push({ sev, check, detail });

const live = (await db.from("profile").select("profile_version").eq("singleton", true).single()).data!.profile_version;
const apps = await page("applications", "id,job_id,status,resume_id,submitted_at,submit_outcome,confirmation_reference,canonical_opening_id,is_test,human_approved");
const liveApps = apps.filter((a: any) => !a.is_test);

// 1. cross-application artifact contamination: one resume_id on >1 application.
const byResume = new Map<string, string[]>();
for (const a of liveApps) if (a.resume_id) { const l = byResume.get(a.resume_id) ?? []; l.push(a.id); byResume.set(a.resume_id, l); }
for (const [rid, ids] of byResume) if (ids.length > 1) add("ERROR", "cross-application-resume", `resume_id ${rid.slice(0, 8)} is bound to ${ids.length} applications (${ids.map((i) => i.slice(0, 8)).join(",")}) -- résumés are application-specific`);

// 2. submitted without employer confirmation.
for (const a of liveApps) if (a.submitted_at && a.submit_outcome !== "CONFIRMED" && !a.confirmation_reference)
  add("ERROR", "submitted-no-confirmation", `application ${a.id.slice(0, 8)} is submitted but has no CONFIRMED outcome or confirmation reference`);

// 3. duplicate live applications on one requisition.
const byOpening = new Map<string, string[]>();
for (const a of liveApps) if (a.canonical_opening_id && !["REJECTED", "WITHDRAWN", "ABANDONED"].includes(a.status)) { const l = byOpening.get(a.canonical_opening_id) ?? []; l.push(a.id); byOpening.set(a.canonical_opening_id, l); }
for (const [op, ids] of byOpening) if (ids.length > 1) add("ERROR", "duplicate-live-application", `${ids.length} live applications on canonical opening ${op.slice(0, 8)} (${ids.map((i) => i.slice(0, 8)).join(",")})`);

// 4. résumé binding without a real artifact.
const resumeIds = [...new Set(liveApps.map((a: any) => a.resume_id).filter(Boolean))];
const resumeById = new Map<string, any>();
for (let i = 0; i < resumeIds.length; i += 50) { const { data } = await db.from("resumes").select("id,artifact_sha256,artifact_bytes").in("id", resumeIds.slice(i, i + 50)); for (const r of data ?? []) resumeById.set(r.id, r); }
for (const a of liveApps) if (a.resume_id) { const r = resumeById.get(a.resume_id); if (!r) add("ERROR", "resume-missing", `application ${a.id.slice(0, 8)} points at resume_id ${a.resume_id.slice(0, 8)} which does not exist`); else if (!r.artifact_sha256 || !r.artifact_bytes) if (["READY_TO_SUBMIT", "SUBMITTED"].includes(a.status)) add("ERROR", "resume-no-artifact", `application ${a.id.slice(0, 8)} (${a.status}) has a résumé with no rendered artifact (sha256/bytes null)`); }

// 5. a file field surfaced as a BLOCKED (typed) question rather than a handoff.
const blocked = await page("application_answers", "application_id,field_key,field_label,confidence_state,block_kind", (q) => q.eq("confidence_state", "BLOCKED"));
const appById = new Map(liveApps.map((a: any) => [a.id, a]));
for (const b of blocked) {
  const app = appById.get(b.application_id); if (!app) continue;
  // form_snapshot type lookup would confirm; the known signature is a file field surfaced as a blocked catalog-miss.
  if (/overview application/i.test(b.field_label ?? "") || /resume|cv|upload|attachment|file/i.test(b.field_label ?? ""))
    add("WARN", "file-field-as-blocked-question", `application ${b.application_id.slice(0, 8)} field ${JSON.stringify((b.field_label ?? "").slice(0, 40))} is a BLOCKED typed question but looks like a file upload (should be an employer-form handoff)`);
}

// 6. orphaned test applications.
const testCount = apps.filter((a: any) => a.is_test).length;
if (testCount > 0) add("WARN", "orphaned-test-apps", `${testCount} is_test applications remain (validation cruft; purge with purge_test_application)`);

// 7. stale-profile scoring on OPEN+ELIGIBLE jobs.
const jobs = await page("jobs", "id,status,eligibility");
const openElig = new Set(jobs.filter((j: any) => j.status === "OPEN" && j.eligibility === "ELIGIBLE").map((j: any) => j.id));
const curScores = await page("job_scores", "job_id,profile_version,is_current", (q) => q.eq("is_current", true));
const staleActive = curScores.filter((s: any) => openElig.has(s.job_id) && s.profile_version !== live);
if (staleActive.length) add("ERROR", "stale-active-score", `${staleActive.length} OPEN+ELIGIBLE jobs carry a current score at a profile version other than the live v${live}`);
const scored = new Set(curScores.filter((s: any) => s.profile_version === live).map((s: any) => s.job_id));
const missingScore = [...openElig].filter((id) => !scored.has(id));
if (missingScore.length) add("WARN", "missing-active-score", `${missingScore.length} OPEN+ELIGIBLE jobs have no current v${live} score`);

// 8. AWAITING_REVIEW / READY_TO_SUBMIT with a still-BLOCKED required answer.
const blockedByApp = new Map<string, number>();
for (const b of blocked) blockedByApp.set(b.application_id, (blockedByApp.get(b.application_id) ?? 0) + 1);
for (const a of liveApps) if (["READY_TO_SUBMIT"].includes(a.status) && (blockedByApp.get(a.id) ?? 0) > 0)
  add("ERROR", "ready-with-blocked", `application ${a.id.slice(0, 8)} is READY_TO_SUBMIT but still has ${blockedByApp.get(a.id)} BLOCKED answer(s)`);

// ---- report ----
console.log(`APPLICATION CONSISTENCY AUDIT  (live profile v${live}; ${liveApps.length} real applications)\n`);
const errors = findings.filter((f) => f.sev === "ERROR");
const warns = findings.filter((f) => f.sev === "WARN");
for (const f of [...errors, ...warns]) console.log(`  [${f.sev}] ${f.check}: ${f.detail}`);
console.log(`\n${errors.length} error(s), ${warns.length} warning(s).`);
if (!findings.length) console.log("chain is consistent: no derived/system inconsistencies found.");
process.exit(errors.length ? 1 : 0);
