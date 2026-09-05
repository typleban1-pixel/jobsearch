/**
 * Stage 3 validation, against real current postings.
 *
 *   node scripts/validate-stage3.ts            no model, master wording only
 *   node scripts/validate-stage3.ts --live     model-assisted tailoring
 *
 * Nothing is written. This runs the real preparation path — real form
 * snapshots fetched from the employer's ATS, real tailoring, real
 * grounding checks, real question mapping — and reports what happened,
 * without creating applications that would then have to be withdrawn.
 *
 * The pass condition is zero unsupported employer-facing claims
 * surviving. Every accepted claim is re-checked here independently of
 * the tailoring path that produced it: the grounding checks are run
 * again, the fifteen claim guards are run over the assembled document,
 * and every cited evidence id is confirmed present in the frozen profile
 * version. A claim that survives all three is supported; anything else
 * is reported, and the count of the latter is the number that matters.
 */
import { createClient } from "@supabase/supabase-js";
import { classifyRequirement } from "../lib/scoring/requirementClass.ts";
import { readFileSync } from "node:fs";
import { required, optional } from "../lib/env.ts";
import { AnthropicProvider } from "../lib/llm/anthropic.ts";
import { tailorBullets, type BulletSource } from "../lib/render/tailor.ts";
import { checkGrounding } from "../lib/render/grounding.ts";
import { checkClaims } from "../lib/render/claimGuards.ts";
import { evidenceTextOf } from "../lib/render/evidenceText.ts";
import { snapshotForm } from "../lib/applications/formSnapshot.ts";
import { resolveField, shouldSkip, type BankedAnswer, type BankProvenance,
         type FormField, type ResolveContext } from "../lib/applications/answer.ts";
import { matchIntent } from "../lib/applications/intents.ts";

const live = process.argv.includes("--live");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const llm = live && optional("ANTHROPIC_API_KEY") ? new AnthropicProvider() : null;

async function paged<T>(table: string, cols: string, f: (q: any) => any = (q) => q, order = "id", step = 500): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += step) {
    const { data, error } = await f(db.from(table).select(cols)).order(order).range(from, from + step - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as T[]));
    if ((data as T[]).length < step) break;
  }
  return out;
}

// ---- the frozen profile everything is judged against -----------------
const { data: master } = await db.from("resumes").select("id,label").eq("is_master", true).single();
if (!master) throw new Error("no master resume");
const profileVersion = Number(String(master.label).match(/profile version (\d+)/)?.[1] ?? 0);

const frozen = await paged<any>("profile_version_rows", "row_id,source_table,row_data",
  (q) => q.eq("profile_version", profileVersion), "row_id");
const frozenIds = new Set(frozen.map((r) => r.row_id as string));
const text = new Map<string, string>();
for (const r of frozen) {
  const t = evidenceTextOf(r.source_table, r.row_data);
  if (t) text.set(r.row_id, t);
}
const approvedMetrics = frozen.filter((r) => r.source_table === "metrics").map((r) => String(r.row_data.approved_wording));
const knownEntities = [
  ...frozen.filter((r) => r.source_table === "employment_records").map((r) => r.row_data.employer),
  ...frozen.filter((r) => r.source_table === "education").map((r) => r.row_data.institution),
  ...frozen.filter((r) => r.source_table === "skills").map((r) => r.row_data.name),
  ...frozen.filter((r) => r.source_table === "projects").map((r) => r.row_data.name),
  "Cleveland Clinic", "Amazon", "Sportsman Network", "Adobe Creative Suite", "Leavitt School of Health",
].filter(Boolean) as string[];

const masterClaims = await paged<any>("resume_claims", "claim,evidence_ids", (q) => q.eq("resume_id", master.id));
const sources: BulletSource[] = masterClaims.map((c) => ({
  original: c.claim,
  evidence: (c.evidence_ids ?? []).filter((id: string) => text.has(id))
    .map((id: string) => ({ id, text: text.get(id)!, kind: "frozen_row" })),
})).filter((s) => s.evidence.length > 0);

