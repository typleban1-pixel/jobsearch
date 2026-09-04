/**
 * Resume Builder v2, Step 1: richer responsibility extraction + multi-class
 * themes. Proves themesFromV2 admits the tool / experience / responsibility
 * signal that the v1 SKILL-only rule drops, weights and marks core themes,
 * and that RESPONSIBILITY survives extraction sanitisation -- all offline,
 * no DB, no model call. The v1 themesFrom is imported unchanged as the
 * baseline, so any drift in it would fail here too.
 */
import { themesFrom } from "../lib/applications/prepare.ts";
import { themesFromV2 } from "../lib/applications/themesV2.ts";
import { sanitizeRequirement } from "../lib/llm/extractRequirements.ts";

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };
const TITLE = "Specialist, Strategic Growth Programs";

// The 14 requirements production actually extracted for this Northern Trust
// posting (kinds as stored), verbatim normalized_term + raw_text + hardness.
const NT: any[] = [
  { normalized_term: "project coordination", raw_text: "Strong organizational and project coordination skills", is_hard_requirement: "HARD", kind: "SKILL" },
  { normalized_term: "communication skills", raw_text: "Excellent written, verbal, and presentation communication abilities", is_hard_requirement: "HARD", kind: "SKILL" },
  { normalized_term: "problem-solving", raw_text: "Analytical mindset with strong problem-solving capabilities", is_hard_requirement: "HARD", kind: "SKILL" },
  { normalized_term: "multitasking", raw_text: "Ability to manage multiple projects and priorities simultaneously", is_hard_requirement: "HARD", kind: "SKILL" },
  { normalized_term: "microsoft office", raw_text: "Proficiency in Microsoft PowerPoint, Excel, and Word", is_hard_requirement: "HARD", kind: "TOOL" },
  { normalized_term: "attention to detail", raw_text: "Strong attention to detail and follow-through", is_hard_requirement: "HARD", kind: "TRAIT" },
  { normalized_term: "collaboration", raw_text: "Ability to work effectively across teams and build collaborative relationships", is_hard_requirement: "HARD", kind: "SKILL" },
  { normalized_term: "financial services experience", raw_text: "Approximately 4-6 years of experience in financial services, wealth management, sales support, business analysis, project coordination, sales enablement, or a related field", is_hard_requirement: "PREFERRED", kind: "EXPERIENCE_YEARS" },
  { normalized_term: "work authorization", raw_text: "Applicants must be authorized to work in the U.S. without the need for employment-based visa sponsorship", is_hard_requirement: "HARD", kind: "LEGAL" },
  { normalized_term: "power bi", raw_text: "Proficiency Power BI or other business intelligence platforms preferred", is_hard_requirement: "PREFERRED", kind: "TOOL" },
  { normalized_term: "crm platforms", raw_text: "Proficiency in Customer Relationship Management (CRM) platforms preferred", is_hard_requirement: "PREFERRED", kind: "TOOL" },
  { normalized_term: "bachelor's degree", raw_text: "Bachelor's degree strongly preferred", is_hard_requirement: "PREFERRED", kind: "EDUCATION" },
  { normalized_term: "cross-functional project experience", raw_text: "Experience supporting cross-functional projects and business initiatives preferred", is_hard_requirement: "PREFERRED", kind: "EXPERIENCE_YEARS" },
  { normalized_term: "wealth management interest", raw_text: "Interest in wealth management, sales strategy, and business growth initiatives", is_hard_requirement: "UNCLEAR", kind: "TRAIT" },
];

// What the richer extractor (rule 6d) would additionally capture from this
// posting's "Key Responsibilities" section, kind RESPONSIBILITY.
const RESP: any[] = [
  { normalized_term: "executive reporting", raw_text: "Prepare presentations, meeting materials, status updates, and executive reporting for leadership stakeholders", is_hard_requirement: "HARD", kind: "RESPONSIBILITY" },
  { normalized_term: "milestone tracking", raw_text: "Track project milestones, action items, risks, and dependencies", is_hard_requirement: "HARD", kind: "RESPONSIBILITY" },
  { normalized_term: "process improvement", raw_text: "Support pilot programs, process improvements, and new business initiatives", is_hard_requirement: "HARD", kind: "RESPONSIBILITY" },
  { normalized_term: "competitive analysis", raw_text: "Conduct research and analysis related to market opportunities and competitive insights", is_hard_requirement: "HARD", kind: "RESPONSIBILITY" },
];

