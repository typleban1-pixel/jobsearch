/**
 * Resume Builder v2, Step 3B demonstration (read-only): the same frozen v16
 * profile through four jobs -- summary BEFORE (lead with highest-weight
 * functional area, the old behaviour) vs AFTER (lead with the plan's dominant
 * qualification story). No writes, no model.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { themesFromV2 } from "../lib/applications/themesV2.ts";
import { mapThemesToEvidence, type VerifiedPool, type EvidenceItem } from "../lib/render/evidenceMap.ts";
import { buildNarrativePlan } from "../lib/render/narrativePlan.ts";
import { coverageSelect, type Candidate, type ProjectSpec, type ThemeValues } from "../lib/render/coverageSelect.ts";
import { tagBullet, looksQuantitative, type CoveredTheme } from "../lib/render/bulletTag.ts";
import { buildSummary } from "../lib/render/summaryPlan.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const pageAll = async (t: string, r: (q: any) => any = (q) => q) => { const o: any[] = []; for (let f = 0; ; f += 1000) { const { data } = await r(db.from(t).select("*")).range(f, f + 999); o.push(...(data ?? [])); if (!data || data.length < 1000) break; } return o; };

const rows = await pageAll("profile_version_rows", (q) => q.eq("profile_version", 16));
const bySrc: Record<string, any[]> = {}; for (const r of rows) (bySrc[r.source_table] = bySrc[r.source_table] || []).push(r.row_data);
const items: EvidenceItem[] = []; const skillNames: string[] = [];
for (const s of bySrc.skills ?? []) { items.push({ ref: s.id ?? s.name, source: "skills", text: s.name ?? "" }); skillNames.push(s.name ?? ""); }
for (const p of bySrc.projects ?? []) items.push({ ref: p.id ?? p.name, source: "projects", text: `${p.name ?? ""} ${p.description ?? ""}` });
for (const m of bySrc.metrics ?? []) items.push({ ref: m.id, source: "metrics", text: `${m.label ?? ""} ${m.approved_wording ?? ""}` });
for (const e of bySrc.evidence ?? []) items.push({ ref: e.id, source: "evidence", text: `${e.detail ?? ""} ${e.summary ?? ""}`.trim() });
const { data: master } = await db.from("resumes").select("content").eq("is_master", true).ilike("label", "%version 16%").maybeSingle();
const doc = (master?.content as any)?.doc;
if ((master?.content as any)?.markdown) items.push({ ref: "master-md", source: "master", text: String((master?.content as any).markdown) });
const pool: VerifiedPool = { items, skillNames: skillNames.filter(Boolean) };

// text -> source evidence ids (from the grounded master doc), for reporting.
const textSources = new Map<string, string[]>();
const roleLines: { text: string; employer: string }[] = [];
for (const role of doc?.roles ?? []) for (const ln of role.lines ?? []) { roleLines.push({ text: ln.text, employer: String(role.employer ?? "role") }); textSources.set(ln.text, ln.sources ?? []); }
const proj = (doc?.projects ?? [])[0];
if (proj) { textSources.set(proj.line.text, proj.line.sources ?? []); for (const o of proj.optional ?? []) textSources.set(o.text, o.sources ?? []); }

const NT_RESP = [
  { normalized_term: "executive reporting", raw_text: "Prepare presentations and executive reporting", is_hard_requirement: "HARD", kind: "RESPONSIBILITY" },
  { normalized_term: "milestone tracking", raw_text: "Track project milestones, risks, and dependencies", is_hard_requirement: "HARD", kind: "RESPONSIBILITY" },
  { normalized_term: "process improvement", raw_text: "Support pilot programs and process improvements", is_hard_requirement: "HARD", kind: "RESPONSIBILITY" },
];
const COV: Record<string, number> = { DIRECT: 1, TRANSFERABLE: 0.6, WEAK: 0, NONE: 0 };
const BUDGET = { totalBullets: 9, perEmployment: 3, perProject: 4 };
const { data: liveNT } = await db.from("resumes").select("content").eq("id", "dd7e2c90-5e67-47ca-86ae-c7dc776e5354").maybeSingle();
const liveNTSummary: string = ((liveNT?.content as any)?.lines ?? []).find((l: any) => /specialist who takes/i.test(typeof l === "string" ? l : l.text ?? "")) ?? "(none)";

const FIXTURES = [
  { id: "383a5c26-0f99-4a13-8c5d-8c9170504d27", label: "Northern Trust — Strategic Growth (coordination)", extra: NT_RESP },
  { id: "bcc73536-8674-4440-a191-5ca82771cb72", label: "Senior Digital Marketing Manager (marketing)", extra: [] as any[] },
  { id: "147d953b-7b96-40ce-9a17-cb3d5d9a0483", label: "Sr. Product Manager, Client360 (product)", extra: [] as any[] },
  { id: "a86d788a-782c-44b1-a15d-fc49e7f9f4c4", label: "Junior Operations Supervisor (operations)", extra: [] as any[] },
];

for (const fx of FIXTURES) {
  const reqs = await pageAll("job_requirements", (q) => q.eq("job_id", fx.id));
  const themes = themesFromV2([...reqs, ...fx.extra], fx.label).themes;
  const plan = buildNarrativePlan(themes, mapThemesToEvidence(themes, pool), fx.label);
  const covThemes: CoveredTheme[] = plan.themes.map((t) => ({ id: t.id, coverage: t.coverage }));
  const values: ThemeValues = {}; for (const t of plan.themes) values[t.id] = t.weight * (COV[t.coverage] ?? 0);
  const employment: Candidate[] = roleLines.map((rl, i) => ({ id: `emp${i}`, text: rl.text, owner: { kind: "employment", entryId: rl.employer, label: rl.employer }, themes: tagBullet(rl.text, covThemes), quantitative: looksQuantitative(rl.text), spaceCost: 1 }));
  const projects: ProjectSpec[] = proj ? [{ id: "rentpup", label: "RentPup", purpose: { text: proj.line.text, themes: tagBullet(proj.line.text, covThemes) }, traction: { text: proj.optional?.[0]?.text ?? "", themes: tagBullet(proj.optional?.[0]?.text ?? "", covThemes), quantitative: true }, execution: (proj.optional ?? []).slice(1).map((o: any, i: number) => ({ id: `rp${i}`, text: o.text, owner: { kind: "project", entryId: "rentpup", label: "RentPup" }, themes: tagBullet(o.text, covThemes), quantitative: looksQuantitative(o.text), spaceCost: 1 })) }] : [];
  const selection = coverageSelect(employment, projects, values, BUDGET);
  const summary = buildSummary(plan, selection);

  // BEFORE: lead with the highest-summed-weight functional area (any coverage).
  const areaW: Record<string, number> = {}; for (const t of plan.themes) areaW[t.area] = (areaW[t.area] ?? 0) + t.weight;
  const beforeArea = Object.entries(areaW).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";

  console.log(`\n========== ${fx.label} ==========`);
  console.log(`BEFORE (lead = highest-weight area): ${beforeArea}${fx.id.startsWith("383a5c26") ? `\n  live NT summary: "${String(liveNTSummary).slice(0, 120)}..."` : ""}`);
  console.log(`AFTER  (lead = dominant story):      ${summary.leadArea}`);
  console.log(`SUMMARY: ${summary.text}`);
  console.log(`driving themes + supporting evidence IDs:`);
  for (const d of summary.drivingThemes) console.log(`   ${d.id.padEnd(34)} ${d.evidence.slice(0, 3).join(", ") || "(none)"}`);
  if (summary.metric) console.log(`metric used: "${summary.metric.text.slice(0, 80)}" (strengthens ${summary.metric.strengthens}); sources: ${(textSources.get(summary.metric.text) ?? []).slice(0, 3).join(", ") || "?"}`);
  else console.log(`metric used: none (none forced)`);
  console.log(`gaps excluded from summary: ${summary.gapsExcluded.join(", ") || "none"}`);
}
