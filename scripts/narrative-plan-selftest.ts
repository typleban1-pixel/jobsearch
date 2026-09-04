/**
 * Resume Builder v2, Step 2: evidence map + narrative plan.
 *
 * Reads the frozen v16 profile (read-only, no writes) to build the verified
 * evidence pool, then runs Northern Trust and a marketing job through
 * themesFromV2 -> mapThemesToEvidence -> buildNarrativePlan against the SAME
 * profile. Proves: coverage is classified independently of the posting; gaps
 * (financial services / wealth management / power bi / crm) stay visible but
 * cannot enter terminology; primaryStory comes from important-themes x strong
 * evidence; and the same profile yields a different primary story per job.
 * No model calls.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { themesFromV2 } from "../lib/applications/themesV2.ts";
import { mapThemesToEvidence, type VerifiedPool, type EvidenceItem } from "../lib/render/evidenceMap.ts";
import { buildNarrativePlan } from "../lib/render/narrativePlan.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const pageAll = async (t: string, r: (q: any) => any = (q) => q) => { const o: any[] = []; for (let f = 0; ; f += 1000) { const { data } = await r(db.from(t).select("*")).range(f, f + 999); o.push(...(data ?? [])); if (!data || data.length < 1000) break; } return o; };

// ---- build the verified pool from frozen v16 (read-only) ----
const rows = await pageAll("profile_version_rows", (q) => q.eq("profile_version", 16));
const bySrc: Record<string, any[]> = {};
for (const r of rows) (bySrc[r.source_table] = bySrc[r.source_table] || []).push(r.row_data);
const items: EvidenceItem[] = [];
const skillNames: string[] = [];
for (const s of bySrc.skills ?? []) { items.push({ ref: s.id ?? s.name, source: "skills", text: s.name ?? "" }); skillNames.push(s.name ?? ""); }
for (const p of bySrc.projects ?? []) items.push({ ref: p.id ?? p.name, source: "projects", text: `${p.name ?? ""} ${p.description ?? ""}` });
for (const m of bySrc.metrics ?? []) items.push({ ref: m.id, source: "metrics", text: `${m.label ?? ""} ${m.approved_wording ?? ""}` });
// Include BOTH detail and summary: some verified facts (e.g. Holley's
// multiple-brands / concurrent-projects / shifting-priorities) live in summary.
for (const e of bySrc.evidence ?? []) items.push({ ref: e.id, source: "evidence", text: `${e.detail ?? ""} ${e.summary ?? ""}`.trim() });
// The grounded master résumé (rendered markdown) -- verified, résumé-able
// prose the entailment signatures are judged against.
const { data: master } = await db.from("resumes").select("content").eq("is_master", true).ilike("label", "%version 16%").maybeSingle();
const masterMd = String((master?.content as any)?.markdown ?? "");
if (masterMd) items.push({ ref: "master-md", source: "master", text: masterMd });
const pool: VerifiedPool = { items, skillNames: skillNames.filter(Boolean) };
console.log(`verified pool: ${items.length} items (master markdown ${masterMd.length} chars), ${pool.skillNames.length} skills`);

async function requirementsFor(match: string) {
  const { data: jobs } = await db.from("jobs").select("id,title").ilike("title", `%${match}%`).limit(1);
  const job = jobs?.[0]; if (!job) return { title: match, reqs: [] as any[] };
  const reqs = await pageAll("job_requirements", (q) => q.eq("job_id", job.id));
  return { title: job.title, reqs };
}

// Northern Trust real requirements + the responsibilities the richer extractor (rule 6d) will add.
const nt = await requirementsFor("Strategic Growth Programs");
const NT_RESP = [
  { normalized_term: "executive reporting", raw_text: "Prepare presentations, meeting materials, status updates, and executive reporting", is_hard_requirement: "HARD", kind: "RESPONSIBILITY" },
  { normalized_term: "milestone tracking", raw_text: "Track project milestones, action items, risks, and dependencies", is_hard_requirement: "HARD", kind: "RESPONSIBILITY" },
  { normalized_term: "process improvement", raw_text: "Support pilot programs, process improvements, and new business initiatives", is_hard_requirement: "HARD", kind: "RESPONSIBILITY" },
];
const ntThemes = themesFromV2([...nt.reqs, ...NT_RESP], nt.title);
const ntIndex = mapThemesToEvidence(ntThemes.themes, pool);
const ntPlan = buildNarrativePlan(ntThemes.themes, ntIndex, nt.title);

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

console.log(`\n===== NORTHERN TRUST: ${nt.title} =====`);
console.log("theme  [kind hardness w] core  coverage  evidence(refs:strength)");
for (const t of ntPlan.themes) {
  const cov = ntIndex.byTheme.get(t.id)!;
  console.log(`  ${t.id.padEnd(32)} [${t.kind} ${t.hardness} w${t.weight.toFixed(1)}] ${t.coreSignal ? "core" : "    "}  ${t.coverage.padEnd(11)} ${cov.evidence.slice(0, 3).map((e) => `${e.source}:${e.strength}`).join(",") || "-"}`);
}
console.log(`\nprimaryStory: [${ntPlan.primaryStory.areaId}] ${ntPlan.primaryStory.label}`);
console.log(`  themes: ${ntPlan.primaryStory.themeIds.join(", ")}`);
console.log(`supportingThemes: ${ntPlan.supportingThemes.join(", ")}`);
console.log(`gaps: ${ntPlan.gaps.map((g) => `${g.themeId}(${g.coverage})`).join(", ")}`);
console.log(`terminology ALLOWED (covered themes only): ${Object.keys(ntPlan.terminology).join(", ")}`);
const blockedThemes = ntPlan.themes.filter((t) => !["DIRECT", "TRANSFERABLE"].includes(t.coverage)).map((t) => t.id);
console.log(`terminology BLOCKED (gap themes, no supporting evidence): ${blockedThemes.join(", ")}`);

// ---- marketing job for contrast ----
const mk = await requirementsFor("Digital Marketing Manager");
const mkThemes = themesFromV2(mk.reqs, mk.title);
const mkPlan = buildNarrativePlan(mkThemes.themes, mapThemesToEvidence(mkThemes.themes, pool), mk.title);
console.log(`\n===== MARKETING: ${mk.title} =====`);
console.log(`primaryStory: [${mkPlan.primaryStory.areaId}] ${mkPlan.primaryStory.label}  themes: ${mkPlan.primaryStory.themeIds.slice(0, 5).join(", ")}`);

// Before/after: the classifications from the pre-refinement token-overlap map.
const BEFORE: Record<string, string> = {
  "communication skills": "NONE", "multitasking": "NONE", "cross-functional project experience": "WEAK",
  "problem-solving": "WEAK", "milestone tracking": "WEAK", "executive reporting": "NONE", "microsoft office": "DIRECT",
};
console.log("\nBEFORE -> AFTER (corrected cases):");
for (const [id, before] of Object.entries(BEFORE)) {
  const after = ntIndex.byTheme.get(id)?.coverage ?? "(absent)";
  console.log(`  ${id.padEnd(34)} ${before.padEnd(6)} -> ${after}${before !== after ? "   [changed]" : ""}`);
}

console.log("\nassertions:");
const termFlat = Object.values(ntPlan.terminology).flat().join(" | ").toLowerCase();
const covOf = (id: string) => ntIndex.byTheme.get(id)?.coverage;
// --- regression locks for every corrected classification ---
ok(covOf("communication skills") === "DIRECT", "communication skills -> DIRECT (teaching 250+, client-facing, phone sales entail it)");
ok(covOf("multitasking") === "DIRECT", "multitasking -> DIRECT (verified concurrent brands/projects, shifting priorities)");
ok(covOf("cross-functional project experience") === "DIRECT", "cross-functional project experience -> DIRECT (cross-dept collaboration + project coordination)");
ok(covOf("problem-solving") === "DIRECT", "problem-solving -> DIRECT (solution development + client needs assessment)");
ok(covOf("milestone tracking") === "TRANSFERABLE", "milestone tracking -> TRANSFERABLE, not DIRECT (conservative)");
ok(covOf("executive reporting") !== "DIRECT" && covOf("executive reporting") !== "TRANSFERABLE", "executive reporting stays uncovered (no teaching->executive-reporting relation)", String(covOf("executive reporting")));
ok(!("executive reporting" in ntPlan.terminology), "executive reporting NOT in terminology");
// composite: all three components verified -> DIRECT is legitimate (not hiding a gap)
ok(covOf("microsoft office") === "DIRECT", "microsoft office DIRECT: Excel + PowerPoint + Word(=Google Docs) all verified");
// composite negative: drop the word-processing component -> must fall to TRANSFERABLE, never DIRECT
{
  const poolNoWord: VerifiedPool = { items: pool.items.filter((i) => !/google docs|microsoft word|\bword\b/i.test(i.text)), skillNames: pool.skillNames.filter((s) => !/google docs|microsoft word|\bword\b/i.test(s)) };
  const c = mapThemesToEvidence([{ term: "microsoft office" }], poolNoWord).byTheme.get("microsoft office")?.coverage;
  ok(c === "TRANSFERABLE", "composite with a missing component -> TRANSFERABLE, never DIRECT (umbrella cannot hide a gap)", String(c));
}

ok(ntPlan.primaryStory.areaId === "coordination", "NT primary story is cross-functional coordination", ntPlan.primaryStory.areaId);
ok(mkPlan.primaryStory.areaId === "marketing", "same profile -> marketing job's primary story is marketing", mkPlan.primaryStory.areaId);
ok(ntPlan.primaryStory.areaId !== mkPlan.primaryStory.areaId, "the same profile produces DIFFERENT primary stories per job");
// coverage is independent: a job theme is not possession
const cov = (id: string) => ntIndex.byTheme.get(id)?.coverage;
ok(cov("project coordination") === "DIRECT", "project coordination is DIRECT (verified skill)");
ok(cov("microsoft office") === "DIRECT", "microsoft office is DIRECT (umbrella via excel+powerpoint)");
// the four named gaps: visible as gaps, absent from terminology
for (const gapTerm of ["financial services experience", "power bi", "crm platforms"]) {
  const c = cov(gapTerm);
  ok(c === "NONE" || c === "WEAK", `${gapTerm} is a gap (${c})`, String(c));
  ok(!(gapTerm in ntPlan.terminology), `${gapTerm} NOT in allowed terminology`);
  ok(ntPlan.gaps.some((g) => g.themeId === gapTerm), `${gapTerm} appears in gaps`);
}
for (const banned of ["financial services", "wealth management", "power bi", "crm"]) {
  ok(!termFlat.includes(banned), `no terminology value contains "${banned}"`);
}
// referential, no duplication: a shared skill ref appears under multiple themes as the SAME ref
const refsOf = (id: string) => (ntIndex.byTheme.get(id)?.evidence ?? []).map((e) => e.ref);
ok(refsOf("project coordination").length > 0 && new Set(refsOf("project coordination")).size === refsOf("project coordination").length, "evidence refs within a theme are unique (no duplication)");
// plan is referential only: terminology keys are exactly the covered themes
const covered = ntPlan.themes.filter((t) => ["DIRECT", "TRANSFERABLE"].includes(t.coverage)).map((t) => t.id).sort();
ok(JSON.stringify(Object.keys(ntPlan.terminology).sort()) === JSON.stringify(covered), "terminology keys == covered themes exactly");

console.log(bad ? `\n${bad} FAILED` : `\nnarrative-plan-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
