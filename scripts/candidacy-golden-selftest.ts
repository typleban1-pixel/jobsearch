/**
 * The persistent candidacy golden set.
 *
 * End-to-end: raw requirement text -> classification -> resolution ->
 * composite -> candidacy, against Ty's REAL verified profile (built from
 * the DB, plus the proposed relations overlay in data/candidacy-relations.json).
 * This is the regression net that stops us re-discovering false negatives
 * and false positives one job at a time.
 *
 *   node scripts/candidacy-golden-selftest.ts            # dev set
 *   node scripts/candidacy-golden-selftest.ts --holdout  # + held-out set
 *
 * Bands (asymmetric on purpose):
 *   SURFACE       a reasonable adjacent opportunity: must NOT be REJECT.
 *   STRETCH_ONLY  adjacent AND transferable-only: surfaced, never an
 *                 autonomous APPLICATION_CANDIDATE.
 *   REJECT        a genuine occupational/credential incompatibility.
 *   NOT_SURFACE   a clear non-fit that must never reach STRETCH/CANDIDATE
 *                 (REJECT or MANUAL_REVIEW both acceptable).
 *
 * The HOLDOUT set is authored to the same bands but was NOT consulted
 * while tuning the rules, so passing it is evidence of generalization,
 * not of fitting the examples (Part D).
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { TermMatcher } from "../lib/matching/match.ts";
import { toConcept } from "../lib/matching/concepts.ts";
import { buildFitBreakdown } from "../lib/scoring/fit.ts";
import type { CapabilityIndex } from "../lib/scoring/capability.ts";
import { assessCandidacy, type RequirementRow } from "../lib/scoring/candidacy.ts";
import { buildEvidenceContext } from "../lib/scoring/evidenceResolution.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const page = async (t: string, c: string) => { const o: any[] = [];
  for (let f = 0; ; f += 1000) { const { data, error } = await db.from(t).select(c).range(f, f + 999);
    if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (!data || data.length < 1000) break; } return o; };

const allSkills = await page("skills", "id,name,related_terms,status,level,category");
const aliases = await page("term_aliases", "alias,canonical_term");
const matcher = new TermMatcher(allSkills.map((s: any) => ({ id: s.id, name: s.name, relatedTerms: s.related_terms ?? [], status: s.status })), aliases as any);
const verified = new Set(allSkills.filter((s: any) => s.status === "VERIFIED").map((s: any) => s.name));
const relations = new Map<string, any>();
for (const r of await page("capability_relations", "requirement_concept,satisfied_by_skill,relation,rationale")) {
  if (!verified.has(r.satisfied_by_skill)) continue;
  relations.set(toConcept(r.requirement_concept).concept, { skill: r.satisfied_by_skill, relation: r.relation, rationale: r.rationale }); }
// Golden set always includes the proposed relations, because it tests the
// deployed-intent engine, not a half-applied state.
for (const r of (JSON.parse(readFileSync("data/candidacy-relations.json", "utf8")).relations as any[])) {
  if (!verified.has(r.satisfied_by_skill)) continue;
  relations.set(toConcept(r.requirement_concept).concept, { skill: r.satisfied_by_skill, relation: r.relation, rationale: r.rationale }); }
const index: CapabilityIndex = { relations, matchTerm: (t: string) => { const m = matcher.match(t); return { status: m.status, skillName: m.skillName, method: m.method, terminal: m.terminal }; } };
const { data: credDecl } = await db.from("credential_declarations").select("family,status");
const cred: Record<string, string> = {}; for (const c of credDecl ?? []) cred[c.family] = c.status;
const { data: eduRows } = await db.from("education").select("credential,field_of_study,status,completed");
const edu = (eduRows ?? []).filter((e: any) => e.status === "VERIFIED" && e.completed).map((e: any) => ({
  level: /master|mba/i.test(e.credential ?? "") ? "MASTER" : /associate/i.test(e.credential ?? "") ? "ASSOCIATE" : "BACHELOR", field: e.field_of_study ?? null }));
const metrics = await page("metrics", "label,unit,numeric_value,approved_for_use");
const evidenceContext = buildEvidenceContext({ skills: allSkills as any, metrics: metrics as any, notHeld: [] });

type Band = "SURFACE" | "STRETCH_ONLY" | "REJECT" | "NOT_SURFACE";
interface R { t: string; h?: "HARD" | "PREFERRED"; k?: string; yrs?: number; g?: string; c?: string }
interface Case { title: string; band: Band; reqs: R[]; note?: string; holdout?: boolean }
let i = 0;
const req = (job: string, r: R): any => ({ id: `${job}-${i++}`, raw_text: r.t, normalized_term: r.t,
  is_hard_requirement: r.h ?? "HARD", kind: r.k ?? "SKILL", minimum_years: r.yrs ?? null,
  alternative_group: r.g ?? null, conjunct_key: r.c ?? null });

const assess = (cse: Case) => {
  const reqs = cse.reqs.map((r) => req(cse.title, r));
  const fit = buildFitBreakdown(reqs, cse.title, index, cred, edu as any, null, 0, evidenceContext);
  return assessCandidacy({ jobTitle: cse.title, fit, requirements: reqs as RequirementRow[], credentialDeclarations: cred });
};
const inBand = (v: string, b: Band) =>
  b === "SURFACE" ? v !== "REJECT"
  : b === "STRETCH_ONLY" ? v !== "REJECT" && v !== "APPLICATION_CANDIDATE"
  : b === "REJECT" ? v === "REJECT"
  : /* NOT_SURFACE */ v === "REJECT" || v === "MANUAL_REVIEW";

