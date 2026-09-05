/**
 * Resume Builder v2: inert NORTHERN TRUST ACCEPTANCE run, from REAL v17 truth.
 * Reads the frozen v17 profile snapshot (verified skills, incl. "Managing
 * concurrent priorities") + the persisted master-résumé per-line `capabilities`
 * provenance (skill IDs authored in v17) + finalized evidenceMap/NarrativePlan/
 * coverageSelect/summaryPlan + authoritative checkGrounding + renderer.
 *
 * No stagedV17 fixture, no bulletTag, no text-signature coverage: every bullet's
 * theme coverage is derived structurally from its persisted capability IDs
 * resolved to verified v17 skill names through the evidence map. Reframing is
 * PASSTHROUGH (actual reframing needs LLM calls -- reported, not spent). No DB
 * writes, no wiring.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { writeFileSync } from "node:fs";
import { themesFromV2 } from "../lib/applications/themesV2.ts";
import { mapThemesToEvidence, type VerifiedPool, type EvidenceItem } from "../lib/render/evidenceMap.ts";
import { buildNarrativePlan } from "../lib/render/narrativePlan.ts";
import { coverageSelect, type Candidate, type ProjectSpec, type ThemeValues } from "../lib/render/coverageSelect.ts";
import { buildSummary, type MetricPhrase } from "../lib/render/summaryPlan.ts";
import { checkGrounding } from "../lib/render/grounding.ts";
import { renderMarkdown, type ResumeDoc } from "../lib/render/resume.ts";
import { renderResume } from "../lib/render/resumePdf.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const pageAll = async (t: string, r: (q: any) => any = (q) => q) => { const o: any[] = []; for (let f = 0; ; f += 1000) { const { data } = await r(db.from(t).select("*")).range(f, f + 999); o.push(...(data ?? [])); if (!data || data.length < 1000) break; } return o; };
const NT = [["project coordination", "project planning, coordination, and implementation", "HARD", "SKILL"], ["communication skills", "written, verbal, and presentation communication", "HARD", "SKILL"], ["problem-solving", "Analytical mindset with problem-solving", "HARD", "SKILL"], ["multitasking", "manage multiple projects and priorities simultaneously", "HARD", "SKILL"], ["collaboration", "work effectively across teams", "HARD", "SKILL"], ["microsoft office", "Microsoft PowerPoint, Excel, and Word", "HARD", "TOOL"], ["cross-functional project experience", "cross-functional projects and business initiatives", "PREFERRED", "EXPERIENCE_YEARS"], ["financial services experience", "financial services, wealth management", "PREFERRED", "EXPERIENCE_YEARS"], ["power bi", "Power BI", "PREFERRED", "TOOL"], ["crm platforms", "CRM platforms", "PREFERRED", "TOOL"], ["process improvement", "process improvements and new business initiatives", "HARD", "RESPONSIBILITY"], ["executive reporting", "presentations and executive reporting for leadership", "HARD", "RESPONSIBILITY"], ["milestone tracking", "Track project milestones, risks, and dependencies", "HARD", "RESPONSIBILITY"]].map(([normalized_term, raw_text, is_hard_requirement, kind]) => ({ normalized_term, raw_text, is_hard_requirement, kind }));

// ---- REAL v17 truth snapshot ----
const rows = await pageAll("profile_version_rows", (q) => q.eq("profile_version", 17));
const bySrc: Record<string, any[]> = {}; for (const r of rows) (bySrc[r.source_table] = bySrc[r.source_table] || []).push(r.row_data);
const skillId = new Map((bySrc.skills ?? []).map((s: any) => [s.name, s.id]));   // name -> id (display)
const idName = new Map((bySrc.skills ?? []).map((s: any) => [s.id, s.name]));    // id -> name (provenance resolve)
const items: EvidenceItem[] = []; const skillNames: string[] = []; const vocab: string[] = [];
for (const s of bySrc.skills ?? []) { items.push({ ref: s.id ?? s.name, source: "skills", text: s.name ?? "" }); skillNames.push(s.name ?? ""); vocab.push(s.name ?? ""); }
for (const e of bySrc.evidence ?? []) { const t = `${e.detail ?? ""} ${e.summary ?? ""}`.trim(); items.push({ ref: e.id, source: "evidence", text: t }); vocab.push(t); }
const { data: mr } = await db.from("resumes").select("content").eq("is_master", true).ilike("label", "%version 16%").maybeSingle();
const doc0: ResumeDoc = (mr?.content as any).doc;
if ((mr?.content as any)?.markdown) { items.push({ ref: "master-md", source: "master", text: (mr?.content as any).markdown }); vocab.push((mr?.content as any).markdown); }
const pool: VerifiedPool = { items, skillNames: skillNames.filter(Boolean) };
const profileVocabulary = vocab.join(" \n ");
const srcOf = new Map<string, string[]>();
for (const role of doc0.roles) for (const l of role.lines) srcOf.set(l.text, l.sources ?? []);
for (const o of [doc0.projects[0]!.line, ...(doc0.projects[0]!.optional ?? [])]) srcOf.set(o.text, (o as any).sources ?? []);

// PERSISTED provenance: each line carries capability skill IDs (v17). Resolve to
// verified skill names. This is the ONLY source of per-bullet capabilities --
// no text-signature matching, no fixture.
const capsForLine = (line: any): string[] => ((line?.capabilities ?? []) as string[]).map((id) => idName.get(id)).filter(Boolean) as string[];

const themes = themesFromV2(NT, "Northern Trust").themes;
const plan = buildNarrativePlan(themes, mapThemesToEvidence(themes, pool), "Northern Trust");
const COV: Record<string, number> = { DIRECT: 1, TRANSFERABLE: 0.6, WEAK: 0, NONE: 0 };
const values: ThemeValues = {}; for (const t of plan.themes) values[t.id] = t.weight * (COV[t.coverage] ?? 0);
const themeTerms = plan.themes.map((t) => ({ term: t.id }));
const idxFor = (caps: string[]) => mapThemesToEvidence(themeTerms, { items: caps.map((n) => ({ ref: n, source: "skills", text: n })), skillNames: caps });
const covOf = (caps: string[]) => { if (!caps.length) return {} as Record<string, string>; const idx = idxFor(caps); const o: Record<string, string> = {}; for (const t of plan.themes) { const c = idx.byTheme.get(t.id)?.coverage; if (c === "DIRECT" || c === "TRANSFERABLE") o[t.id] = c; } return o; };
const density = (caps: string[]) => { if (!caps.length) return 1; const idx = idxFor(caps); const s = new Set<string>(); for (const t of plan.themes) { const c = idx.byTheme.get(t.id); if (c && (c.coverage === "DIRECT" || c.coverage === "TRANSFERABLE")) for (const e of c.evidence) s.add(e.ref); } return s.size / caps.length; };
const quant = (t: string) => /\b\d[\d,]*\b|\$|%/.test(t);

const emp: Candidate[] = [];
for (const role of doc0.roles) for (const l of role.lines) { const caps = capsForLine(l); emp.push({ id: l.text, text: l.text, owner: { kind: "employment", entryId: role.employer, label: role.employer }, themes: Object.keys(covOf(caps)), quantitative: quant(l.text), spaceCost: 1, density: density(caps) }); }
const rp = doc0.projects[0]!;
const projects: ProjectSpec[] = [{ id: "rentpup", label: "RentPup", purpose: { text: rp.line.text, themes: Object.keys(covOf(capsForLine(rp.line))), density: density(capsForLine(rp.line)) }, traction: { text: rp.optional?.[0]?.text ?? "", themes: Object.keys(covOf(capsForLine(rp.optional?.[0]))), quantitative: true, density: density(capsForLine(rp.optional?.[0])) }, execution: (rp.optional ?? []).slice(1).map((o: any) => { const caps = capsForLine(o); return { id: o.text, text: o.text, owner: { kind: "project", entryId: "rentpup", label: "RentPup" }, themes: Object.keys(covOf(caps)), quantitative: quant(o.text), spaceCost: 1, density: density(caps) }; }) }];
const selection = coverageSelect(emp, projects, values, { totalBullets: 12, perEmployment: 3, perProject: 4 });

// Compact, standalone grounded metric phrases (composition-layer summary
// candidates, NOT profile truth). Each names one verified number; themes are
// derived structurally via covOf. None strengthens a PRIMARY coordination theme
// for NT, so the NT summary carries no metric -- proven, not assumed.
const METRICS_LOCAL: { phrase: string; capabilities: string[] }[] = [
  { phrase: "Grew a marketing email audience to approximately 180,000 contacts.", capabilities: ["Email marketing", "Marketing funnel design", "Audience segmentation"] },
  { phrase: "Helped launch an education offering that reached over $70,000 in annual recurring revenue.", capabilities: ["Launching a new offering"] },
  { phrase: "Taught and mentored 250+ students.", capabilities: ["Teaching and mentoring"] },
];
const metrics: MetricPhrase[] = METRICS_LOCAL.map((m) => ({ phrase: m.phrase, themes: Object.keys(covOf(m.capabilities)) }));
const summary = buildSummary(plan, selection, metrics);

const sel = new Set(selection.selected.map((s) => s.text));
const v2: ResumeDoc = JSON.parse(JSON.stringify(doc0));
v2.summary = { text: summary.text, sources: [] } as any;
for (const role of v2.roles) role.lines = role.lines.filter((l: any) => sel.has(l.text));
v2.projects = selection.projectsSelected.includes("rentpup") ? v2.projects : [];
const order = ["Operations and process", "Product development", "Marketing and ecommerce", "Technical", "Creative production"];
v2.skillGroups.sort((a: any, b: any) => order.indexOf(a.label) - order.indexOf(b.label));
writeFileSync("/tmp/nt-v2-resume.md", renderMarkdown(v2));
let pages = 0; try { const r = await renderResume(v2); writeFileSync("/tmp/nt-v2-resume.pdf", r.pdf); pages = r.pages; } catch (e) { console.log("PDF FAIL", e); }

const reframeCalls = v2.roles.flatMap((r: any) => r.lines).length + v2.projects.flatMap((p: any) => [p.line, ...(p.optional ?? [])]).length;
console.log(`REAL v17: verified skills in pool = ${skillNames.filter(Boolean).length} (incl. "${idName.get("6a8dc7ce-d245-4bfd-803e-2ea25118e2d2") ?? "?"}")`);
console.log(`REFRAMING: actual V2 reframing requires ${reframeCalls} Haiku (fast-tier) calls, one per rendered claim. Est ~$0.01-0.02 total. NOT SPENT -- passthrough (verified master wording) used.\n`);
console.log("===== EMPLOYER / TITLE / DATES =====");
for (const role of v2.roles) console.log(`  ${role.employer} | ${role.title} | bullets=${role.lines.length}`);
console.log(`\n===== PER-BULLET QUALIFICATION NARRATIVE (from persisted v17 capabilities) =====`);
for (const role of v2.roles) for (const l of role.lines) {
  const caps = capsForLine(l); const cv = covOf(caps);
  const g = checkGrounding({ claim: l.text, evidenceIds: srcOf.get(l.text) ?? ["x"], sourceText: l.text, original: l.text, profileVocabulary, knownEntities: skillNames });
  console.log(`  • ${l.text.slice(0, 60)}...`);
  console.log(`      themes: ${Object.entries(cv).map(([k, v]) => `${k}:${v}`).join(", ") || "(none)"}`);
  console.log(`      capabilities: ${caps.map((c) => `${c}[${(skillId.get(c) ?? "?").toString().slice(0, 8)}]`).join(", ")}`);
  console.log(`      sources: ${(srcOf.get(l.text) ?? []).map((s) => s.slice(0, 8)).join(", ") || "-"}   grounding: ${g.ok ? "OK" : g.failedCheck}`);
}
console.log(`\nsummary metric: ${summary.metric ? summary.metric.text : "none"}`);
console.log(`skills groups order: ${v2.skillGroups.map((g: any) => g.label).join(" | ")}`);
console.log(`education: ${v2.education.map((e: any) => `${e.institution} (${e.credential})`).join("; ")}`);
console.log(`projects: ${v2.projects.length ? v2.projects.map((p: any) => p.name).join(", ") : "none"}`);
console.log(`PDF pages: ${pages}`);
console.log(`\nSUMMARY:\n  ${summary.text}`);
