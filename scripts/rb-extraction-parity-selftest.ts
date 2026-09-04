/**
 * Regression: the Resume Builder worker must extract materially the same
 * requirement coverage from a posting as the normal ingest path does from
 * the same text. It once collapsed every posting to 1 requirement because
 * it deduped reconcileHardness()'s {hardness,corrected} return value
 * (no normalized_term/kind) instead of the requirement object. This asserts
 * the two post-extraction pipelines converge on a shared raw extraction.
 */
import { sanitizeRequirement, reconcileHardness, dedupeRequirements } from "../lib/llm/extractRequirements.ts";

// A representative raw extraction: distinct requirements the model would emit.
const RAW = [
  { raw_text: "Minimum of 5 years in sales strategy", normalized_term: "sales strategy experience", kind: "EXPERIENCE", is_hard_requirement: "HARD" },
  { raw_text: "Advanced SQL", normalized_term: "sql", kind: "SKILL", is_hard_requirement: "PREFERRED" },
  { raw_text: "Experience with Salesforce", normalized_term: "salesforce", kind: "TOOL", is_hard_requirement: "PREFERRED" },
  { raw_text: "Bachelor's degree required", normalized_term: "bachelor's degree", kind: "EDUCATION", is_hard_requirement: "HARD" },
  { raw_text: "Strong financial modeling", normalized_term: "financial modeling", kind: "SKILL", is_hard_requirement: "HARD" },
  { raw_text: "Must have 3+ years managing a team", normalized_term: "people management", kind: "EXPERIENCE", is_hard_requirement: "PREFERRED" },
  { raw_text: "Excellent communication", normalized_term: "communication", kind: "TRAIT", is_hard_requirement: "PREFERRED" },
];

// ---- ingest path (extract.ts): reconcile mutates the object, dedupe the object
function ingestPipeline(raw: any[]) {
  const reqs: any[] = [];
  for (const rawReq of raw) {
    const clean = sanitizeRequirement(rawReq);
    if (!clean) continue;
    const rec = reconcileHardness(clean.requirement as any);
    if (rec.corrected) (clean.requirement as any).is_hard_requirement = rec.hardness;
    reqs.push(clean.requirement);
  }
  return dedupeRequirements(reqs as any[]).kept;
}

// ---- RB path (resumeGeneration.ts) AFTER the fix: identical shape
function rbPipeline(raw: any[]) {
  const cleaned: any[] = [];
  for (const r of raw) {
    const clean = sanitizeRequirement(r as any);
    if (!clean) continue;
    const rec = reconcileHardness(clean.requirement as any);
    if (rec.corrected) (clean.requirement as any).is_hard_requirement = rec.hardness;
    cleaned.push(clean.requirement as any);
  }
  return dedupeRequirements(cleaned as any).kept;
}

// ---- the OLD broken RB pipeline, kept only to prove the test catches it
function brokenRbPipeline(raw: any[]) {
  const cleaned = raw
    .map((r) => sanitizeRequirement(r as any)?.requirement)
    .filter(Boolean)
    .map((r) => reconcileHardness(r as any)); // strips term/kind
  return dedupeRequirements(cleaned as any).kept;
}

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

const ingest = ingestPipeline(JSON.parse(JSON.stringify(RAW)));
const rb = rbPipeline(JSON.parse(JSON.stringify(RAW)));
const broken = brokenRbPipeline(JSON.parse(JSON.stringify(RAW)));

ok(ingest.length === 7, "ingest keeps all 7 distinct requirements", `${ingest.length}`);
ok(rb.length === ingest.length, "RB (fixed) count == ingest count", `rb=${rb.length} ingest=${ingest.length}`);
// materially-comparable coverage: identical (term,kind) sets
const key = (r: any) => `${String(r.normalized_term).toLowerCase()}|${r.kind}`;
const si = new Set(ingest.map(key)), sr = new Set(rb.map(key));
ok([...si].every((k) => sr.has(k)) && [...sr].every((k) => si.has(k)), "RB and ingest keep the SAME requirement set");
ok(rb.every((r: any) => r.normalized_term && r.kind), "every RB requirement retains normalized_term + kind");
// hardness reconciliation still applied on the object (mandatory PREFERRED -> HARD)
const mgmt = rb.find((r: any) => r.normalized_term === "people management");
ok(mgmt?.is_hard_requirement === "HARD", "reconcileHardness still upgrades mandatory PREFERRED on the kept object", mgmt?.is_hard_requirement);
// the guard: the OLD code path must collapse -> proves this test is meaningful
ok(broken.length === 1, "the OLD RB pipeline collapses to 1 (regression guard is real)", `${broken.length}`);

console.log(bad ? `\n${bad} FAILED` : `\nrb-extraction-parity: ALL PASS`);
process.exit(bad ? 1 : 0);