const CASES: Case[] = [
  // ---------- adjacent / reasonable: must SURFACE ----------
  { title: "Product Operations Analyst", band: "STRETCH_ONLY", reqs: [
    { t: "product operations or related field", h: "HARD", k: "EXPERIENCE_YEARS" },
    { t: "analyze and improve operational workflows", h: "HARD", k: "RESPONSIBILITY" },
    { t: "cross-functional collaboration", h: "PREFERRED", k: "TRAIT" },
    { t: "spreadsheet modeling in excel", h: "HARD", k: "SKILL" },
    { t: "early-career professional", h: "HARD", k: "EXPERIENCE_YEARS" } ] },
  { title: "Strategy & Operations Analyst", band: "STRETCH_ONLY", reqs: [
    { t: "management consulting, investment banking, or high-growth startup", h: "HARD", k: "EXPERIENCE_YEARS", g: "so-1", c: "a" },
    { t: "excel", h: "HARD", k: "SKILL" },
    { t: "financial modeling", h: "HARD", k: "SKILL" } ], note: "high-growth startup branch is satisfiable (RentPup)" },
  { title: "Business Operations Manager", band: "STRETCH_ONLY", reqs: [
    { t: "business operations experience", h: "HARD", k: "EXPERIENCE_YEARS" },
    { t: "process improvement", h: "HARD", k: "SKILL" },
    { t: "manage cross-functional projects", h: "HARD", k: "RESPONSIBILITY" },
    { t: "stakeholder management", h: "PREFERRED", k: "SKILL" } ] },
  { title: "Customer Success Manager", band: "STRETCH_ONLY", reqs: [
    { t: "customer success or account management", h: "HARD", k: "EXPERIENCE_YEARS" },
    { t: "client needs assessment", h: "HARD", k: "SKILL" },
    { t: "manage a book of client relationships", h: "PREFERRED", k: "RESPONSIBILITY" } ] },
  { title: "Digital Marketing Manager", band: "SURFACE", reqs: [
    { t: "paid media and performance marketing", h: "HARD", k: "SKILL" },
    { t: "seo", h: "HARD", k: "SKILL" },
    { t: "email marketing", h: "HARD", k: "SKILL" },
    { t: "campaign measurement and attribution", h: "HARD", k: "SKILL" } ], note: "several DIRECT marketing matches" },
  { title: "Ecommerce Operations Manager", band: "SURFACE", reqs: [
    { t: "ecommerce", h: "HARD", k: "SKILL" },
    { t: "shopify", h: "HARD", k: "TOOL" },
    { t: "conversion testing", h: "HARD", k: "SKILL" },
    { t: "workflow automation", h: "PREFERRED", k: "SKILL" } ] },
  { title: "Program Manager, Operations", band: "STRETCH_ONLY", reqs: [
    { t: "program management", h: "HARD", k: "EXPERIENCE_YEARS" },
    { t: "project coordination", h: "HARD", k: "SKILL" },
    { t: "coordinate across cross-functional teams", h: "PREFERRED", k: "RESPONSIBILITY" } ] },

  // ---------- negative controls: must REJECT ----------
  { title: "Software Engineer", band: "REJECT", reqs: [
    { t: "python", h: "HARD", k: "SKILL" }, { t: "java", h: "HARD", k: "SKILL" },
    { t: "distributed systems design", h: "HARD", k: "SKILL" },
    { t: "rest api development", h: "HARD", k: "SKILL" },
    { t: "bachelor's degree in computer science", h: "HARD", k: "EDUCATION" } ] },
  { title: "Senior Backend Engineer", band: "REJECT", reqs: [
    { t: "backend systems design at scale", h: "HARD", k: "SKILL" },
    { t: "golang or java", h: "HARD", k: "SKILL", g: "be-1", c: "a" },
    { t: "kubernetes", h: "HARD", k: "TOOL" }, { t: "postgresql", h: "HARD", k: "TOOL" } ] },
  { title: "Data Scientist", band: "REJECT", reqs: [
    { t: "statistical modeling", h: "HARD", k: "SKILL" },
    { t: "machine learning", h: "HARD", k: "SKILL" },
    { t: "python and sql", h: "HARD", k: "SKILL" },
    { t: "phd in statistics or a quantitative field", h: "HARD", k: "EDUCATION" } ] },
  { title: "Staff Accountant", band: "REJECT", reqs: [
    { t: "gaap accounting", h: "HARD", k: "SKILL" },
    { t: "financial statement preparation", h: "HARD", k: "SKILL" },
    { t: "general ledger reconciliation", h: "HARD", k: "SKILL" },
    { t: "month-end close", h: "HARD", k: "SKILL" } ] },
  { title: "Litigation Attorney", band: "REJECT", reqs: [
    { t: "juris doctor degree", h: "HARD", k: "EDUCATION" },
    { t: "admitted to the bar", h: "HARD", k: "CREDENTIAL" },
    { t: "civil litigation", h: "HARD", k: "SKILL" } ] },
  { title: "Registered Nurse, ICU", band: "REJECT", reqs: [
    { t: "rn license", h: "HARD", k: "CREDENTIAL" },
    { t: "acute patient care", h: "HARD", k: "SKILL" },
    { t: "clinical assessment", h: "HARD", k: "SKILL" } ] },
  { title: "Quantitative Trader", band: "REJECT", reqs: [
    { t: "stochastic calculus", h: "HARD", k: "SKILL" },
    { t: "derivatives pricing", h: "HARD", k: "SKILL" },
    { t: "c++ low-latency programming", h: "HARD", k: "SKILL" } ] },
  { title: "Account Executive, Enterprise SaaS", band: "NOT_SURFACE", reqs: [
    { t: "enterprise saas quota-carrying sales", h: "HARD", k: "EXPERIENCE_YEARS" },
    { t: "closing six-figure deals", h: "HARD", k: "SKILL" },
    { t: "salesforce pipeline management", h: "HARD", k: "TOOL" },
    { t: "consistent quota attainment", h: "HARD", k: "SKILL" } ] },
  { title: "Revenue Operations Analyst", band: "REJECT", reqs: [
    { t: "revenue operations", h: "HARD", k: "EXPERIENCE_YEARS" },
    { t: "salesforce administration", h: "HARD", k: "TOOL" },
    { t: "marketing automation platforms", h: "HARD", k: "TOOL" },
    { t: "lead scoring and attribution frameworks", h: "HARD", k: "SKILL" } ], note: "revenue operations is a specialist discipline; composite guard preserves the gap" },
  { title: "Product Marketing Manager", band: "NOT_SURFACE", reqs: [
    { t: "product positioning and messaging", h: "HARD", k: "SKILL" },
    { t: "competitive intelligence", h: "HARD", k: "SKILL" },
    { t: "sales enablement content", h: "HARD", k: "SKILL" },
    { t: "product marketing", h: "HARD", k: "EXPERIENCE_YEARS", yrs: 5 } ], note: "true PMM discipline: positioning/messaging/enablement all absent" },

  // ---------- boundary cases ----------
  { title: "Operations Analyst (missing preferred tool)", band: "SURFACE", reqs: [
    { t: "process improvement", h: "HARD", k: "SKILL" },
    { t: "excel", h: "HARD", k: "SKILL" },
    { t: "tableau", h: "PREFERRED", k: "TOOL" } ], note: "missing preferred tool must not sink an otherwise-strong fit" },
  { title: "Operations Analyst (missing MANDATORY specialist tool)", band: "NOT_SURFACE", reqs: [
    { t: "advanced production sql", h: "HARD", k: "SKILL" },
    { t: "python data pipelines", h: "HARD", k: "SKILL" },
    { t: "dbt and airflow", h: "HARD", k: "TOOL" } ], note: "mandatory data-engineering stack is a real gap" },
  { title: "Operations Coordinator (degree or equivalent experience)", band: "SURFACE", reqs: [
    { t: "bachelor's degree in business or equivalent experience", h: "HARD", k: "EDUCATION" },
    { t: "project coordination", h: "HARD", k: "SKILL" },
    { t: "workflow design", h: "HARD", k: "SKILL" } ], note: "degree-or-equivalent must not reject on field" },
  { title: "Marketing Coordinator (Health Science-adjacent degree)", band: "SURFACE", reqs: [
    { t: "bachelor's degree in marketing, communications, or a related field", h: "HARD", k: "EDUCATION" },
    { t: "email marketing", h: "HARD", k: "SKILL" },
    { t: "campaign execution", h: "HARD", k: "SKILL" } ], note: "different degree field must not gate an otherwise strong fit" },
];

