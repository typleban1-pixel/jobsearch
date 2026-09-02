/**
 * C, C2 and the A/C Hybrid on identical realistic content.
 *
 *   node scripts/render-c2.ts
 *
 * The primary comparison is visual only: one real posting, one grounded
 * tailored ResumeDoc, three renderers. Same claims, same wording, same
 * order, same links, same content hash. Anything that differs between
 * the three PDFs is presentation.
 *
 * Adaptability is then shown separately with Marketing and Product
 * documents, and C2 is rendered with and without the optional capability
 * line so its value can be judged rather than assumed.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { required, optional } from "../lib/env.ts";
import { AnthropicProvider } from "../lib/llm/anthropic.ts";
import { tailorBullets, type BulletSource } from "../lib/render/tailor.ts";
import { evidenceTextOf } from "../lib/render/evidenceText.ts";
import { composeResume, type ResumeDoc } from "../lib/render/resume.ts";
import { assembleTailoredDoc, documentLines, selectCapabilities } from "../lib/render/tailoredDoc.ts";
import { contentHash } from "../lib/render/canonical.ts";
import * as C from "../lib/render/experimental/c-distinctive.ts";
import * as C2 from "../lib/render/experimental/c2-refined.ts";
import * as H from "../lib/render/experimental/h-hybrid.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const llm = optional("ANTHROPIC_API_KEY") ? new AnthropicProvider() : null;
const paged = async (t: string, c: string, f: (q: any) => any = (q) => q, o = "id", s = 500) => {
  const out: any[] = [];
  for (let x = 0; ; x += s) {
    const { data, error } = await f(db.from(t).select(c)).order(o).range(x, x + s - 1);
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...data); if (data.length < s) break;
  }
  return out;
};

const OUT = join(".fill-runs", `c2-${Date.now()}`);
await mkdir(OUT, { recursive: true });

const { data: master } = await db.from("resumes").select("id,label").eq("is_master", true).single();
const version = Number(String(master!.label).match(/profile version (\d+)/)?.[1] ?? 0);
const frozen = await paged("profile_version_rows", "row_id,source_table,row_data",
  (q) => q.eq("profile_version", version), "row_id");
const { data: profile } = await db.from("profile").select("legal_first_name,legal_last_name,preferred_name").single();
const masterDoc = composeResume(frozen as any,
  { first: profile!.legal_first_name, last: profile!.legal_last_name } as any,
  `${profile!.preferred_name ?? profile!.legal_first_name} ${profile!.legal_last_name}`);

const text = new Map<string, string>();
for (const r of frozen) { const t = evidenceTextOf(r.source_table, r.row_data); if (t) text.set(r.row_id, t); }
const approvedMetrics = frozen.filter((r) => r.source_table === "metrics").map((r) => String(r.row_data.approved_wording));
const knownEntities = [
  ...frozen.filter((r) => r.source_table === "employment_records").map((r) => r.row_data.employer),
  ...frozen.filter((r) => r.source_table === "education").map((r) => r.row_data.institution),
  ...frozen.filter((r) => r.source_table === "skills").map((r) => r.row_data.name),
  ...frozen.filter((r) => r.source_table === "projects").map((r) => r.row_data.name),
].filter(Boolean) as string[];
const masterClaims = await paged("resume_claims", "claim,evidence_ids", (q) => q.eq("resume_id", master!.id));
const sources: BulletSource[] = masterClaims.map((c) => ({
  original: c.claim,
  evidence: (c.evidence_ids ?? []).filter((id: string) => text.has(id))
    .map((id: string) => ({ id, text: text.get(id)!, kind: "frozen_row" })),
})).filter((s) => s.evidence.length > 0);

async function tailoredFor(jobId: string, title: string) {
  const reqs = await paged("job_requirements", "normalized_term", (q) => q.eq("job_id", jobId));
  const terms = reqs.map((r) => String(r.normalized_term ?? "")).filter(Boolean)
    .filter((t, i, a) => a.indexOf(t) === i).slice(0, 14);
  const result = await tailorBullets(llm, sources, `${title}. Themes: ${terms.join(", ")}.`,
    { approvedMetrics, knownEntities });
  const { doc, dropped } = assembleTailoredDoc(masterDoc,
    result.accepted.map((a) => ({ original: a.original, claim: a.text, evidenceIds: a.evidenceIds, generation: a.generation })),
    terms);
  // Employer-facing capabilities replace the full inventory on the
  // document itself, so the renderer never sees what it must not print.
  const skillGroups = selectCapabilities(doc, terms, title);
  return { doc: { ...doc, skillGroups }, dropped, accepted: result.accepted.length, rejected: result.rejected.length };
}

// ---- one real posting for the primary comparison ---------------------
const pick = async (re: RegExp) => {
  const scores = await paged("job_scores", "job_id,fit_score", (q) => q.eq("is_current", true), "job_id", 250);
  for (const s of scores.sort((a, b) => b.fit_score - a.fit_score).slice(0, 200)) {
    const { data: j } = await db.from("jobs").select("id,title,company_id,status").eq("id", s.job_id).maybeSingle();
    if (!j || j.status !== "OPEN" || !re.test(j.title)) continue;
    const { count } = await db.from("job_requirements").select("id", { count: "exact", head: true }).eq("job_id", j.id);
    if ((count ?? 0) < 5) continue;
    const { data: co } = await db.from("companies").select("name").eq("id", j.company_id).maybeSingle();
    return { id: j.id, title: j.title, co: co?.name ?? "?" };
  }
  return null;
};

const primary = await pick(/\b(implementation|operations)\b/i);
const marketing = await pick(/\b(marketing|brand|lifecycle|growth)\b/i);
const product = await pick(/\bproduct (manager|operations)\b/i);
if (!primary) throw new Error("no primary posting found");

console.log(`primary: ${primary.co} — ${primary.title}`);
const P = await tailoredFor(primary.id, primary.title);
console.log(`  ${P.accepted} accepted, ${P.rejected} refused, ${P.dropped.length} dropped`);
console.log(`  capability groups kept: ${P.doc.skillGroups.map((g) => g.label).join(", ") || "(none)"}`);

const bullets = (d: ResumeDoc) => d.roles.reduce((n, r) => n + r.lines.length, 0);
const lines = documentLines(P.doc);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const dupes = lines.filter((l, i) => lines.findIndex((x) => norm(x) === norm(l)) !== i);
console.log(`  ${bullets(P.doc)} bullets across ${P.doc.roles.length} roles, ${P.doc.projects.length} project(s), duplicates: ${dupes.length}`);

// ---- render ----------------------------------------------------------
interface Row { name: string; file: string; pages: number; bytes: number; minPt: number; bodyPt: number; namePt: number; ok: boolean; note: string }
const rows: Row[] = [];

const check = async (label: string, file: string, r: any, html: string, doc: ResumeDoc) => {
  const flat = r.extractedText.replace(/\s+/g, " ").toLowerCase();
  const sizes = [...html.matchAll(/font-size:\s*([\d.]+)pt/g)].map((m) => Number(m[1]));
  const body = Number(html.match(/body\s*\{[^}]*font-size:\s*([\d.]+)pt/)?.[1] ?? 0);
  const nm = Number(html.match(/\.name\s*\{[^}]*font-size:\s*([\d.]+)pt/)?.[1] ?? 0);
  const dl = documentLines(doc);
  const occurrences = (n: string) => { let c = 0, i = 0; while ((i = flat.indexOf(n, i)) !== -1) { c++; i += n.length; } return c; };
  // Both sides normalized the same way. Comparing a lowercased haystack
  // against raw needles reported every employer as missing.
  const problems: string[] = [];
  if (flat.indexOf(norm(doc.name)) > 40) problems.push("name not first");
  for (const role of doc.roles) {
    if (!flat.includes(norm(role.employer))) problems.push(`employer missing: ${role.employer}`);
    if (!flat.includes(norm(role.title))) problems.push(`title missing: ${role.title}`);
    if (!flat.includes(role.start.slice(0, 4))) problems.push(`date missing: ${role.start.slice(0, 4)}`);
  }
  for (const l of dl) {
    if (!flat.includes(norm(l))) problems.push(`claim missing: ${l.slice(0, 40)}`);
    if (occurrences(norm(l)) > dl.filter((x) => norm(x) === norm(l)).length) problems.push(`claim duplicated: ${l.slice(0, 40)}`);
  }
  if (Math.min(...sizes) < 8) problems.push(`type below 8pt: ${Math.min(...sizes)}`);
  if ((html.match(/<a href="https?:/g) ?? []).length === 0) problems.push("no hyperlinks");
  await writeFile(join(OUT, file), r.pdf);
  rows.push({ name: label, file, pages: r.pages, bytes: r.bytes, minPt: Math.min(...sizes), bodyPt: body, namePt: nm,
    ok: problems.length === 0, note: problems.slice(0, 2).join("; ") });
};

await check("C  (original)", "1-C-original.pdf", await C.render(P.doc), C.renderHtml(P.doc), P.doc);
await check("C2 (no capability line)", "2-C2-plain.pdf", await C2.render(P.doc), C2.renderHtml(P.doc), P.doc);
await check("C2 (capability line: DISABLED, kept for reference)", "3-C2-capabilities-DISABLED.pdf", await C2.render(P.doc), C2.renderHtml(P.doc), P.doc);
await check("A/C Hybrid", "4-hybrid.pdf", await H.render(P.doc), H.renderHtml(P.doc), P.doc);

// ---- adaptability -----------------------------------------------------
for (const [label, posting] of [["marketing", marketing], ["product", product]] as const) {
  if (!posting) { console.log(`\n(no ${label} posting found)`); continue; }
  const T = await tailoredFor(posting.id, posting.title);
  console.log(`\n${label}: ${posting.co} — ${posting.title}`);
  console.log(`  capability groups kept: ${T.doc.skillGroups.map((g) => g.label).join(", ") || "(none)"}`);
  console.log(`  ${bullets(T.doc)} bullets, ${T.doc.projects.length} project(s)`);
  await check(`C2 (${label})`, `5-C2-${label}.pdf`, await C2.render(T.doc), C2.renderHtml(T.doc), T.doc);
  if (label === "product") {
    const noProj: ResumeDoc = { ...T.doc, projects: [] };
    await check("C2 (product, no Selected Work)", "6-C2-product-no-projects.pdf",
      await C2.render(noProj), C2.renderHtml(noProj), noProj);
  }
}

console.log(`\n${"design".padEnd(30)}${"pp".padStart(3)}${"body".padStart(7)}${"name".padStart(7)}${"min".padStart(6)}   checks`);
for (const r of rows) {
  console.log(`${r.name.padEnd(30)}${String(r.pages).padStart(3)}${String(r.bodyPt).padStart(7)}${String(r.namePt).padStart(7)}${String(r.minPt).padStart(6)}   ${r.ok ? "ok" : "FAIL " + r.note}`);
}
const hashes = new Set([contentHash(P.doc)]);
console.log(`\nprimary comparison content hash: ${[...hashes][0]!.slice(0, 16)} (identical for C, C2 and Hybrid: only the renderer differs)`);
console.log(`artifacts: ${OUT}`);