const v1 = themesFrom(NT, TITLE);
const v2 = themesFromV2(NT, TITLE);
const v2full = themesFromV2([...NT, ...RESP], TITLE);

console.log("V1 themes (SKILL-class only):\n  " + (v1.terms.join(", ") || "(none)"));
console.log("\nV2 themes (multi-class, weighted; * = core):\n  " + v2.themes.map((t) => `${t.core ? "*" : " "}${t.term}[${t.kind} w${t.weight.toFixed(1)}]`).join("\n  "));
console.log("\nV2 excludedByKind: " + JSON.stringify(v2.excludedByKind));
console.log("\nV2 + captured responsibilities (14+4):\n  " + v2full.terms.join(", "));

console.log("\nassertions:");
// The real v1 gap: classifyRequirement demotes the HARD soft-skill
// requirements to TRAIT/GENERIC, so v1 drops them entirely.
for (const dropped of ["communication skills", "collaboration", "problem-solving", "multitasking"]) {
  ok(!v1.terms.includes(dropped), `V1 drops the HARD soft-skill requirement "${dropped}"`);
  ok(v2.terms.includes(dropped), `V2 recovers "${dropped}"`);
}
// v1 keeps a low-value interest as a theme; v2 excludes the incidental TRAIT.
ok(v1.terms.includes("wealth management interest"), "V1 keeps 'wealth management interest' (incidental TRAIT)");
// V2 admits the richer classes
ok(v2.terms.includes("microsoft office"), "V2 admits microsoft office (TOOL)");
ok(v2.terms.includes("cross-functional project experience"), "V2 admits cross-functional project experience (EXPERIENCE_YEARS)");
ok(v2.terms.includes("financial services experience"), "V2 surfaces financial-services as a JOB theme (coverage decided later, never implied)");
// V2 excludes gates and incidental traits
for (const drop of ["work authorization", "bachelor's degree", "attention to detail", "wealth management interest"]) {
  ok(!v2.terms.includes(drop), `V2 excludes ${drop}`);
}
// Core marking: HARD -> core; PREFERRED -> not core
ok(v2.themes.find((t) => t.term === "project coordination")?.core === true, "project coordination is core (HARD)");
ok(v2.themes.find((t) => t.term === "power bi")?.core === false, "power bi is not core (PREFERRED)");
// Responsibilities captured and core
for (const r of ["executive reporting", "milestone tracking", "process improvement", "competitive analysis"]) {
  const t = v2full.themes.find((x) => x.term === r);
  ok(!!t && t.kind === "RESPONSIBILITY" && t.core, `V2 captures responsibility "${r}" as a core theme`);
}
// Weight ordering sane: a HARD SKILL outweighs a PREFERRED TOOL
ok((v2.themes.find((t) => t.term === "project coordination")?.weight ?? 0) > (v2.themes.find((t) => t.term === "power bi")?.weight ?? 9), "HARD SKILL outweighs PREFERRED TOOL");
// RESPONSIBILITY survives extraction sanitisation (not coerced to OTHER)
const s = sanitizeRequirement({ raw_text: "Track project milestones and dependencies", normalized_term: "milestone tracking", kind: "RESPONSIBILITY", is_hard_requirement: "HARD", hard_requirement_reason: "", minimum_years: null, confidence: 0.9 });
ok(!!s && s.requirement.kind === "RESPONSIBILITY" && s.coercions.every((c) => c.field !== "kind"), "sanitizeRequirement keeps RESPONSIBILITY (not coerced to OTHER)");

console.log(bad ? `\n${bad} FAILED` : `\nthemes-v2-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