// ---------- HOLDOUT (not consulted while tuning) ----------
// ---- implementation / automation / AI-ENABLEMENT family (the "person
//      between the business problem and the technology") ----------------
const IMPL_FAMILY: Case[] = [
  { title: "Implementation Manager", band: "STRETCH_ONLY", reqs: [
    { t: "implement business systems and software for clients", h: "HARD", k: "EXPERIENCE_YEARS" },
    { t: "configure saas platforms", h: "HARD", k: "SKILL" },
    { t: "coordinate cross-functional rollout", h: "HARD", k: "RESPONSIBILITY" },
    { t: "drive user adoption", h: "PREFERRED", k: "RESPONSIBILITY" },
    { t: "process improvement", h: "HARD", k: "SKILL" } ], note: "transferable implementation/process/integration evidence" },
  { title: "Business Process Automation Analyst", band: "SURFACE", reqs: [
    { t: "business process automation", h: "HARD", k: "SKILL" },
    { t: "workflow design", h: "HARD", k: "SKILL" },
    { t: "analyze and improve operational processes", h: "HARD", k: "RESPONSIBILITY" },
    { t: "no-code automation tools", h: "PREFERRED", k: "TOOL" } ] },
  { title: "AI Enablement Manager", band: "STRETCH_ONLY", reqs: [
    { t: "ai enablement", h: "HARD", k: "EXPERIENCE_YEARS" },
    { t: "workflow automation", h: "HARD", k: "SKILL" },
    { t: "implement llm-enabled workflows", h: "HARD", k: "RESPONSIBILITY" },
    { t: "change management and user adoption", h: "PREFERRED", k: "RESPONSIBILITY" } ], note: "USING/adopting AI, not building models" },
  { title: "Digital Transformation Consultant", band: "STRETCH_ONLY", reqs: [
    { t: "digital transformation", h: "HARD", k: "EXPERIENCE_YEARS" },
    { t: "process redesign", h: "HARD", k: "SKILL" },
    { t: "technology implementation", h: "HARD", k: "SKILL" },
    { t: "stakeholder management", h: "PREFERRED", k: "SKILL" } ] },
  { title: "Business Systems Analyst", band: "STRETCH_ONLY", reqs: [
    { t: "business systems", h: "HARD", k: "EXPERIENCE_YEARS" },
    { t: "systems integration", h: "HARD", k: "SKILL" },
    { t: "requirements gathering and documentation", h: "HARD", k: "RESPONSIBILITY" } ] },
  // --- too-technical: BUILDING AI / software / infra -> REJECT ---
  { title: "Machine Learning Engineer", band: "REJECT", reqs: [
    { t: "machine learning model development", h: "HARD", k: "SKILL" },
    { t: "pytorch and tensorflow", h: "HARD", k: "TOOL" },
    { t: "python and statistics", h: "HARD", k: "SKILL" },
    { t: "phd or ms in computer science or machine learning", h: "HARD", k: "EDUCATION" } ] },
  { title: "AI Infrastructure Engineer", band: "REJECT", reqs: [
    { t: "model serving infrastructure at scale", h: "HARD", k: "SKILL" },
    { t: "kubernetes and gpu clusters", h: "HARD", k: "TOOL" },
    { t: "distributed systems engineering", h: "HARD", k: "SKILL" } ] },
  { title: "Enterprise SAP Implementation Consultant", band: "NOT_SURFACE", reqs: [
    { t: "sap s/4hana configuration", h: "HARD", k: "SKILL" },
    { t: "abap development", h: "HARD", k: "SKILL" },
    { t: "5+ years of sap implementation", h: "HARD", k: "EXPERIENCE_YEARS", yrs: 5 } ], note: "specialist ERP config Ty does not have" },
  // --- generic PM unrelated to tech/process implementation -> REJECT ---
  { title: "Construction Project Manager", band: "REJECT", reqs: [
    { t: "construction project scheduling", h: "HARD", k: "SKILL" },
    { t: "subcontractor and trade management", h: "HARD", k: "SKILL" },
    { t: "building codes and osha compliance", h: "HARD", k: "SKILL" },
    { t: "on-site construction supervision", h: "HARD", k: "RESPONSIBILITY" } ] },
];

