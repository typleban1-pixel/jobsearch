/**
 * Three experimental resume designs, against three real postings.
 *
 *   node scripts/render-finalists.ts [--no-llm]
 *
 * The question is not which PDF is prettiest. It is whether one visual
 * system can carry three genuinely different tailored narratives, and
 * whether it survives the document getting shorter, longer, or losing a
 * section entirely.
 *
 * Nothing here is production. The production renderer stays in place as
 * a labelled placeholder and is not touched.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { required, optional } from "../lib/env.ts";
import { AnthropicProvider } from "../lib/llm/anthropic.ts";
import { tailorBullets, type BulletSource } from "../lib/render/tailor.ts";
import { evidenceTextOf } from "../lib/render/evidenceText.ts";
import { composeResume, type ResumeDoc } from "../lib/render/resume.ts";
import { assembleTailoredDoc, documentLines, DEFAULT_BUDGET } from "../lib/render/tailoredDoc.ts";
import { contentHash } from "../lib/render/canonical.ts";
import * as A from "../lib/render/experimental/a-modern-minimal.ts";
import * as B from "../lib/render/experimental/b-structured.ts";
import * as C from "../lib/render/experimental/c-distinctive.ts";

const useLlm = !process.argv.includes("--no-llm") && Boolean(optional("ANTHROPIC_API_KEY"));
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const llm = useLlm ? new AnthropicProvider() : null;

const paged = async (t: string, c: string, f: (q: any) => any = (q) => q, o = "id", s = 500) => {
  const out: any[] = [];
  for (let x = 0; ; x += s) {
    const { data, error } = await f(db.from(t).select(c)).order(o).range(x, x + s - 1);
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...data); if (data.length < s) break;
  }
  return out;
};

const OUT = join(".fill-runs", `finalists-${Date.now()}`);
await mkdir(OUT, { recursive: true });

// ---- the frozen evidence everything is built from --------------------
const { data: master } = await db.from("resumes").select("id,label").eq("is_master", true).single();
const version = Number(String(master!.label).match(/profile version (\d+)/)?.[1] ?? 0);
const frozen = await paged("profile_version_rows", "row_id,source_table,row_data",
  (q) => q.eq("profile_version", version), "row_id");
const { data: profile } = await db.from("profile")
  .select("legal_first_name,legal_last_name,preferred_name").single();

const masterDoc: ResumeDoc = composeResume(frozen as any,
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

// ---- three real postings, one per narrative --------------------------
// Matched against real titles in the corpus, which say "Implementation
// Consultant" rather than "Implementation Manager". The first version of
// these patterns matched nothing at all.
const WANTED: Array<{ family: string; match: RegExp }> = [
  { family: "operations-implementation", match: /\b(implementation|operations)\b/i },
  { family: "marketing", match: /\b(marketing|lifecycle|brand|growth)\b/i },
  { family: "product-operations", match: /\bproduct (manager|operations)\b/i },
];

const scores = await paged("job_scores", "job_id,fit_score", (q) => q.eq("is_current", true), "job_id", 250);
const ranked = scores.sort((a, b) => b.fit_score - a.fit_score).slice(0, 200);
const chosen: Array<{ family: string; id: string; title: string; co: string; terms: string[] }> = [];

for (const want of WANTED) {
  for (const s of ranked) {
    if (chosen.some((c) => c.id === s.job_id)) continue;
    const { data: j } = await db.from("jobs")
      .select("id,title,company_id,status").eq("id", s.job_id).maybeSingle();
    if (!j || j.status !== "OPEN" || !want.match.test(j.title)) continue;
    const { data: co } = await db.from("companies").select("name").eq("id", j.company_id).maybeSingle();
    // requirement_class is computed at scoring time and is null on the
    // stored rows, so filtering on it discards every term. What is
    // wanted here is the posting's own vocabulary, whatever class the
    // classifier would later assign it.
    const reqs = await paged("job_requirements", "normalized_term", (q) => q.eq("job_id", j.id));
    const terms = reqs.map((r) => String(r.normalized_term ?? "")).filter(Boolean)
      .filter((t, i, a) => a.indexOf(t) === i).slice(0, 14);
    if (terms.length < 3) continue;
    chosen.push({ family: want.family, id: j.id, title: j.title, co: co?.name ?? "?", terms });
    break;
  }
}

console.log(`postings chosen (${chosen.length}):`);
for (const c of chosen) console.log(`  ${c.family.padEnd(26)} ${c.co} — ${c.title}`);
console.log(`tailoring: ${llm ? "model-assisted" : "master wording only"}\n`);

// ---- one tailored document per posting -------------------------------
interface Variant { label: string; family: string; doc: ResumeDoc; note: string }
const variants: Variant[] = [];

for (const c of chosen) {
  const roleContext = `${c.title}. Themes: ${c.terms.join(", ")}.`;
  const result = await tailorBullets(llm, sources, roleContext, { approvedMetrics, knownEntities });
  // One budget for all three designs, chosen so every design lands
  // inside two pages. Comparing at a shared content volume is the only
  // way a visual difference is attributable to the design rather than to
  // one template being handed less to carry.
  const { doc, dropped } = assembleTailoredDoc(
    masterDoc,
    result.accepted.map((a) => ({ original: a.original, claim: a.text, evidenceIds: a.evidenceIds, generation: a.generation })),
    c.terms,
  );
  variants.push({ label: `${c.family}`, family: c.family, doc,
    note: `${c.co} — ${c.title}; ${result.accepted.length} accepted, ${result.rejected.length} guard-refused, ${dropped.length} dropped for density` });
  console.log(`  ${c.family}: ${result.accepted.length} accepted, ${result.rejected.length} refused, ${dropped.length} dropped`);
}

// ---- robustness: the same design without a Selected Work section -----
const opsDoc = variants.find((v) => v.family === "operations-implementation")?.doc ?? variants[0]!.doc;
variants.push({ label: "operations-no-projects", family: "operations-implementation",
  doc: { ...opsDoc, projects: [] },
  note: "the same tailored content with Selected Work omitted entirely" });

// ---- render every variant through every design -----------------------
const DESIGNS = [
  { key: "A", name: A.RENDERER_NAME, render: A.render, html: A.renderHtml },
  { key: "B", name: B.RENDERER_NAME, render: B.render, html: B.renderHtml },
  { key: "C", name: C.RENDERER_NAME, render: C.render, html: C.renderHtml },
];

interface Row {
  design: string; variant: string; pages: number; bytes: number;
  chars: number; bullets: number; minPt: number; links: number;
  nameFirst: boolean; datesPresent: boolean; employersPresent: boolean;
  allClaims: boolean; contentHash: string; path: string;
}
const rows: Row[] = [];

console.log("\nrendering:");
for (const v of variants) {
  for (const d of DESIGNS) {
    const r = await d.render(v.doc);
    const path = join(OUT, `${d.key}-${v.label}.pdf`);
    await writeFile(path, r.pdf);

    const html = d.html(v.doc);
    const flat = r.extractedText.replace(/\s+/g, " ");
    const sizes = [...html.matchAll(/font-size:\s*([\d.]+)pt/g)].map((m) => Number(m[1]));
    const lines = documentLines(v.doc);

    rows.push({
      design: d.key, variant: v.label, pages: r.pages, bytes: r.bytes,
      chars: flat.length,
      bullets: v.doc.roles.reduce((n, x) => n + x.lines.length, 0),
      minPt: Math.min(...sizes),
      links: (html.match(/<a href="https?:/g) ?? []).length,
      nameFirst: flat.indexOf(v.doc.name) >= 0 && flat.indexOf(v.doc.name) < 40,
      datesPresent: v.doc.roles.every((x) => flat.includes(x.start.slice(0, 4))),
      employersPresent: v.doc.roles.every((x) => flat.includes(x.employer)),
      allClaims: lines.every((l) => flat.includes(l.replace(/\s+/g, " "))),
      contentHash: contentHash(v.doc).slice(0, 12),
      path,
    });
    console.log(`  ${d.key} ${v.label.padEnd(28)} ${r.pages}pp ${String(r.bytes).padStart(6)}b`);
  }
}

// ---- report -----------------------------------------------------------
console.log(`\n${"design".padEnd(7)}${"variant".padEnd(30)}${"pp".padStart(3)}${"bullets".padStart(9)}${"minPt".padStart(7)}${"links".padStart(7)}  name  dates  emp  claims`);
for (const r of rows) {
  console.log(
    `${r.design.padEnd(7)}${r.variant.padEnd(30)}${String(r.pages).padStart(3)}${String(r.bullets).padStart(9)}` +
    `${String(r.minPt).padStart(7)}${String(r.links).padStart(7)}` +
    `  ${r.nameFirst ? " ok " : "FAIL"}  ${r.datesPresent ? " ok " : "FAIL"}  ${r.employersPresent ? "ok " : "FAIL"}  ${r.allClaims ? "ok" : "FAIL"}`,
  );
}

const problems = rows.filter((r) => !r.nameFirst || !r.datesPresent || !r.employersPresent || !r.allClaims || r.minPt < 8);
console.log(`\nATS and readability problems: ${problems.length}`);
for (const p of problems) console.log(`  ${p.design} ${p.variant}: minPt=${p.minPt} name=${p.nameFirst} dates=${p.datesPresent} employers=${p.employersPresent} claims=${p.allClaims}`);

// Identical content across designs must produce an identical content
// hash: visual difference is not content difference.
const byVariant = new Map<string, Set<string>>();
for (const r of rows) byVariant.set(r.variant, (byVariant.get(r.variant) ?? new Set()).add(r.contentHash));
const contentStable = [...byVariant.values()].every((s) => s.size === 1);
console.log(`\ncontent hash identical across designs for each variant: ${contentStable ? "yes" : "NO"}`);

await writeFile(join(OUT, "comparison.json"), JSON.stringify({ chosen, variants: variants.map((v) => ({ label: v.label, note: v.note })), rows }, null, 2));
console.log(`\nartifacts: ${OUT}`);