const profileRow = frozen.find((r) => r.source_table === "profile");
if (!profileRow) throw new Error("no frozen profile row");
// A second copy of the bank loader in prepare.ts. It must select
// answer_provenance for the same reason that one does: without it every
// banked answer here would resolve at a confidence the resolver no
// longer grants, and this script would be validating a system that does
// not exist.
const bank = new Map<string, BankedAnswer>();
for (const b of await paged<any>("question_bank", "intent_key,approved_answer,evidence_ids,reuse_allowed,answer_provenance",
  (q) => q.eq("reuse_allowed", true).not("approved_answer", "is", null))) {
  bank.set(b.intent_key, { answer: b.approved_answer, evidenceIds: b.evidence_ids ?? [],
    provenance: (b.answer_provenance ?? null) as BankProvenance | null });
}
const employment = frozen.filter((r) => r.source_table === "employment_records")
  .map((r) => ({
    rowId: r.row_id, employer: r.row_data.employer,
    title: r.row_data.actual_title ?? r.row_data.display_title ?? null,
    isCurrent: Boolean(r.row_data.is_current), start: r.row_data.start_month ?? null,
  }))
  .sort((a, b) => String(b.start ?? "").localeCompare(String(a.start ?? "")));
const ctx: ResolveContext = { profileRowId: profileRow.row_id, profile: profileRow.row_data, bank, employment };

// ---- the jobs --------------------------------------------------------
const picked: Array<{ id: string; title: string; co: string }> =
  JSON.parse(readFileSync("/private/tmp/claude-501/-Users-plebant/bbd705c3-ed87-4c9b-9ffc-d255f95eb993/scratchpad/validation-set.json", "utf8"));
const extraIds: string[] = JSON.parse(process.env.EXTRA_JOB_IDS ?? "[]");
const allIds = [...picked.map((p) => p.id), ...extraIds];

// ---- accumulators ----------------------------------------------------
const stats = {
  applications: 0, resumes: 0,
  byProvider: {} as Record<string, number>,
  byFamily: {} as Record<string, number>,
  snapshotRefused: [] as string[],
  proposed: 0, reframedAccepted: 0, fallbackUsed: 0,
  rejectedByGuard: {} as Record<string, number>,
  unsupportedSurviving: [] as string[],
  legitimateBlocked: [] as string[],
  provenanceFailures: [] as string[],
  fields: 0, required: 0,
  VERIFIED: 0, DERIVED: 0, HUMAN_CONFIRMED: 0, LOW_STAKES_SURVEY: 0, BLOCKED: 0,
  blockUNKNOWN: 0, blockAMBIGUOUS: 0,
  refusedFields: 0, skipped: 0,
  intentFailures: [] as string[],
  falseConfidence: [] as string[],
  unnecessaryBlocks: [] as string[],
  perJobResumes: [] as Array<{ label: string; family: string; lines: string[] }>,
};

const family = (title: string): string => {
  const t = title.toLowerCase();
  if (/engineer|developer|software/.test(t)) return "engineering";
  if (/design/.test(t)) return "design";
  if (/product manager|product management/.test(t)) return "product";
  if (/market/.test(t)) return "marketing";
  if (/legal|counsel|compliance/.test(t)) return "legal";
  if (/recruit|talent/.test(t)) return "talent";
  if (/account|financ|receivable/.test(t)) return "finance";
  if (/success|implementation|client/.test(t)) return "customer";
  if (/program|project|operations|strategy/.test(t)) return "operations";
  return "other";
};

