/**
 * Resume Builder v2, Step 3A demonstration (read-only): the same frozen v16
 * profile through four jobs, before (independent greedy) vs after
 * (coverage-first + project unit). No writes, no model.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { themesFromV2 } from "../lib/applications/themesV2.ts";
import { mapThemesToEvidence, type VerifiedPool, type EvidenceItem } from "../lib/render/evidenceMap.ts";
import { buildNarrativePlan } from "../lib/render/narrativePlan.ts";
import { coverageSelect, independentSelect, type Candidate, type ProjectSpec, type ThemeValues } from "../lib/render/coverageSelect.ts";
import { tagBullet, looksQuantitative, type CoveredTheme } from "../lib/render/bulletTag.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const pageAll = async (t: string, r: (q: any) => any = (q) => q) => { const o: any[] = []; for (let f = 0; ; f += 1000) { const { data } = await r(db.from(t).select("*")).range(f, f + 999); o.push(...(data ?? [])); if (!data || data.length < 1000) break; } return o; };

// ---- verified pool + master résumé candidates ----
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

const roleLines: { text: string; employer: string }[] = [];
for (const role of doc?.roles ?? []) for (const ln of role.lines ?? []) roleLines.push({ text: ln.text, employer: String(role.employer ?? "role") });
const proj = (doc?.projects ?? [])[0];
const CREATIVE = /video|motion graphic|editor|edited|film|photograph|3d print|parametric cad|onshape|slicer/i;

const NT_RESP = [
  { normalized_term: "executive reporting", raw_text: "Prepare presentations and executive reporting", is_hard_requirement: "HARD", kind: "RESPONSIBILITY" },
  { normalized_term: "milestone tracking", raw_text: "Track project milestones, risks, and dependencies", is_hard_requirement: "HARD", kind: "RESPONSIBILITY" },
  { normalized_term: "process improvement", raw_text: "Support pilot programs and process improvements", is_hard_requirement: "HARD", kind: "RESPONSIBILITY" },
];
const COV: Record<string, number> = { DIRECT: 1, TRANSFERABLE: 0.6, WEAK: 0, NONE: 0 };
// A ~2-page budget with genuine pressure, so the selectors must actually choose.
const BUDGET = { totalBullets: 9, perEmployment: 3, perProject: 4 };

// The actual live tailored NT résumé, for a creative-concentration comparison.
const { data: liveNT } = await db.from("resumes").select("content").eq("id", "dd7e2c90-5e67-47ca-86ae-c7dc776e5354").maybeSingle();
const liveLines: string[] = ((liveNT?.content as any)?.lines ?? []).map((l: any) => (typeof l === "string" ? l : l.text ?? ""));

async function reqsFor(id: string) { return pageAll("job_requirements", (q) => q.eq("job_id", id)); }

const FIXTURES = [
  { id: "383a5c26-0f99-4a13-8c5d-8c9170504d27", label: "Northern Trust — Strategic Growth (coordination)", extra: NT_RESP },
  { id: "bcc73536-8674-4440-a191-5ca82771cb72", label: "Senior Digital Marketing Manager (marketing)", extra: [] as any[] },
  { id: "147d953b-7b96-40ce-9a17-cb3d5d9a0483", label: "Sr. Product Manager, Client360 (product)", extra: [] as any[] },
  { id: "a86d788a-782c-44b1-a15d-fc49e7f9f4c4", label: "Junior Operations Supervisor (operations)", extra: [] as any[] },
];

for (const fx of FIXTURES) {
  const reqs = await reqsFor(fx.id);
  const themes = themesFromV2([...reqs, ...fx.extra], fx.label).themes;
  const index = mapThemesToEvidence(themes, pool);
  const plan = buildNarrativePlan(themes, index, fx.label);
  const covThemes: CoveredTheme[] = plan.themes.map((t) => ({ id: t.id, coverage: t.coverage }));
  const values: ThemeValues = {}; for (const t of plan.themes) values[t.id] = t.weight * (COV[t.coverage] ?? 0);

  const employment: Candidate[] = roleLines.map((rl, i) => ({
    id: `emp${i}`, text: rl.text, owner: { kind: "employment", entryId: rl.employer, label: rl.employer },
    themes: tagBullet(rl.text, covThemes), quantitative: looksQuantitative(rl.text), spaceCost: 1,
  }));
  const projects: ProjectSpec[] = proj ? [{
    id: "rentpup", label: "RentPup",
    purpose: { text: proj.line.text, themes: tagBullet(proj.line.text, covThemes) },
    traction: { text: proj.optional?.[0]?.text ?? "", themes: tagBullet(proj.optional?.[0]?.text ?? "", covThemes), quantitative: true },
    execution: (proj.optional ?? []).slice(1).map((o: any, i: number) => ({ id: `rp${i}`, text: o.text, owner: { kind: "project", entryId: "rentpup", label: "RentPup" }, themes: tagBullet(o.text, covThemes), quantitative: looksQuantitative(o.text), spaceCost: 1 })),
  }] : [];

  const before = independentSelect(employment, projects, values, BUDGET);
  const after = coverageSelect(employment, projects, values, BUDGET);
  const coveredIds = plan.themes.filter((t) => (values[t.id] ?? 0) > 0).map((t) => t.id);
  const creativeSel = (r: typeof before) => r.selected.filter((s) => CREATIVE.test(s.text) && s.themes.length === 0).length;
  const themesCovered = (r: typeof before) => coveredIds.filter((t) => (r.coverage[t] ?? 0) > 0).length;

  console.log(`\n========== ${fx.label} ==========`);
  console.log(`primaryStory: [${plan.primaryStory.areaId}] ${plan.primaryStory.label}`);
  console.log(`covered (DIRECT/TRANSFERABLE) themes: ${coveredIds.join(", ")}`);
  console.log(`\n            themesCovered  bullets  space-by-owner                         creative(off-theme)`);
  const fmt = (name: string, r: typeof before) => `  ${name.padEnd(8)} ${String(themesCovered(r)).padStart(2)}/${coveredIds.length}          ${String(r.selected.length).padStart(2)}      ${JSON.stringify(r.spaceByOwner).slice(0, 46).padEnd(46)}  ${creativeSel(r)}`;
  console.log(fmt("BEFORE", before));
  console.log(fmt("AFTER", after));
  // redundancy: themes covered by >1 bullet
  const redun = (r: typeof before) => coveredIds.filter((t) => (r.coverage[t] ?? 0) > 1).map((t) => `${t}×${r.coverage[t]}`);
  console.log(`  redundant (theme covered >1): BEFORE ${JSON.stringify(redun(before))}  AFTER ${JSON.stringify(redun(after))}`);
  console.log(`  uncovered strong themes AFTER: ${after.uncoveredThemes.filter((t) => plan.themes.find((x) => x.id === t)?.coverage === "DIRECT").join(", ") || "none"}`);
  console.log(`  RentPup selected: BEFORE=${before.projectsSelected.includes("rentpup")}  AFTER=${after.projectsSelected.includes("rentpup")}`);
  if (after.projectsSelected.includes("rentpup")) {
    console.log("  RentPup unit (AFTER):");
    for (const s of after.selected.filter((s) => s.owner.entryId === "rentpup")) console.log(`     [${s.role}] ${s.text.slice(0, 90)}`);
  }
  if (fx.id.startsWith("383a5c26")) {
    console.log("  NT target-theme coverage (AFTER):");
    for (const t of ["project coordination", "collaboration", "process improvement", "communication skills", "multitasking", "problem-solving", "microsoft office", "cross-functional project experience"]) {
      console.log(`     ${t.padEnd(34)} ${(after.coverage[t] ?? 0) > 0 ? "covered" : "—"}  (${plan.themes.find((x) => x.id === t)?.coverage ?? "absent"})`);
    }
    for (const banned of ["financial services experience", "power bi", "crm platforms", "executive reporting"]) {
      console.log(`     [gap] ${banned.padEnd(30)} covered AFTER? ${(after.coverage[banned] ?? 0) > 0 ? "LEAK!" : "no"}`);
    }
    const liveCreative = liveLines.filter((l) => CREATIVE.test(l)).length;
    const afterCreative = after.selected.filter((s) => CREATIVE.test(s.text)).length;
    console.log(`  creative/video concentration: LIVE résumé ${liveCreative} of ${liveLines.length} lines  ->  Step3A ${afterCreative} of ${after.selected.length}`);
  }
}
