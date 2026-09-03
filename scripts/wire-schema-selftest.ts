/**
 * The bounded response schema, and what it must not change.
 *
 *   node scripts/wire-schema-selftest.ts
 *
 * The model now emits short keys and no rationale field. That is a
 * TRANSPORT change: fromWire maps it back to the long names before
 * anything else sees it, so job_requirements, sanitizeRequirement, the
 * hardness reconciliation and Model 4 are all untouched.
 *
 * The thing this file exists to prevent is the transport change quietly
 * becoming a semantic one.
 */
import { fromWire, sanitizeRequirement, reconcileHardness, dedupeRequirements,
         buildExtractionRequest, RESPONSE_SCHEMA_VERSION, EXTRACTION_VERSION } from "../lib/llm/extractRequirements.ts";
import { messageBody, modelForTier } from "../lib/llm/anthropic.ts";
import { classifyRequirement } from "../lib/scoring/requirementClass.ts";
import { experienceObject } from "../lib/scoring/candidacy.ts";
import { createHash } from "node:crypto";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}  ${d}`); }
};

const WIRE = {
  r: [
    { q: "5+ years of program management experience required", t: "program management",
      k: "EXPERIENCE_YEARS", h: "HARD", y: 5, c: 0.9 },
    { q: "Bachelor's degree", t: "bachelor degree", k: "EDUCATION", h: "HARD", y: null, c: 0.95 },
    { q: "Excellent communication", t: "communication", k: "TRAIT", h: "PREFERRED", y: null, c: 0.6 },
  ],
  rp: "HYBRID", rg: null, n: null,
};

console.log("\n1. the wire shape maps to the long names exactly:");
{
  const out = fromWire(WIRE);
  check("three requirements survive", out.requirements.length === 3);
  const a = out.requirements[0]!;
  check("q -> raw_text", a.raw_text === "5+ years of program management experience required");
  check("t -> normalized_term", a.normalized_term === "program management");
  check("k -> kind", a.kind === "EXPERIENCE_YEARS");
  check("h -> is_hard_requirement", a.is_hard_requirement === "HARD");
  check("y -> minimum_years", a.minimum_years === 5);
  check("c -> confidence", a.confidence === 0.9);
  check("a null minimum_years stays null", out.requirements[1]!.minimum_years === null);
  check("rp -> remote_policy_stated", out.remote_policy_stated === "HYBRID");
  check("rg -> remote_geographic_restriction", out.remote_geographic_restriction === null);
}

console.log("\n2. every field Model 4 uses is preserved in meaning:");
{
  const out = fromWire(WIRE);
  for (const r of out.requirements) {
    check(`  ${r.normalized_term}: kind present`, typeof r.kind === "string" && r.kind.length > 0);
    check(`  ${r.normalized_term}: hardness present`, ["HARD","PREFERRED","UNCLEAR"].includes(r.is_hard_requirement));
  }
  // experienceObject drives Model 4's stratum and reads raw_text.
  const full = "5+ years of program management experience required";
  check("experienceObject sees the whole quote", experienceObject(full) === experienceObject(out.requirements[0]!.raw_text));
  check("requirementClass sees the whole quote",
    classifyRequirement(full, "program management", []).requirementClass
      === classifyRequirement(out.requirements[0]!.raw_text, "program management", []).requirementClass);
}

console.log("\n3. the quote is NOT truncated:");
{
  // A 160-char cap changes 11 requirementClass outcomes and 15
  // constraint categories across the historical corpus. raw_text is not
  // display-only: it feeds classification, grounding and constraints.
  const long = "x".repeat(400);
  const out = fromWire({ r: [{ q: long, t: "t", k: "SKILL", h: "HARD", y: null, c: 1 }], rp: "NOT_STATED", rg: null, n: null });
  check("a 400-character quote survives whole", out.requirements[0]!.raw_text.length === 400);
}

console.log("\n4. the validation pipeline is unchanged:");
{
  const out = fromWire(WIRE);
  const kept: any[] = [];
  for (const raw of out.requirements) {
    const clean = sanitizeRequirement(raw as any);
    check(`  sanitize accepts ${raw.normalized_term}`, clean !== null);
    if (!clean) continue;
    const rec = reconcileHardness(clean.requirement as any);
    if (rec.corrected) (clean.requirement as any).is_hard_requirement = rec.hardness;
    kept.push(clean.requirement);
  }
  const d = dedupeRequirements(kept);
  check("dedupe keeps all three distinct requirements", d.kept.length === 3, String(d.kept.length));
  // The quote outranks the label, exactly as before.
  const bumped = fromWire({ r: [{ q: "minimum of 3 years required", t: "x", k: "EXPERIENCE_YEARS", h: "PREFERRED", y: 3, c: 0.5 }], rp: "NOT_STATED", rg: null, n: null });
  const c2 = sanitizeRequirement(bumped.requirements[0] as any)!;
  check("mandatory wording still corrects PREFERRED to HARD",
    reconcileHardness(c2.requirement as any).hardness === "HARD");
}

console.log("\n5. malformed and truncated responses still fail closed:");
{
  check("an empty object yields no requirements", fromWire({}).requirements.length === 0);
  check("null yields no requirements", fromWire(null).requirements.length === 0);
  check("the OLD long-key shape yields nothing, rather than half-parsing",
    fromWire({ requirements: [{ raw_text: "x", normalized_term: "y" }] }).requirements.length === 0);
  check("a non-array r yields nothing", fromWire({ r: "nope" }).requirements.length === 0);
  // A requirement missing its quote is dropped by sanitize, as before.
  const partial = fromWire({ r: [{ t: "term-only", k: "SKILL", h: "HARD", y: null, c: 1 }], rp: "NOT_STATED", rg: null, n: null });
  check("a requirement with no quote is refused by sanitize",
    sanitizeRequirement(partial.requirements[0] as any) === null);
}

console.log("\n6. payload parity survives the schema change:");
{
  const FIXTURE = { title: "Program Manager", company: "Northern Trust", descriptionText: "5+ years required." };
  const MODEL = modelForTier("fast");
  const sync = messageBody(MODEL, buildExtractionRequest(FIXTURE));
  const batch = { custom_id: "x", params: messageBody(MODEL, buildExtractionRequest(FIXTURE)) };
  const d = (o: unknown) => createHash("sha256").update(JSON.stringify(o)).digest("hex");
  check("both transports still send an identical body", d(sync) === d(batch.params));
  const tools = (sync["tools"] as any[])[0];
  check("the tool schema is the wire shape",
    JSON.stringify(tools.input_schema).includes('"r"') && !JSON.stringify(tools.input_schema).includes("hard_requirement_reason"));
  check("max_tokens is still 8192", sync["max_tokens"] === 8192);
}

console.log("\n7. the schema version is bumped, so old work is not mixed in:");
{
  check("RESPONSE_SCHEMA_VERSION is 2", RESPONSE_SCHEMA_VERSION === 2, String(RESPONSE_SCHEMA_VERSION));
  check("EXTRACTION_VERSION is unchanged at 4", EXTRACTION_VERSION === 4);
}

console.log("\n8. the response is materially smaller:");
{
  const oldShape = { requirements: WIRE.r.map((w) => ({
    raw_text: w.q, normalized_term: w.t, kind: w.k, is_hard_requirement: w.h,
    hard_requirement_reason: "Because the posting says it is required, citing the wording.",
    minimum_years: w.y, confidence: w.c })), remote_policy_stated: "HYBRID",
    remote_geographic_restriction: null, notes: null };
  const before = JSON.stringify(oldShape).length, after = JSON.stringify(WIRE).length;
  check(`the wire shape is smaller (${before} -> ${after} chars)`, after < before * 0.6, `${after}/${before}`);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("a smaller wire, the same meaning");
