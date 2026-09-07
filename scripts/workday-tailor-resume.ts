/**
 * The tailored résumé for a Workday application, on its own.
 *
 *   node --env-file=.env.local scripts/workday-tailor-resume.ts <application_id>            (dry run)
 *   node --env-file=.env.local scripts/workday-tailor-resume.ts <application_id> --commit
 *
 * prepareApplication() tailors the résumé and maps the form's questions in
 * one pass, and it refuses Workday because no form snapshot exists for it:
 * a Workday form is discovered live, page by page, by
 * workday-run-application.ts, which writes the questions itself. The
 * résumé step it never reaches is the same builder every other provider
 * uses -- composed from the frozen profile, grounding-checked, rendered,
 * stored, and bound to the application by resume_id -- so this runs that
 * step alone. The My Experience page is then filled from it by
 * workday-experience-fill.ts.
 *
 * Nothing about approval changes: a résumé built here is exactly as
 * unapproved as one built by prepareApplication, and the portal's review
 * gate still binds approval to the rendered artifact's hash.
 */
import { createClient } from "@supabase/supabase-js";
import { required, optional } from "../lib/env.ts";
import { buildTailoredResume } from "../lib/applications/prepare.ts";
import { AnthropicProvider } from "../lib/llm/anthropic.ts";

const id = process.argv[2];
if (!id) { console.error("usage: node scripts/workday-tailor-resume.ts <application_id> [--commit]"); process.exit(2); }
const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: app } = await db.from("applications").select("id,status,job_id,resume_id,submitted_at,human_approved").eq("id", id).single();
if (!app) { console.error("no such application"); process.exit(1); }
if (app.submitted_at) { console.error("refusing: this application was submitted; its résumé is the document the employer received"); process.exit(1); }
if (app.human_approved) { console.error("refusing: this application is approved; clear the approval first (an approval binds to one document)"); process.exit(1); }
const { data: job } = await db.from("jobs")
  .select("id,source,external_id,title,company_id,canonical_opening_id,apply_url,application_form_url").eq("id", app.job_id).single();
const { data: version } = await db.from("job_versions")
  .select("id,title,city,state,metro,remote_policy").eq("job_id", app.job_id).eq("is_current", true).single();
const { data: company } = await db.from("companies").select("name").eq("id", job!.company_id).single();
if (job!.source !== "WORKDAY") { console.error(`refusing: ${job!.source} is prepared by prepareApplication, which handles its form too`); process.exit(1); }
if (!version) { console.error("no current job version; the posting has to be ingested before a résumé can be tailored to it"); process.exit(1); }

console.log(`${company?.name} — ${job!.title}`);
console.log(`  application ${id.slice(0, 8)}  ${app.status}  resume ${app.resume_id ? app.resume_id.slice(0, 8) : "none"}`);
console.log(`  job version ${version.id.slice(0, 8)}  ${version.city ?? ""} ${version.state ?? ""} ${version.remote_policy ?? ""}`.trimEnd());
if (!commit) { console.log("\ndry run; pass --commit to compose, render and bind the tailored résumé."); process.exit(0); }

const llm = optional("ANTHROPIC_API_KEY") ? new AnthropicProvider() : null;
if (!llm) console.log("  (no ANTHROPIC_API_KEY: lines keep the master wording)");
const t = await buildTailoredResume(db, id, job, version, llm);
if (t.provenanceFailure) { console.error(`provenance gate: ${t.provenanceFailure}`); process.exit(1); }
if (!t.resumeId) { console.error("no résumé was produced"); process.exit(1); }
console.log(`\nresume ${t.resumeId.slice(0, 8)}: ${t.accepted} lines accepted, ${t.rejected} rejected, ${t.fellBack} kept master wording`
  + (t.artifactSha256 ? `; artifact ${t.artifactSha256.slice(0, 12)}${t.pages ? `, ${t.pages} page(s)` : ""}` : ""));
await db.from("application_events").insert({
  application_id: id, event: "RESUME_TAILORED", actor: "worker",
  detail: `Tailored résumé ${t.resumeId} composed and bound for this Workday application (workday-tailor-resume). Not approved.`,
});
console.log("bound to the application; review and approve it in the portal before anything is submitted.");
