/**
 * Resume Builder v2, Step 3C: employer-language reframing. No model call.
 * Builds the real allowlisted reframe context from the NT NarrativePlan, and
 * validates FIXED reframe / adversarial outputs against the authoritative
 * checkGrounding. Proves: gap terminology can never enter the prompt; good
 * reframes pass; every category of overstatement is rejected; transferable
 * evidence cannot be rewritten as direct; and the same accomplishment reframes
 * differently per job while the factual proposition stays invariant.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { themesFromV2 } from "../lib/applications/themesV2.ts";
import { mapThemesToEvidence, type VerifiedPool, type EvidenceItem } from "../lib/render/evidenceMap.ts";
import { buildNarrativePlan } from "../lib/render/narrativePlan.ts";
import { buildReframeContext, buildReframeUserPrompt } from "../lib/render/reframeV2.ts";
import { checkGrounding } from "../lib/render/grounding.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const pageAll = async (t: string, r: (q: any) => any = (q) => q) => { const o: any[] = []; for (let f = 0; ; f += 1000) { const { data } = await r(db.from(t).select("*")).range(f, f + 999); o.push(...(data ?? [])); if (!data || data.length < 1000) break; } return o; };

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

// pool + NT plan + profile vocabulary
const rows = await pageAll("profile_version_rows", (q) => q.eq("profile_version", 16));
const bySrc: Record<string, any[]> = {}; for (const r of rows) (bySrc[r.source_table] = bySrc[r.source_table] || []).push(r.row_data);
const items: EvidenceItem[] = []; const skillNames: string[] = []; const vocabParts: string[] = [];
for (const s of bySrc.skills ?? []) { items.push({ ref: s.id ?? s.name, source: "skills", text: s.name ?? "" }); skillNames.push(s.name ?? ""); vocabParts.push(s.name ?? ""); }
for (const e of bySrc.evidence ?? []) { const t = `${e.detail ?? ""} ${e.summary ?? ""}`.trim(); items.push({ ref: e.id, source: "evidence", text: t }); vocabParts.push(t); }
const { data: masterRow } = await db.from("resumes").select("content").eq("is_master", true).ilike("label", "%version 16%").maybeSingle();
if ((masterRow?.content as any)?.markdown) { items.push({ ref: "master-md", source: "master", text: String((masterRow?.content as any).markdown) }); vocabParts.push(String((masterRow?.content as any).markdown)); }
const pool: VerifiedPool = { items, skillNames: skillNames.filter(Boolean) };
const profileVocabulary = vocabParts.join(" \n ");

const NT_ID = "383a5c26-0f99-4a13-8c5d-8c9170504d27";
const ntReqs = await pageAll("job_requirements", (q) => q.eq("job_id", NT_ID));
const NT_RESP = [{ normalized_term: "process improvement", raw_text: "Support pilot programs and process improvements", is_hard_requirement: "HARD", kind: "RESPONSIBILITY" }];
const ntThemes = themesFromV2([...ntReqs, ...NT_RESP], "Northern Trust").themes;
const ntPlan = buildNarrativePlan(ntThemes, mapThemesToEvidence(ntThemes, pool), "Northern Trust");
const { data: ntDesc } = await db.from("job_descriptions").select("description_text").eq("job_id", NT_ID).maybeSingle();
const targetJobText = ntDesc?.description_text ?? "";

// ---- 1. allowlist: gap terminology and raw JD can never enter the prompt ----
const ctx = buildReframeContext(["ev-1"], ["collaboration", "project coordination", "communication skills"], ntPlan);
const prompt = buildReframeUserPrompt(["Collaborated cross-functionally with marketing and other teams to run projects from planning through delivery."], "Collaborated cross-functionally...", ctx);
console.log("allowlist:");
const termFlat = ctx.allowedTerminology.join(" | ").toLowerCase();
for (const banned of ["financial services", "wealth management", "power bi", "crm", "executive reporting"]) {
  ok(!termFlat.includes(banned), `allowed terminology never contains "${banned}"`);
  ok(!prompt.toLowerCase().includes(banned), `reframe prompt never contains "${banned}"`);
}
ok(!prompt.includes(targetJobText.slice(0, 80)) && prompt.length < targetJobText.length, "the raw job description is not in the prompt");

// ---- helper to run the real guard ----
const evidenceText = "Collaborated cross-functionally with marketing and other teams to set creative approaches and run projects from planning through delivery.";
const grd = (claim: string, source = evidenceText, original = evidenceText, ids = ["ev-1"]) =>
  checkGrounding({ claim, evidenceIds: ids, sourceText: source, original, targetJobText, profileVocabulary, approvedMetrics: [], knownEntities: skillNames });

// ---- 2. good reframes pass (kept within the evidence's own role framing) ----
console.log("\ngood reframes (checkGrounding must accept; note: verb stays 'collaborated', not promoted):");
const goods = [
  "Collaborated cross-functionally with marketing and other teams to run projects from planning through delivery.",
  "Collaborated cross-functionally with marketing and other teams to set creative approaches and run projects from planning through delivery.",
];
for (const g of goods) { const v = grd(g); ok(v.ok, `accepts: "${g.slice(0, 60)}..."`, v.ok ? "" : `${v.failedCheck}: ${v.failureDetail}`); }

// ---- NT before -> after demonstration for selected bullets ----
console.log("\nNorthern Trust before -> after (each reframe grounded):");
const demoBullets = [
  { original: "Produced creative work across multiple brands, internal teams, and concurrent projects with shifting priorities and deadlines.", themes: ["multitasking", "collaboration"], reframed: "Produced work across multiple brands, internal teams, and concurrent projects under shifting priorities and deadlines.", note: "foregrounded concurrent projects and shifting priorities; verb kept as 'produced' (an earlier 'managed' draft was correctly rejected by checkGrounding as scope escalation)" },
  { original: "Collaborated cross-functionally with marketing and other teams to set creative approaches and run projects from planning through delivery.", themes: ["collaboration", "project coordination"], reframed: "Collaborated cross-functionally with marketing and other teams to run projects from planning through delivery.", note: "foregrounded project delivery; verb kept as 'collaborated' (not promoted to led/managed)" },
];
for (const d of demoBullets) {
  const c = buildReframeContext(["ev-demo"], d.themes, ntPlan);
  const v = checkGrounding({ claim: d.reframed, evidenceIds: ["ev-demo"], sourceText: d.original, original: d.original, targetJobText, profileVocabulary, knownEntities: skillNames });
  console.log(`  ORIGINAL:    ${d.original}`);
  console.log(`  themes:      ${d.themes.join(", ")}   terminology supplied: ${c.allowedTerminology.slice(0, 6).join("; ") || "(none)"}`);
  console.log(`  REFRAMED:    ${d.reframed}`);
  console.log(`  evidenceIds: ev-demo   grounding: ${v.ok ? "OK" : v.failedCheck}   transform: ${d.note}`);
  ok(v.ok, `NT bullet reframe is grounded`, v.ok ? "" : `${v.failedCheck}: ${v.failureDetail}`);
}

// ---- 3. adversarial: every category of overstatement is rejected ----
console.log("\nadversarial (checkGrounding must reject):");
const adversarial: Record<string, string> = {
  "ownership": "Owned a strategic growth program from planning through delivery.",
  "employer domain": "Led Wealth Management growth initiatives across teams.",
  "unsupported tools": "Ran cross-functional projects and built reporting in Power BI.",
  "unsupported metrics": "Coordinated 12 cross-functional workstreams from planning through delivery.",
  "unsupported scope": "Managed enterprise workstreams across the organization.",
  "unsupported duration": "Ran cross-functional projects from planning through delivery over six years.",
  "unsupported management": "Managed a cross-functional team across marketing and other teams.",
  "executive/stakeholder context": "Prepared executive reporting for senior leadership on project delivery.",
};
for (const [cat, claim] of Object.entries(adversarial)) { const v = grd(claim); ok(!v.ok, `rejects ${cat}`, v.ok ? "WRONGLY ACCEPTED" : `${v.failedCheck}`); }

// ---- 4. transferable evidence cannot be rewritten as direct ----
console.log("\ntransferable -> direct is rejected:");
const transferEvidence = "Contributed to product ideation and iterative development, defining requirements and shaping features.";
const tGood = checkGrounding({ claim: "Contributed to product ideation and iterative development, helping define requirements.", evidenceIds: ["ev-t"], sourceText: transferEvidence, original: transferEvidence, targetJobText, profileVocabulary, knownEntities: skillNames });
ok(tGood.ok, "accepts a transferable claim kept transferable (contributed to / helped define)");
const tBad = checkGrounding({ claim: "Owned the product roadmap and led product strategy end to end.", evidenceIds: ["ev-t"], sourceText: transferEvidence, original: transferEvidence, targetJobText, profileVocabulary, knownEntities: skillNames });
ok(!tBad.ok, "rejects upgrading transferable product work into owned/led product management", tBad.ok ? "WRONGLY ACCEPTED" : String(tBad.failedCheck));

// ---- 5. same accomplishment, different legitimate framing, invariant fact ----
console.log("\nsame accomplishment, per-job framing (all grounded):");
const perJob: Record<string, string> = {
  coordination: "Collaborated cross-functionally with marketing and other teams to run projects from planning through delivery.",
  marketing: "Collaborated with marketing to set creative approaches and run projects from planning through delivery.",
  operations: "Collaborated cross-functionally with other teams to run projects from planning through delivery.",
};
for (const [job, claim] of Object.entries(perJob)) { const v = grd(claim); ok(v.ok, `${job} framing is grounded`, v.ok ? "" : `${v.failedCheck}: ${v.failureDetail}`); }

console.log(bad ? `\n${bad} FAILED` : `\nreframe-v2-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
