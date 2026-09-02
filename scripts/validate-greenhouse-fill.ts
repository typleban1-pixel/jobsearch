/**
 * The Greenhouse fill path, against real live application forms.
 *
 *   node scripts/validate-greenhouse-fill.ts [--jobs 3]
 *
 * Creates test applications, prepares them, opens each employer's real
 * form in a real browser, and fills only what the resolver supports.
 * Nothing is submitted; the submission guards are in force throughout,
 * and any guard firing is a failure of this run.
 *
 * Test applications are purged at the end, whatever happens.
 */
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { required, optional } from "../lib/env.ts";
import { AnthropicProvider } from "../lib/llm/anthropic.ts";
import { prepareApplication, loadContext } from "../lib/applications/prepare.ts";
import { fillApplication, type PreparedAnswer } from "../lib/browser/fill.ts";
import { composeResume } from "../lib/render/resume.ts";
import { assembleTailoredDoc } from "../lib/render/tailoredDoc.ts";
import { renderResume } from "../lib/render/resumePdf.ts";
import { approvedArtifact } from "../lib/render/artifact.ts";
import { launchApplicationContext } from "../lib/browser/launch.ts";

const wanted = Number(process.argv[process.argv.indexOf("--jobs") + 1]) || 3;
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
// Tailoring is already validated in Stage 3; what is under test here is
// the fill path. --no-llm keeps runs fast and deterministic.
const llm = !process.argv.includes("--no-llm") && optional("ANTHROPIC_API_KEY")
  ? new AnthropicProvider() : null;

const paged = async (t: string, c: string, f: (q: any) => any = (q) => q, o = "id") => {
  const out: any[] = [];
  for (let x = 0; ; x += 500) {
    const { data, error } = await f(db.from(t).select(c)).order(o).range(x, x + 499);
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...data); if (data.length < 500) break;
  }
  return out;
};

// ---- the resume, rendered once ---------------------------------------
const runRoot = join(".fill-runs", `greenhouse-validation-${Date.now()}`);
await mkdir(runRoot, { recursive: true });
const { data: master } = await db.from("resumes").select("label").eq("is_master", true).single();
const pv = Number(String(master?.label ?? "").match(/profile version (\d+)/)?.[1] ?? 0);
const frozen = await paged("profile_version_rows", "row_id,source_table,row_data", (q) => q.eq("profile_version", pv), "row_id");
const { data: profile } = await db.from("profile").select("legal_first_name,legal_last_name,preferred_name").single();
const doc = composeResume(frozen as any,
  { first: profile!.legal_first_name, last: profile!.legal_last_name } as any,
  `${profile!.preferred_name ?? profile!.legal_first_name} ${profile!.legal_last_name}`);
// Validation renders the MASTER document to have a file to upload. Real
// runs never do this: they upload the approved artifact and nothing else.
const rendered = await renderResume(doc);
const pdfPath = join(runRoot, "Ty Pleban - Resume.pdf");
await writeFile(pdfPath, rendered.pdf);
console.log(`resume rendered for validation: ${pdfPath} (${rendered.pages} page(s), ${rendered.bytes} bytes)\n`);

// ---- pick Greenhouse jobs with no live application -------------------
const { data: liveApps } = await db.from("applications")
  .select("canonical_opening_id").not("status", "in", "(WITHDRAWN,ABANDONED,REJECTED)");
const taken = new Set((liveApps ?? []).map((a: any) => a.canonical_opening_id).filter(Boolean));

const chosen: any[] = [];
const seenCompany = new Set<string>();
for (let from = 0; chosen.length < wanted && from < 3000; from += 200) {
  const { data: jobs } = await db.from("jobs")
    .select("id,title,source,apply_url,company_id,canonical_opening_id,eligibility,status")
    .eq("source", "GREENHOUSE").eq("status", "OPEN").order("id").range(from, from + 199);
  if (!jobs?.length) break;
  for (const j of jobs) {
    if (chosen.length >= wanted) break;
    if (taken.has(j.canonical_opening_id) || seenCompany.has(j.company_id)) continue;
    const { data: co } = await db.from("companies").select("name,ats_token").eq("id", j.company_id).single();
    if (!co?.ats_token) continue;
    seenCompany.add(j.company_id);
    chosen.push({ ...j, company: co.name });
  }
}

// The same frozen evidence preparation used, so a control discovered
// only in the DOM is resolved by the same rules as everything else.
const resolveContext = await loadContext(db);