const HOLDOUT: Case[] = [
  { title: "Operations Analyst, Product", band: "STRETCH_ONLY", holdout: true, reqs: [
    { t: "product operations", h: "HARD", k: "EXPERIENCE_YEARS" },
    { t: "optimize operational workflows", h: "HARD", k: "RESPONSIBILITY" },
    { t: "excel", h: "HARD", k: "SKILL" } ], note: "metamorphic sibling of Product Operations Analyst; same band" },
  { title: "Implementation Consultant", band: "STRETCH_ONLY", holdout: true, reqs: [
    { t: "software implementation and onboarding", h: "HARD", k: "EXPERIENCE_YEARS" },
    { t: "client needs assessment", h: "HARD", k: "SKILL" },
    { t: "solution development", h: "HARD", k: "SKILL" } ] },
  { title: "Category Manager, Ecommerce", band: "SURFACE", holdout: true, reqs: [
    { t: "ecommerce merchandising", h: "HARD", k: "SKILL" },
    { t: "shopify or bigcommerce", h: "HARD", k: "TOOL", g: "cm-1", c: "a" },
    { t: "conversion testing", h: "HARD", k: "SKILL" } ] },
  { title: "GTM Strategy & Operations", band: "STRETCH_ONLY", holdout: true, reqs: [
    { t: "go-to-market strategy", h: "HARD", k: "EXPERIENCE_YEARS" },
    { t: "translating strategy into execution", h: "HARD", k: "TRAIT" },
    { t: "cross-functional program coordination", h: "HARD", k: "RESPONSIBILITY" },
    { t: "campaign measurement and attribution", h: "HARD", k: "SKILL" } ], note: "soft trait must not become a role-defining gap" },
  { title: "Security Engineer", band: "REJECT", holdout: true, reqs: [
    { t: "application security", h: "HARD", k: "SKILL" },
    { t: "penetration testing", h: "HARD", k: "SKILL" },
    { t: "secure code review in java and python", h: "HARD", k: "SKILL" } ] },
  { title: "Clinical Research Coordinator", band: "NOT_SURFACE", holdout: true, reqs: [
    { t: "clinical trial protocol management", h: "HARD", k: "SKILL" },
    { t: "irb submissions", h: "HARD", k: "SKILL" },
    { t: "patient recruitment and consent", h: "HARD", k: "SKILL" } ] },
  { title: "Financial Analyst, FP&A", band: "REJECT", holdout: true, reqs: [
    { t: "financial planning and analysis", h: "HARD", k: "EXPERIENCE_YEARS" },
    { t: "three-statement financial modeling", h: "HARD", k: "SKILL" },
    { t: "variance analysis and forecasting", h: "HARD", k: "SKILL" } ] },
];

let bad = 0, run = 0;
const runSet = (cases: Case[], label: string) => {
  console.log(`\n=== ${label} (${cases.length}) ===`);
  for (const cse of cases) {
    const r = assess(cse); run++;
    const pass = inBand(r.verdict, cse.band);
    if (!pass) bad++;
    console.log(`  ${pass ? "PASS" : "FAIL"}  [${cse.band.padEnd(12)}] ${r.verdict.padEnd(21)} ${cse.title}`);
    if (!pass) console.log(`         got ${r.reasonCodes[0]}: ${r.reason}`);
  }
};
runSet(CASES, "DEV");
runSet(IMPL_FAMILY, "IMPLEMENTATION/AI-ENABLEMENT FAMILY");
if (process.argv.includes("--holdout")) runSet(HOLDOUT, "HOLDOUT");
console.log(`\n${run - bad}/${run} passed${bad ? ` -- ${bad} FAILED` : ""}`);
process.exit(bad ? 1 : 0);