for (const jobId of allIds) {
  const { data: job } = await db.from("jobs")
    .select("id,title,source,external_id,company_id").eq("id", jobId).maybeSingle();
  if (!job) continue;
  const { data: co } = await db.from("companies").select("name,ats_token").eq("id", job.company_id).single();
  const { data: version } = await db.from("job_versions").select("id,title")
    .eq("job_id", jobId).eq("is_current", true).maybeSingle();
  if (!version) continue;

  stats.applications++;
  stats.byProvider[job.source] = (stats.byProvider[job.source] ?? 0) + 1;
  const fam = family(job.title);
  stats.byFamily[fam] = (stats.byFamily[fam] ?? 0) + 1;
  const label = `${co?.name} — ${job.title}`;

  // -- role context: themes only, never the posting's prose -----------
  // requirement_class is null on every stored row; classification is
  // computed. Filtering on the column discarded every term here too.
  const reqs = await paged<any>("job_requirements", "normalized_term,raw_text", (q) => q.eq("job_id", jobId));
  const siblings = reqs.map((r: any) => String(r.normalized_term ?? ""));
  const terms = reqs.filter((r: any) => r.normalized_term
      && classifyRequirement(String(r.raw_text ?? ""), String(r.normalized_term), siblings).requirementClass === "SKILL")
    .map((r) => String(r.normalized_term)).filter((t, i, a) => a.indexOf(t) === i).slice(0, 12);
  const roleContext = terms.length ? `${job.title}. Themes: ${terms.join(", ")}.` : job.title;

  // -- the tailored resume --------------------------------------------
  const result = await tailorBullets(llm, sources, roleContext, { approvedMetrics, knownEntities });
  stats.resumes++;
  stats.proposed += result.accepted.length + result.rejected.length;
  stats.reframedAccepted += result.accepted.filter((a) => a.generation === "REFRAMED").length;
  stats.fallbackUsed += result.fellBack;
  for (const r of result.rejected) {
    stats.rejectedByGuard[r.failedCheck] = (stats.rejectedByGuard[r.failedCheck] ?? 0) + 1;
    // A rejected line that the master resume itself uses verbatim is a
    // legitimate claim the guards refused, which is worth separating
    // from a model invention.
    if (masterClaims.some((m) => m.claim === r.proposed)) {
      stats.legitimateBlocked.push(`${label}: ${r.proposed.slice(0, 90)} [${r.failedCheck}]`);
    }
  }

  // -- independent re-check of everything that survived ---------------
  for (const a of result.accepted) {
    const missing = a.evidenceIds.filter((id) => !frozenIds.has(id));
    if (missing.length || a.evidenceIds.length === 0) {
      stats.provenanceFailures.push(`${label}: "${a.text.slice(0, 70)}" cites ${a.evidenceIds.length} rows, ${missing.length} not in version ${profileVersion}`);
    }
    const src = a.evidenceIds.filter((id) => text.has(id)).map((id) => text.get(id)!).join(" ");
    const recheck = checkGrounding({ claim: a.text, evidenceIds: a.evidenceIds, sourceText: src, approvedMetrics, knownEntities });
    if (!recheck.ok) {
      stats.unsupportedSurviving.push(`${label}: [${recheck.failedCheck}] ${a.text.slice(0, 90)} — ${recheck.failureDetail}`);
    }
  }
  // The claim guards, over the assembled document rather than line by line.
  const document = result.accepted.map((a) => a.text).join("\n");
  for (const v of checkClaims(document)) {
    stats.unsupportedSurviving.push(`${label}: [CLAIM_GUARD ${v.subject}] "${v.matched}"`);
  }
  if (/[—]/.test(document)) stats.unsupportedSurviving.push(`${label}: em dash in employer-facing text`);

  stats.perJobResumes.push({ label, family: fam, lines: result.accepted.map((a) => a.text) });

  // -- the employer's form --------------------------------------------
  const snap = await snapshotForm(job.source, co?.ats_token ?? null, job.external_id);
  if (!snap.ok) { stats.snapshotRefused.push(`${label} [${job.source}]: ${snap.reason}`); continue; }

  for (const field of snap.snapshot.fields as FormField[]) {
    if (shouldSkip(field)) { stats.skipped++; continue; }
    if (matchIntent(field.label).intent?.key === "resume_upload") {
      stats.fields++; if (field.required) stats.required++;
      stats.DERIVED++; continue;
    }
    const r = resolveField(field, ctx);
    stats.fields++;
    if (field.required) stats.required++;
    stats[r.confidence]++;
    if (r.refused) stats.refusedFields++;
    if (r.confidence === "BLOCKED") {
      if (r.blockKind === "AMBIGUOUS") stats.blockAMBIGUOUS++; else stats.blockUNKNOWN++;
      if (!r.intentKey) stats.intentFailures.push(`${label}: ${field.label.slice(0, 80)}`);
      // A blocked field whose intent maps to a plain profile column
      // would be an unnecessary block.
      const k = matchIntent(field.label).intent?.key;
      // An "unnecessary" block means the profile HAS the value and it was
      // still blocked. A column the profile genuinely leaves empty is a
      // correct block, and counting it here would manufacture a defect.
      const column: Record<string, string> = {
        legal_first_name: "legal_first_name", legal_last_name: "legal_last_name",
        email: "email_job_search", phone: "phone", city: "city", state: "state",
        postal_code: "postal_code", country: "country",
      };
      const col = k ? column[k] : undefined;
      if (col && ctx.profile[col]) {
        stats.unnecessaryBlocks.push(`${label}: ${field.label.slice(0, 60)} blocked although the profile has ${col} (${r.blockedReason})`);
      }
    } else {
      // False confidence: a non-blocked state that cites nothing, or a
      // sensitive question answered without a stored preference.
      if ((r.confidence === "VERIFIED" || r.confidence === "DERIVED") && r.evidenceIds.length === 0) {
        stats.falseConfidence.push(`${label}: ${field.label} is ${r.confidence} citing no evidence`);
      }
      const intent = matchIntent(field.label).intent;
      if (intent?.category === "D_SENSITIVE" && !bank.has(intent.key)) {
        stats.falseConfidence.push(`${label}: sensitive field "${field.label}" answered without a stored preference`);
      }
      if (r.refused) stats.falseConfidence.push(`${label}: refused field "${field.label}" was answered`);
    }
  }
}

