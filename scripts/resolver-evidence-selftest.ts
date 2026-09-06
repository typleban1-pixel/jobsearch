/**
 * ABSENT must mean absent, not merely unmatched.
 *
 *   node scripts/resolver-evidence-selftest.ts
 *
 * SpotHero asked for 5+ years of operations experience. The profile has
 * eighteen VERIFIED skills categorised "operations" and the word in the
 * job title of both Genius One stints, and the requirement resolved
 * ABSENT, because the matcher looks up skill NAMES and no skill is
 * called "operations".
 *
 * ABSENT then flows into Model 3 as a core gap, which is an assertion
 * that the evidence establishes he cannot do this. It does not. The
 * honest answer is that relevant evidence exists and the specific
 * requirement, five years of it, is not established.
 *
 * THE RULE THAT MATTERS MOST HERE
 *
 * Employment duration is not capability duration. Five and a half years
 * in a role called "Digital Marketing, Product & Operations Specialist"
 * is not five years of operations, because the role was three things at
 * once. Nothing in this file may turn tenure into a duration claim.
 */
import { resolveWithEvidence, type EvidenceContext } from "../lib/scoring/evidenceResolution.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

/** The real shape of Ty's profile, reduced to what this decides on. */
const ctx = (over: Partial<EvidenceContext> = {}): EvidenceContext => ({
  verifiedCategories: new Set(["operations", "marketing", "product development", "creative"]),
  supportingCategories: new Set(["operations", "marketing", "product development", "creative"]),
  capabilityYears: new Map([["fdm 3d printing", 4]]),
  notHeld: new Set(["certified public accountant"]),
  ...over,
});

// The base resolver's answer, as it stands today.
const base = (r: string) => ({ resolution: r as any, via: null, rationale: "test" });

console.log("\n1. an exactly supported concept is MET:");
{
  const r = resolveWithEvidence("workflow design", base("DIRECT"), ctx(), {});
  check("DIRECT is left alone", r.resolution === "DIRECT", JSON.stringify(r));
  check("and is not downgraded by the evidence layer", r.changed === false);
}

console.log("\n2. an explicit NOT_HELD is ABSENT:");
{
  const r = resolveWithEvidence("certified public accountant", base("ABSENT"), ctx(), {});
  check("stays ABSENT", r.resolution === "ABSENT", JSON.stringify(r));
  check("and says the profile declares it not held",
    /declare/i.test(r.rationale), r.rationale);
  // Even a category coincidence must not rescue a declared negative.
  const r2 = resolveWithEvidence("certified public accountant", base("ABSENT"),
    ctx({ verifiedCategories: new Set(["certified public accountant"]) }), {});
  check("a category coincidence cannot override a declared negative",
    r2.resolution === "ABSENT", JSON.stringify(r2));
}

console.log("\n3. no name match but verified CATEGORY evidence is UNKNOWN:");
{
  const r = resolveWithEvidence("operations", base("ABSENT"), ctx(), {});
  check("operations becomes UNKNOWN, not ABSENT", r.resolution === "UNKNOWN", JSON.stringify(r));
  check("the rationale names the category evidence",
    /categor/i.test(r.rationale), r.rationale);
  check("it is recorded as changed, so the effect is auditable", r.changed === true);
}

console.log("\n4. relevant evidence without duration proof stays UNKNOWN:");
{
  // The SpotHero requirement, in full: five years is asked for and the
  // profile establishes no operations duration at all.
  const r = resolveWithEvidence("operations", base("ABSENT"), ctx(), { minimumYears: 5 });
  check("5+ years of operations is UNKNOWN", r.resolution === "UNKNOWN", JSON.stringify(r));
  check("it is NOT promoted to MET by tenure",
    r.resolution !== "DIRECT" && r.resolution !== "TRANSFERABLE", JSON.stringify(r));
  check("and the rationale says the duration is unestablished",
    /duration|years/i.test(r.rationale), r.rationale);
}

console.log("\n5. explicit capability duration meeting the threshold is MET:");
{
  const r = resolveWithEvidence("fdm 3d printing", base("DIRECT"), ctx(), { minimumYears: 3 });
  check("4 recorded years against a 3-year requirement is DIRECT",
    r.resolution === "DIRECT", JSON.stringify(r));
}

console.log("\n6. explicit capability duration below the threshold is unmet:");
{
  const r = resolveWithEvidence("fdm 3d printing", base("DIRECT"), ctx(), { minimumYears: 8 });
  check("4 recorded years against an 8-year requirement is not MET",
    r.resolution !== "DIRECT" && r.resolution !== "TRANSFERABLE", JSON.stringify(r));
  check("it is ABSENT, because the profile affirmatively establishes less",
    r.resolution === "ABSENT", JSON.stringify(r));
  check("and the rationale gives both numbers",
    /4/.test(r.rationale) && /8/.test(r.rationale), r.rationale);
}

console.log("\n7. unrelated evidence stays ABSENT:");
{
  for (const c of ["korean language", "clinical research", "software engineering", "protocol review"]) {
    const r = resolveWithEvidence(c, base("ABSENT"), ctx(), {});
    check(`"${c}" stays ABSENT`, r.resolution === "ABSENT", `${c}: ${JSON.stringify(r)}`);
  }
}

console.log("\n8. coincidence must not create UNKNOWN:");
{
  // The two the corpus dry run flagged as questionable. Both were
  // matched only because a word appeared in responsibility prose:
  // "trade" from "trade shows", "business" from "business needs".
  // Responsibility prose is not an occupational claim, and that signal
  // is deliberately not consulted.
  const r1 = resolveWithEvidence("trade", base("ABSENT"), ctx(), {});
  check("\"trade\" is not rescued by \"trade shows\" appearing in prose",
    r1.resolution === "ABSENT", JSON.stringify(r1));
  const r2 = resolveWithEvidence("business", base("ABSENT"), ctx(), {});
  check("\"business\" is not rescued by \"business needs\" appearing in prose",
    r2.resolution === "ABSENT", JSON.stringify(r2));

  // A substring of a category is not the category.
  const r3 = resolveWithEvidence("operational risk management", base("ABSENT"), ctx(), {});
  check("a concept merely containing a category word stays ABSENT",
    r3.resolution === "ABSENT", JSON.stringify(r3));
  const r4 = resolveWithEvidence("market research", base("ABSENT"), ctx(), {});
  check("\"market research\" is not the \"marketing\" category",
    r4.resolution === "ABSENT", JSON.stringify(r4));
}

console.log("\nthe layer never invents credit:");
{
  const r = resolveWithEvidence("operations", base("ABSENT"), ctx(), {});
  check("UNKNOWN is the strongest thing this layer can produce",
    !["DIRECT", "TRANSFERABLE"].includes(r.resolution), JSON.stringify(r));
  const r2 = resolveWithEvidence("anything at all", base("UNKNOWN"), ctx(), {});
  check("an existing UNKNOWN is left as it is", r2.resolution === "UNKNOWN" && r2.changed === false);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("ABSENT means absent, and tenure is not duration");
