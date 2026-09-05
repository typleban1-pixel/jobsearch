/**
 * Resume Builder v2, Step 4: inert end-to-end integration for Northern Trust.
 * rich requirements -> themesV2 -> evidenceMap -> narrativePlan -> coverageSelect
 * -> summaryPlan -> reframeV2(passthrough) -> checkGrounding -> renderer (local PDF).
 * No LLM, no DB writes, no wiring.
 *
 * Bullet->theme coverage is derived STRUCTURALLY: theme -> verified skill
 * (evidenceMap) -> bullet (its STAGED v17 capability tags) -> existing sources.
 * No text-signature tagger (bulletTag is not imported). The capability tags and
 * the new "Managing concurrent priorities" skill come from lib/render/stagedV17
 * -- clearly labeled STAGED v17 provenance, NOT live profile truth.
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
import { STAGED_V17_SKILL, STAGED_METRICS, capabilitiesFor } from "../lib/render/stagedV17.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const pageAll = async (t: string, r: (q: any) => any = (q) => q) => { const o: any[] = []; for (let f = 0; ; f += 1000) { const { data } = await r(db.from(t).select("*")).range(f, f + 999); o.push(...(data ?? [])); if (!data || data.length < 1000) break; } return o; };

// reviewed v2 NT extraction fixture (complete requirements + responsibilities)
const NT = [
  ["project coordination", "Assist with project planning, coordination, and implementation", "HARD", "SKILL"],
  ["communication skills", "Excellent written, verbal, and presentation communication", "HARD", "SKILL"],
  ["problem-solving", "Analytical mindset with strong problem-solving", "HARD", "SKILL"],
  ["multitasking", "manage multiple projects and priorities simultaneously", "HARD", "SKILL"],
  ["collaboration", "work effectively across teams and build collaborative relationships", "HARD", "SKILL"],
  ["microsoft office", "Proficiency in Microsoft PowerPoint, Excel, and Word", "HARD", "TOOL"],
  ["cross-functional project experience", "supporting cross-functional projects and business initiatives", "PREFERRED", "EXPERIENCE_YEARS"],
  ["financial services experience", "4-6 years in financial services, wealth management", "PREFERRED", "EXPERIENCE_YEARS"],
  ["power bi", "Power BI or other BI platforms preferred", "PREFERRED", "TOOL"],
  ["crm platforms", "CRM platforms preferred", "PREFERRED", "TOOL"],
  ["process improvement", "pilot programs, process improvements, and new business initiatives", "HARD", "RESPONSIBILITY"],
  ["executive reporting", "presentations and executive reporting for leadership", "HARD", "RESPONSIBILITY"],
  ["milestone tracking", "Track project milestones, risks, and dependencies", "HARD", "RESPONSIBILITY"],
].map(([normalized_term, raw_text, is_hard_requirement, kind]) => ({ normalized_term, raw_text, is_hard_requirement, kind }));

const rows = await pageAll("profile_version_rows", (q) => q.eq("profile_version", 16));
const bySrc: Record<string, any[]> = {}; for (const r of rows) (bySrc[r.source_table] = bySrc[r.source_table] || []).push(r.row_data);
const items: EvidenceItem[] = []; const skillNames: string[] = []; const vocab: string[] = [];
for (const s of bySrc.skills ?? []) { items.push({ ref: s.id ?? s.name, source: "skills", text: s.name ?? "" }); skillNames.push(s.name ?? ""); vocab.push(s.name ?? ""); }
// STAGED v17 skill (not live) so multitasking resolves structurally
items.push({ ref: "staged-mcp", source: "skills", text: STAGED_V17_SKILL.name }); skillNames.push(STAGED_V17_SKILL.name);
for (const e of bySrc.evidence ?? []) { const t = `${e.detail ?? ""} ${e.summary ?? ""}`.trim(); items.push({ ref: e.id, source: "evidence", text: t }); vocab.push(t); }
const { data: mr } = await db.from("resumes").select("content").eq("is_master", true).ilike("label", "%version 16%").maybeSingle();
const doc0: ResumeDoc = (mr?.content as any).doc;
if ((mr?.content as any)?.markdown) { items.push({ ref: "master-md", source: "master", text: (mr?.content as any).markdown }); vocab.push((mr?.content as any).markdown); }
const pool: VerifiedPool = { items, skillNames: skillNames.filter(Boolean) };
const profileVocabulary = vocab.join(" \n ");

const themes = themesFromV2(NT, "Specialist, Strategic Growth Programs").themes;
const plan = buildNarrativePlan(themes, mapThemesToEvidence(themes, pool), "Specialist, Strategic Growth Programs");
const COV: Record<string, number> = { DIRECT: 1, TRANSFERABLE: 0.6, WEAK: 0, NONE: 0 };
const values: ThemeValues = {}; for (const t of plan.themes) values[t.id] = t.weight * (COV[t.coverage] ?? 0);

// STRUCTURAL coverage: theme -> skill(capability) -> bullet. Run the REAL evidence map with the bullet's staged capabilities as the skill pool.
const themeTerms = plan.themes.map((t) => ({ term: t.id }));
const coverageForCaps = (caps: string[]): string[] => {
  if (!caps.length) return [];
  const idx = mapThemesToEvidence(themeTerms, { items: caps.map((n) => ({ ref: n, source: "skills", text: n })), skillNames: caps });
  return plan.themes.filter((t) => { const c = idx.byTheme.get(t.id)?.coverage; return c === "DIRECT" || c === "TRANSFERABLE"; }).map((t) => t.id);
};
const quant = (t: string) => /\b\d[\d,]*\b|\$|%/.test(t);

const employment: Candidate[] = [];
for (const role of doc0.roles) for (const l of role.lines) employment.push({ id: l.text.slice(0, 30), text: l.text, owner: { kind: "employment", entryId: role.employer, label: role.employer }, themes: coverageForCaps(capabilitiesFor(l.text)), quantitative: quant(l.text), spaceCost: 1 });
const rp = doc0.projects[0]!;
const projects: ProjectSpec[] = [{ id: "rentpup", label: "RentPup", purpose: { text: rp.line.text, themes: coverageForCaps(capabilitiesFor(rp.line.text)) }, traction: { text: rp.optional?.[0]?.text ?? "", themes: coverageForCaps(capabilitiesFor(rp.optional?.[0]?.text ?? "")), quantitative: true }, execution: (rp.optional ?? []).slice(1).map((o: any) => ({ id: o.text.slice(0, 20), text: o.text, owner: { kind: "project", entryId: "rentpup", label: "RentPup" }, themes: coverageForCaps(capabilitiesFor(o.text)), quantitative: quant(o.text), spaceCost: 1 })) }];
const selection = coverageSelect(employment, projects, values, { totalBullets: 12, perEmployment: 3, perProject: 4 });

// compact metrics: resolve each staged metric's capabilities to the themes it covers for THIS job
const metrics: MetricPhrase[] = STAGED_METRICS.map((m) => ({ phrase: m.phrase, themes: coverageForCaps(m.capabilities) }));
const summary = buildSummary(plan, selection, metrics);

// build V2 doc (passthrough reframing = verified master wording), NO workaround
const sel = new Set(selection.selected.map((s) => s.text));
const v2: ResumeDoc = JSON.parse(JSON.stringify(doc0));
v2.summary = { text: summary.text, sources: summary.drivingThemes.flatMap((d) => d.evidence).slice(0, 6) } as any;
for (const role of v2.roles) { let kept = role.lines.filter((l: any) => sel.has(l.text)); if (!kept.length) { const b = [...role.lines].sort((a: any, b: any) => coverageForCaps(capabilitiesFor(b.text)).reduce((n, t) => n + (values[t] ?? 0), 0) - coverageForCaps(capabilitiesFor(a.text)).reduce((n, t) => n + (values[t] ?? 0), 0))[0]; if (b) kept = [b]; } role.lines = kept; }
v2.projects = selection.projectsSelected.includes("rentpup") ? v2.projects : [];
const order = ["Operations and process", "Product development", "Marketing and ecommerce", "Technical", "Creative production"];
v2.skillGroups.sort((a: any, b: any) => order.indexOf(a.label) - order.indexOf(b.label));

let ground = { ok: 0, bad: 0 };
const allClaims = [...v2.roles.flatMap((r: any) => r.lines.map((l: any) => l.text)), ...v2.projects.flatMap((p: any) => [p.line.text, ...(p.optional ?? []).map((o: any) => o.text)])];
for (const c of allClaims) checkGrounding({ claim: c, evidenceIds: ["x"], sourceText: c, original: c, profileVocabulary, knownEntities: skillNames }).ok ? ground.ok++ : ground.bad++;
writeFileSync("/tmp/nt-v2-resume.md", renderMarkdown(v2));
let pdf = "fail"; try { const r = await renderResume(v2); writeFileSync("/tmp/nt-v2-resume.pdf", r.pdf); pdf = `pages=${r.pages} bytes=${r.bytes}`; } catch (e) { pdf = "FAIL: " + (e instanceof Error ? e.message : String(e)); }

const CREATIVE = /video|motion graphic|edited|film|photograph|3d print/i;
const lccc = v2.roles.flatMap((r: any) => r.lines).find((l: any) => l.text.startsWith("Coordinated a college"));
console.log(`primaryStory=[${plan.primaryStory.areaId}]  gaps=${plan.gaps.map((g) => g.themeId).join(",")}`);
console.log(`selected=${selection.selected.length}  RentPup=${selection.projectsSelected.includes("rentpup")}  grounding=${ground.ok}/${ground.ok + ground.bad}`);
console.log(`summary metric: ${summary.metric ? `"${summary.metric.text}" (strengthens ${summary.metric.strengthens})` : "none"}`);
console.log(`summary duplicates any experience bullet? ${summary.metric ? [...sel].some((t) => t.toLowerCase().includes(summary.metric!.text.toLowerCase()) || summary.metric!.text.toLowerCase().includes(t.toLowerCase())) : false}`);
console.log(`PDF (no workaround): ${pdf}`);
console.log(`Defect B -- LCCC video bullet selected into V2? ${lccc ? "YES (still present)" : "NO (not selected -> redundant under refined tags)"}`);
console.log(`creative/video lines in V2 experience: ${v2.roles.flatMap((r: any) => r.lines).filter((l: any) => CREATIVE.test(l.text)).length}`);
console.log(`\nSUMMARY: ${summary.text}`);