const created: string[] = [];
const results: any[] = [];
const context = await launchApplicationContext({ viewport: { width: 1440, height: 1000 } });

try {
  for (const job of chosen) {
    console.log(`\n=== ${job.company} — ${job.title}`);
    const { data: version } = await db.from("job_versions")
      .select("id").eq("job_id", job.id).eq("is_current", true).maybeSingle();
    if (!version) { console.log("  no current version"); continue; }

    const { data: draft, error: dErr } = await db.from("applications").insert({
      job_id: job.id, job_version_id: version.id,
      canonical_opening_id: job.canonical_opening_id,
      status: "DRAFT", submission_mode: "ASSISTED", is_test: true,
    }).select("id").single();
    if (dErr || !draft) { console.log(`  could not create: ${dErr?.message}`); continue; }
    created.push(draft.id);

    const prep = await prepareApplication(db, job.id, llm, draft.id);
    if (prep.refusedReason) { console.log(`  not prepared: ${prep.refusedReason}`); continue; }
    console.log(`  prepared: ${prep.answered} answered, ${prep.blocked} blocked`);

    const { data: app } = await db.from("applications")
      .select("form_snapshot,form_snapshot_hash").eq("id", draft.id).single();
    const answers: PreparedAnswer[] = (await paged("application_answers",
      "field_key,field_label,answer_text,confidence_state,is_required",
      (q) => q.eq("application_id", draft.id))).map((a) => ({
        fieldKey: a.field_key, fieldLabel: a.field_label, answer: a.answer_text,
        confidence: a.confidence_state, isRequired: a.is_required,
      }));

    const runDir = join(runRoot, job.id);
    const outcome = await fillApplication({
      db, context, applicationId: draft.id, provider: "GREENHOUSE",
      applyUrl: job.apply_url, storedHash: app?.form_snapshot_hash ?? null,
      storedFields: (app?.form_snapshot as any)?.fields ?? [],
      answers, resumePdfPath: pdfPath, runDir,
      resolveContext,
    });

    const g = outcome.guard as any;
    const guardHits = (g?.submitAttempts?.length ?? 0) + (g?.programmatic?.length ?? 0) + (g?.blockedRequests?.length ?? 0);
    console.log(`  ${outcome.reason}: ${outcome.message.slice(0, 110)}`);
    console.log(`  filled ${outcome.filled.length}, left blank ${outcome.leftBlank.length}, parser touched ${outcome.parserReconciliation.length}`);
    if (outcome.aliases.length) {
      console.log(`  aliases collapsed (one control, written once): ${outcome.aliases.map((a) => `${a.field}=${a.sameAs}`).join(", ")}`);
    }
    for (const i of outcome.inspections) {
      console.log(`  inspected "${i.field}": ${i.optionsFound} options e.g. ${JSON.stringify(i.sample)} -> ${i.resolvedAs}`);
    }
    console.log(`  submission guards: ${guardHits === 0 ? "nothing attempted" : `${guardHits} BLOCKED`}`);
    for (const f of outcome.filled.slice(0, 8)) console.log(`      ${f.field}: ${String(f.value).slice(0, 55)}`);
    results.push({ job: `${job.company} — ${job.title}`, outcome: outcome.reason,
      filled: outcome.filled.length, blank: outcome.leftBlank.length,
      parser: outcome.parserReconciliation, guardHits, screenshots: outcome.screenshots.length,
      aliases: outcome.aliases.length, inspections: outcome.inspections });
  }
} finally {
  await context.close().catch(() => undefined);
  for (const id of created) {
    const { error } = await db.rpc("purge_test_application", { p_id: id });
    if (error) console.log(`  cleanup failed for ${id}: ${error.message}`);
  }
  const { data: left } = await db.from("applications").select("id").eq("is_test", true);
  console.log(`\ntest applications remaining: ${left?.length ?? 0}`);
}

await writeFile(join(runRoot, "validation.json"), JSON.stringify(results, null, 2));
console.log(`\n=== summary ===`);
for (const r of results) {
  console.log(`  ${String(r.outcome).padEnd(28)} filled ${String(r.filled).padStart(2)}  blank ${String(r.blank).padStart(2)}  parser ${String(r.parser.length).padStart(2)}  guards ${r.guardHits}  ${r.job}`);
}
const anyGuard = results.some((r) => r.guardHits > 0);
console.log(`\n${anyGuard ? "FAIL: a submission guard fired" : "PASS: no submission was attempted in any run"}`);
