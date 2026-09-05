/**
 * Resume Builder v2, Step 4 + 4C: inert end-to-end integration + 4-fixture
 * selection comparison. rich requirements -> themesV2 -> evidenceMap ->
 * narrativePlan -> coverageSelect (admission bar + narrative density) ->
 * summaryPlan -> passthrough reframe -> checkGrounding -> renderer (NT PDF).
 * No LLM, no DB writes, no wiring. Bullet->theme coverage is structural via the
 * STAGED v17 capability tags (lib/render/stagedV17.ts, NOT live truth); bulletTag
 * is not imported.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { writeFileSync } from "node:fs";
import { themesFromV2 } from "../lib/applications/themesV2.ts";
import { mapThemesToEvidence, type VerifiedPool, type EvidenceItem } from "../lib/render/evidenceMap.ts";
import { buildNarrativePlan, type NarrativePlan } from "../lib/render/narrativePlan.ts";
import { coverageSelect, independentSelect, type Candidate, type ProjectSpec, type ThemeValues } from "../lib/render/coverageSelect.ts";
import { buildSummary, type MetricPhrase } from "../lib/render/summaryPlan.ts";
import { checkGrounding } from "../lib/render/grounding.ts";
import { renderMarkdown, type ResumeDoc } from "../lib/render/resume.ts";
import { renderResume } from "../lib/render/resumePdf.ts";
import { STAGED_V17_SKILL, STAGED_METRICS, capabilitiesFor } from "../lib/render/stagedV17.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const pageAll = async (t: string, r: (q: any) => any = (q) => q) => { const o: any[] = []; for (let f = 0; ; f += 1000) { const { data } = await r(db.from(t).select("*")).range(f, f + 999); o.push(...(data ?? [])); if (!data || data.length < 1000) break; } return o; };

const NT_EXTRACTION = [
  ["project coordination", "project planning, coordination, and implementation", "HARD", "SKILL"], ["communication skills", "written, verbal, and presentation communication", "HARD", "SKILL"],
  ["problem-solving", "Analytical mindset with problem-solving", "HARD", "SKILL"], ["multitasking", "manage multiple projects and priorities simultaneously", "HARD", "SKILL"],
  ["collaboration", "work effectively across teams and build collaborative relationships", "HARD", "SKILL"], ["microsoft office", "Microsoft PowerPoint, Excel, and Word", "HARD", "TOOL"],
  ["cross-functional project experience", "cross-functional projects and business initiatives", "PREFERRED", "EXPERIENCE_YEARS"], ["financial services experience", "financial services, wealth management", "PREFERRED", "EXPERIENCE_YEARS"],
  ["power bi", "Power BI or other BI platforms", "PREFERRED", "TOOL"], ["crm platforms", "CRM platforms", "PREFERRED", "TOOL"],
  ["process improvement", "process improvements and new business initiatives", "HARD", "RESPONSIBILITY"], ["executive reporting", "presentations and executive reporting for leadership", "HARD", "RESPONSIBILITY"], ["milestone tracking", "Track project milestones, risks, and dependencies", "HARD", "RESPONSIBILITY"],
].map(([normalized_term, raw_text, is_hard_requirement, kind]) => ({ normalized_term, raw_text, is_hard_requirement, kind }));

const rows = await pageAll("profile_version_rows", (q) => q.eq("profile_version", 16));
const bySrc: Record<string, any[]> = {}; for (const r of rows) (bySrc[r.source_table] = bySrc[r.source_table] || []).push(r.row_data);
const items: EvidenceItem[] = []; const skillNames: string[] = []; const vocab: string[] = [];
for (const s of bySrc.skills ?? []) { items.push({ ref: s.id ?? s.name, source: "skills", text: s.name ?? "" }); skillNames.push(s.name ?? ""); vocab.push(s.name ?? ""); }
items.push({ ref: "staged-mcp", source: "skills", text: STAGED_V17_SKILL.name }); skillNames.push(STAGED_V17_SKILL.name);
for (const e of bySrc.evidence ?? []) { const t = `${e.detail ?? ""} ${e.summary ?? ""}`.trim(); items.push({ ref: e.id, source: "evidence", text: t }); vocab.push(t); }
const { data: mr } = await db.from("resumes").select("content").eq("is_master", true).ilike("label", "%version 16%").maybeSingle();
const doc0: ResumeDoc = (mr?.content as any).doc;
if ((mr?.content as any)?.markdown) { items.push({ ref: "master-md", source: "master", text: (mr?.content as any).markdown }); vocab.push((mr?.content as any).markdown); }
const pool: VerifiedPool = { items, skillNames: skillNames.filter(Boolean) };
const profileVocabulary = vocab.join(" \n ");
const COV: Record<string, number> = { DIRECT: 1, TRANSFERABLE: 0.6, WEAK: 0, NONE: 0 };
const BUDGET = { totalBullets: 12, perEmployment: 3, perProject: 4 };
const quant = (t: string) => /\b\d[\d,]*\b|\$|%/.test(t);

// per-job pipeline
function pipeline(plan: NarrativePlan) {
  const values: ThemeValues = {}; for (const t of plan.themes) values[t.id] = t.weight * (COV[t.coverage] ?? 0);
  const themeTerms = plan.themes.map((t) => ({ term: t.id }));
  const idxFor = (caps: string[]) => mapThemesToEvidence(themeTerms, { items: caps.map((n) => ({ ref: n, source: "skills", text: n })), skillNames: caps });
  const cov = (caps: string[]): Record<string, string> => { if (!caps.length) return {}; const idx = idxFor(caps); const o: Record<string, string> = {}; for (const t of plan.themes) { const c = idx.byTheme.get(t.id)?.coverage; if (c === "DIRECT" || c === "TRANSFERABLE") o[t.id] = c; } return o; };
  // density = share of caps that CONTRIBUTE to a covered theme (from the evidence
  // refs, so umbrella components count), not per-cap solo coverage.
  const density = (caps: string[]) => { if (!caps.length) return 1; const idx = idxFor(caps); const contrib = new Set<string>(); for (const t of plan.themes) { const c = idx.byTheme.get(t.id); if (c && (c.coverage === "DIRECT" || c.coverage === "TRANSFERABLE")) for (const e of c.evidence) contrib.add(e.ref); } return contrib.size / caps.length; };
  const emp: Candidate[] = [];
  for (const role of doc0.roles) for (const l of role.lines) { const caps = capabilitiesFor(l.text); emp.push({ id: l.text, text: l.text, owner: { kind: "employment", entryId: role.employer, label: role.employer }, themes: Object.keys(cov(caps)), quantitative: quant(l.text), spaceCost: 1, density: density(caps) }); }
  const rp = doc0.projects[0]!;
  const projects: ProjectSpec[] = [{ id: "rentpup", label: "RentPup", purpose: { text: rp.line.text, themes: Object.keys(cov(capabilitiesFor(rp.line.text))), density: density(capabilitiesFor(rp.line.text)) }, traction: { text: rp.optional?.[0]?.text ?? "", themes: Object.keys(cov(capabilitiesFor(rp.optional?.[0]?.text ?? ""))), quantitative: true, density: density(capabilitiesFor(rp.optional?.[0]?.text ?? "")) }, execution: (rp.optional ?? []).slice(1).map((o: any) => { const caps = capabilitiesFor(o.text); return { id: o.text, text: o.text, owner: { kind: "project", entryId: "rentpup", label: "RentPup" }, themes: Object.keys(cov(caps)), quantitative: quant(o.text), spaceCost: 1, density: density(caps) }; }) }];
  const before = independentSelect(emp, projects, values, BUDGET);
  const after = coverageSelect(emp, projects, values, BUDGET);
  return { plan, values, emp, projects, before, after, cov, density };
}

async function planFor(label: string, extraction: any[]) { const themes = themesFromV2(extraction, label).themes; return buildNarrativePlan(themes, mapThemesToEvidence(themes, pool), label); }

const FIX = [
  { label: "Northern Trust (coordination)", ext: NT_EXTRACTION },
  { label: "Senior Digital Marketing Manager (marketing)", id: "bcc73536-8674-4440-a191-5ca82771cb72" },
  { label: "Sr. Product Manager, Client360 (product)", id: "147d953b-7b96-40ce-9a17-cb3d5d9a0483" },
  { label: "Junior Operations Supervisor (operations)", id: "a86d788a-782c-44b1-a15d-fc49e7f9f4c4" },
];

console.log("========== 4-FIXTURE BEFORE -> AFTER SELECTION ==========");
let ntRun: any = null;
for (const fx of FIX) {
  const ext = fx.ext ?? await pageAll("job_requirements", (q) => q.eq("job_id", fx.id));
  const plan = await planFor(fx.label, ext);
  const run = pipeline(plan);
  if (fx.label.startsWith("Northern")) ntRun = run;
  const beforeT = new Set(run.before.selected.map((s: any) => s.text));
  const afterT = new Set(run.after.selected.map((s: any) => s.text));
  const removed = [...beforeT].filter((t) => !afterT.has(t as string)) as string[];
  const covered = plan.themes.filter((t) => (run.values[t.id] ?? 0) > 0).map((t) => t.id);
  const uncoveredAfter = covered.filter((t) => !((run.after.coverage[t] ?? 0) > 0));
  console.log(`\n### ${fx.label}  [${plan.primaryStory.areaId}]`);
  console.log(`  BEFORE ${run.before.selected.length} lines / AFTER ${run.after.selected.length} lines (budget ${BUDGET.totalBullets}); RentPup after=${run.after.projectsSelected.includes("rentpup")}`);
  console.log(`  AFTER space by owner: ${JSON.stringify(run.after.spaceByOwner)}`);
  console.log(`  removed (in BEFORE, not AFTER): ${removed.length}`);
  for (const rt of removed.slice(0, 6)) { const caps = capabilitiesFor(rt); const c = run.cov(caps); const cls = Object.entries(c).map(([k, v]) => `${k}:${String(v).charAt(0)}`).join(","); const d = run.density(caps); const reason = Object.keys(c).length === 0 ? "no plan coverage" : d < 0.5 ? "low narrative density on already-covered theme" : "below admission bar (diminished/redundant) or budget"; console.log(`     - "${rt.slice(0, 46)}"  themes[${cls || "none"}] density=${d.toFixed(2)} cost=1 -> ${reason}`); }
  console.log(`  important themes uncovered AFTER: ${uncoveredAfter.filter((t) => plan.themes.find((x) => x.id === t)?.coverage === "DIRECT").join(", ") || "none (all DIRECT themes still covered)"}`);
}

// ---- render NT ----
const { plan, after: selection, values, cov, density } = ntRun;
const metrics: MetricPhrase[] = STAGED_METRICS.map((m) => ({ phrase: m.phrase, themes: Object.keys(cov(m.capabilities)) }));
const summary = buildSummary(plan, selection, metrics);
const sel = new Set(selection.selected.map((s: any) => s.text));
const v2: ResumeDoc = JSON.parse(JSON.stringify(doc0));
v2.summary = { text: summary.text, sources: summary.drivingThemes.flatMap((d: any) => d.evidence).slice(0, 6) } as any;
for (const role of v2.roles) role.lines = role.lines.filter((l: any) => sel.has(l.text)); // no fallback
v2.projects = selection.projectsSelected.includes("rentpup") ? v2.projects : [];
const order = ["Operations and process", "Product development", "Marketing and ecommerce", "Technical", "Creative production"];
v2.skillGroups.sort((a: any, b: any) => order.indexOf(a.label) - order.indexOf(b.label));
let ground = { ok: 0, bad: 0 };
const claims = [...v2.roles.flatMap((r: any) => r.lines.map((l: any) => l.text)), ...v2.projects.flatMap((p: any) => [p.line.text, ...(p.optional ?? []).map((o: any) => o.text)])];
for (const c of claims) checkGrounding({ claim: c, evidenceIds: ["x"], sourceText: c, original: c, profileVocabulary, knownEntities: skillNames }).ok ? ground.ok++ : ground.bad++;
writeFileSync("/tmp/nt-v2-resume.md", renderMarkdown(v2));
let pdf = "fail"; try { const r = await renderResume(v2); writeFileSync("/tmp/nt-v2-resume.pdf", r.pdf); pdf = `pages=${r.pages} bytes=${r.bytes}`; } catch (e) { pdf = "FAIL: " + (e instanceof Error ? e.message : String(e)); }
const CREATIVE = /video|motion graphic|edited|film|photograph|3d print/i;
const emptyRoles = v2.roles.filter((r: any) => r.lines.length === 0).map((r: any) => r.employer);
console.log(`\n========== NORTHERN TRUST V2 (rendered) ==========`);
console.log(`grounding=${ground.ok}/${ground.ok + ground.bad}  PDF=${pdf}  summary metric=${summary.metric ? "yes" : "none"}`);
console.log(`roles with 0 bullets (no fallback): ${emptyRoles.join(", ") || "none"}`);
console.log(`creative/video lines: ${v2.roles.flatMap((r: any) => r.lines).filter((l: any) => CREATIVE.test(l.text)).length}  RentPup section: ${v2.projects.length ? "present" : "absent"}`);
console.log(`SUMMARY: ${summary.text}`);
