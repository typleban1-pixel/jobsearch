/**
 * Locks the RESPONSIBILITY requirement-kind fix end to end:
 *   validation (sanitizeRequirement) -> scoring class -> Postgres persist ->
 *   retrieval, without error, and NOT silently scored as a skill.
 *
 *   node scripts/responsibility-kind-selftest.ts
 *
 * The DB round-trip proves the requirement_kind enum accepts RESPONSIBILITY
 * (migration 0087). It fails before the migration -- which is the point.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { sanitizeRequirement, VALID_KINDS } from "../lib/llm/extractRequirements.ts";
import { classOfKind } from "../lib/scoring/kinds.ts";
import { classifyRequirement } from "../lib/scoring/requirementClass.ts";

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

// 1. validation accepts a RESPONSIBILITY requirement from a model response.
{
  const clean = sanitizeRequirement({ kind: "RESPONSIBILITY", raw_text: "Own the product roadmap and delivery.", normalized_term: "product roadmap ownership", is_hard_requirement: "HARD", confidence: 0.8 } as any);
  ok(!!clean && clean.requirement.kind === "RESPONSIBILITY", "sanitizeRequirement keeps kind RESPONSIBILITY (it is a VALID_KIND)");
  ok(VALID_KINDS.has("RESPONSIBILITY"), "RESPONSIBILITY is in the extractor's VALID_KINDS");
}
// 2. scoring class: its own RESPONSIBILITY class, out of the hard-requirement
//    set -- never SKILL (which would recreate the false absent-capability
//    penalty). A duty maps to positive evidence in fit.ts when a verified
//    capability supports it, and is dropped otherwise; it is never a gate.
{
  // Legacy v1 scorer (kinds.ts) still folds it into TRAIT for skill-Fit
  // exclusion; the live candidacy path uses classifyRequirement below.
  ok(classOfKind("RESPONSIBILITY") === "TRAIT", "classOfKind(RESPONSIBILITY) folds to TRAIT in the legacy scorer", classOfKind("RESPONSIBILITY"));
  // A duty term text can't resolve to a nameable skill -> the extractor's kind
  // decides, and it must be RESPONSIBILITY (positive-only, never a gate), not
  // the SKILL default.
  const c = classifyRequirement("Oversee the widget release cadence across teams.", "widget release cadence oversight", [], "RESPONSIBILITY");
  ok(c.requirementClass === "RESPONSIBILITY", "an inconclusive RESPONSIBILITY classifies as RESPONSIBILITY, never SKILL", c.requirementClass);
}
// 3. Postgres round-trip: persist a RESPONSIBILITY requirement and read it back.
{
  const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const { data: job } = await db.from("jobs").select("id").limit(1).single();
  const jobId = job!.id;
  const MARK = "__RESP_ROUNDTRIP_TEST__";
  let inserted = false;
  try {
    const { error: ie } = await db.from("job_requirements").insert({
      job_id: jobId, kind: "RESPONSIBILITY", raw_text: `${MARK} own the roadmap`,
      normalized_term: `${MARK} roadmap ownership`, is_hard_requirement: "PREFERRED",
      extraction_confidence: 0.5, extraction_version: 4, extracted_by: "selftest",
    });
    ok(!ie, "Postgres accepts an INSERT with kind=RESPONSIBILITY", ie?.message ?? "");
    inserted = !ie;
    if (!ie) {
      const { data: back } = await db.from("job_requirements").select("kind,raw_text").eq("job_id", jobId).eq("normalized_term", `${MARK} roadmap ownership`).maybeSingle();
      ok(back?.kind === "RESPONSIBILITY", "retrieval returns kind RESPONSIBILITY unchanged", back?.kind ?? "(none)");
    }
  } finally {
    if (inserted) await db.from("job_requirements").delete().eq("normalized_term", `${MARK} roadmap ownership`);
  }
}

console.log(bad ? `\n${bad} FAILED` : `\nresponsibility-kind-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
