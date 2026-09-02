/**
 * Prepares an application for a provider with no form snapshot.
 *
 * Greenhouse publishes its form, so prepareApplication can map every
 * question before anyone opens a browser. Ashby's form endpoint returns
 * 401 without employer credentials and Workday's sits behind a sign-in,
 * so for those the form genuinely cannot be read ahead of time, and
 * prepareApplication correctly refuses rather than guessing at
 * questions it has not seen.
 *
 * The resume is a different matter. composeTailoredResume works from the
 * posting and the frozen profile and never touches the form, so the
 * grounded, claim-checked, hash-bound PDF can be produced exactly as it
 * would be for Greenhouse. That is most of what a person needs to apply
 * by hand.
 *
 * So this runs the real pipeline as far as it legitimately goes: bind
 * the current version, tailor the resume through the same guards, render
 * the same artifact, and stop at the form. No questions are invented,
 * and the application is left in a handoff state naming what a person
 * has to do.
 *
 *   node scripts/prepare-handoff.ts <job_id> [--write]
 */
import { createClient } from "@supabase/supabase-js";
import { required, optional } from "../lib/env.ts";
import { composeTailoredResume } from "../lib/applications/prepare.ts";
import { renderAndStore } from "../lib/render/artifact.ts";
import { AnthropicProvider } from "../lib/llm/anthropic.ts";

const jobId = process.argv[2];
const write = process.argv.includes("--write");
if (!jobId) { console.error("usage: prepare-handoff.ts <job_id> [--write]"); process.exit(2); }

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });
const llm = optional("ANTHROPIC_API_KEY") ? new AnthropicProvider() : null;

const { data: job } = await db.from("jobs").select("*").eq("id", jobId).single();
const { data: company } = await db.from("companies").select("name,ats_token").eq("id", job!.company_id).single();
const { data: version } = await db.from("job_versions").select("*").eq("job_id", jobId)
  .eq("is_current", true).order("version_number", { ascending: false }).limit(1).maybeSingle();
if (!version) { console.error("this job has no current version to bind"); process.exit(1); }

const { data: verdict } = await db.from("job_candidacy").select("verdict,hard_met,hard_total,reason,occupational")
  .eq("job_id", jobId).order("created_at", { ascending: false }).limit(1);
const c = verdict![0]!;

console.log(`${company?.name} — ${job!.title}`);
console.log(`  provider ${job!.source}  posting ${job!.status}/${job!.eligibility}`);
console.log(`  version ${version.id} (v${version.version_number}, current)`);
console.log(`  candidacy ${c.verdict} ${c.hard_met}/${c.hard_total}`);

// The same composer prepareApplication uses. Same guards, same claims.
const comp = await composeTailoredResume(db, job, version, llm);
if (comp.provenanceFailure) {
  console.error(`\nREFUSED: provenance failure — ${comp.provenanceFailure}`);
  process.exit(1);
}
if (!comp.doc || !comp.result) { console.error("\nno tailored document produced"); process.exit(1); }

const r = comp.result;
const reverted = Array.isArray(comp.revertedForProvenance) ? comp.revertedForProvenance.length : 0;
console.log(`\ntailoring: ${r.accepted?.length ?? 0} accepted, ${r.rejected?.length ?? 0} rejected, `
  + `${(comp.dropped ?? []).length} dropped, ${reverted} reverted for provenance`);

if (!write) {
  const d: any = comp.doc;
  console.log("\n--- tailored resume ---");
  console.log(`${d.name} · ${d.email}${d.phone ? " · " + d.phone : ""} · ${d.location}`);
  if (d.summary?.text) console.log(`\nSUMMARY\n  ${d.summary.text}`);
  for (const role of d.roles ?? []) {
    console.log(`\n${role.title} — ${role.employer}  ${String(role.start).slice(0, 7)} to ${role.end ? String(role.end).slice(0, 7) : "present"}`);
    for (const l of role.lines ?? []) console.log(`  - ${l.text ?? l}`);
  }
  for (const p of d.projects ?? []) {
    console.log(`\nPROJECT: ${p.name}`);
    if (p.line?.text) console.log(`  - ${p.line.text}`);
    for (const l of p.optional ?? []) console.log(`  - ${l.text ?? l}`);
  }
  if (d.skillGroups?.length) {
    console.log("\nSKILLS");
    for (const g of d.skillGroups) console.log(`  ${g.label}: ${g.skills.join(", ")}`);
  }
  console.log("\ndry run. pass --write to store the resume and create the handoff record.");
  process.exit(0);
}

const { data: master } = await db.from("resumes").select("id").eq("is_master", true).single();
const { data: resume, error } = await db.from("resumes").insert({
  label: `Tailored for ${job!.title}`,
  is_master: false,
  strategy: "REFRAME_WITHIN_CITED_EVIDENCE",
  tailoring_strategy: "REFRAME_WITHIN_CITED_EVIDENCE",
  grounding_version: 1,
  content: comp.doc,
  tailored_for_job_id: jobId,
  tailored_for_job_version_id: version.id,
  derived_from: master?.id ?? null,
}).select("id").single();
if (error) { console.error(`resume insert: ${error.message}`); process.exit(1); }

const art = await renderAndStore(db, resume!.id, comp.doc);
console.log(`\nresume ${resume!.id}`);
console.log(`  artifact ${art.sha256} (${art.bytes} bytes, ${art.pages} page(s), content ${art.contentSha256.slice(0, 16)}...)`);

const ATS = { ASHBY: "Ashby", WORKDAY: "Workday", LEVER: "Lever", GREENHOUSE: "Greenhouse" } as const;
const ats = (ATS as any)[job!.source] ?? job!.source;
const reason = [
  `HANDOFF: ${ats} does not publish its application form, so the questions cannot be read or`,
  `answered before a person opens it. ${job!.source === "ASHBY"
    ? "Ashby's form endpoint returns 401 without employer credentials."
    : "Workday's form sits behind an account sign-in."}`,
  "No questions have been guessed and no answers invented.",
  "",
  `Apply at: ${job!.application_form_url ?? job!.url}`,
  "",
  `The tailored resume IS prepared and bound: resume ${resume!.id}, artifact ${art.sha256}.`,
  "It went through the same claim guards, provenance checks and renderer as an automated",
  "application, so the document is the one the system would have sent.",
  "",
  `Candidacy at preparation: ${c.verdict}, ${c.hard_met}/${c.hard_total} hard requirements met.`,
  c.reason ? `  ${c.reason}` : "",
  "",
  "Next human step: open the apply URL, upload the prepared resume, and answer the employer's",
  "questions. Nothing about this application has been submitted.",
].filter(Boolean).join("\n");

let { data: app } = await db.from("applications").select("id,status").eq("job_id", jobId).maybeSingle();
if (!app) {
  const { data: ins, error: e2 } = await db.from("applications").insert({
    job_id: jobId, job_version_id: version.id, status: "DRAFT",
    submission_mode: "MANUAL", resume_id: resume!.id,
  }).select("id,status").single();
  if (e2) { console.error(`application insert: ${e2.message}`); process.exit(1); }
  app = ins;
}
await db.from("applications").update({ status: "PREPARING", resume_id: resume!.id }).eq("id", app!.id);
const { error: e3 } = await db.from("applications")
  .update({ status: "BLOCKED_NEEDS_INPUT", blocked_reason: reason }).eq("id", app!.id);
if (e3) { console.error(`status: ${e3.message}`); process.exit(1); }

console.log(`application ${app!.id}  status BLOCKED_NEEDS_INPUT (handoff)`);
console.log(`apply at: ${job!.application_form_url ?? job!.url}`);