// ---- report ----------------------------------------------------------
const line = (k: string, v: unknown) => console.log(`  ${String(k).padEnd(46)} ${v}`);
console.log(`\nStage 3 validation  (tailoring: ${llm ? "model-assisted" : "master wording only"})\n`);
line("applications prepared", stats.applications);
line("ATS providers", JSON.stringify(stats.byProvider));
line("job families", JSON.stringify(stats.byFamily));
line("resumes generated", stats.resumes);
console.log();
line("claims proposed", stats.proposed);
line("model-reframed claims accepted", stats.reframedAccepted);
line("master/fallback claims used", stats.fallbackUsed);
line("claims rejected by a guard", Object.values(stats.rejectedByGuard).reduce((a, b) => a + b, 0));
for (const [g, n] of Object.entries(stats.rejectedByGuard).sort((a, b) => b[1] - a[1])) line(`    ${g}`, n);
console.log();
line("UNSUPPORTED CLAIMS SURVIVING", stats.unsupportedSurviving.length);
line("legitimate claims blocked", stats.legitimateBlocked.length);
line("provenance failures", stats.provenanceFailures.length);
console.log();
line("form fields encountered", stats.fields);
line("  of which required", stats.required);
line("VERIFIED", stats.VERIFIED);
line("DERIVED", stats.DERIVED);
line("HUMAN_CONFIRMED", stats.HUMAN_CONFIRMED);
line("BLOCKED", stats.BLOCKED);
line("    UNKNOWN", stats.blockUNKNOWN);
line("    AMBIGUOUS", stats.blockAMBIGUOUS);
line("fields refused outright (never filled)", stats.refusedFields);
line("optional cover letters skipped", stats.skipped);
console.log();
line("intent-matching failures", stats.intentFailures.length);
line("false-confidence findings", stats.falseConfidence.length);
line("unnecessary blocks", stats.unnecessaryBlocks.length);
line("forms not snapshottable", stats.snapshotRefused.length);

const show = (title: string, xs: string[], n = 6) => {
  if (!xs.length) return;
  console.log(`\n${title}:`);
  for (const x of xs.slice(0, n)) console.log(`  ${x}`);
  if (xs.length > n) console.log(`  ...and ${xs.length - n} more`);
};
show("UNSUPPORTED CLAIMS SURVIVING", stats.unsupportedSurviving, 20);
show("legitimate claims blocked by a guard", stats.legitimateBlocked, 10);
show("provenance failures", stats.provenanceFailures, 10);
show("intent-matching failures", stats.intentFailures, 10);
show("false-confidence findings", stats.falseConfidence, 10);
show("unnecessary blocks", stats.unnecessaryBlocks, 10);
show("forms not snapshottable", stats.snapshotRefused, 10);

// Same profile, different roles: the point is that these differ.
console.log("\nsame verified profile, different job families:");
const byFam = new Map<string, { label: string; lines: string[] }>();
for (const r of stats.perJobResumes) if (!byFam.has(r.family)) byFam.set(r.family, r);
for (const [fam, r] of [...byFam].slice(0, 4)) {
  console.log(`\n  [${fam}] ${r.label}`);
  for (const l of r.lines.slice(1, 4)) console.log(`     ${l.slice(0, 150)}`);
}

console.log(`\n${stats.unsupportedSurviving.length === 0 ? "PASS" : "FAIL"}: ${stats.unsupportedSurviving.length} unsupported employer-facing claims survived`);
