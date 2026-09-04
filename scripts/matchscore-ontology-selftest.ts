/**
 * Unit test of the read-time Match Score ontology delta (A + B1) exactly as
 * lib/portal/db.ts now calls it. Proves the delta is additive/fail-safe:
 * folds interchangeable tools, upgrades only where the profile entails it,
 * caps product-management at TRANSFERABLE, never invents, never loses DIRECT.
 */
import { ontologyDelta, withOntology, makeProfileHas } from "../lib/portal/matchScoreOntology.ts";

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };
const has = makeProfileHas([
  "Microsoft Excel", "Google Sheets", "Microsoft PowerPoint", "Paid advertising", "SEO",
  "Email marketing", "Campaign execution", "Marketing funnel design", "Audience segmentation",
  "Conversion testing", "Cross-department collaboration", "Product ideation",
  "Iterative product development", "Requirements definition", "Product launch", "Solution development",
]);
const H = (concept: string, resolution: string, requirementClass = "SKILL") =>
  ({ concept, resolution, hardness: "HARD", requirementClass });
const eq = (d: any, m: number, t: number, dir: number) => d.dMet === m && d.dTotal === t && d.dDirect === dir;

console.log("A+B1 delta:");
ok(eq(ontologyDelta([H("Microsoft Excel", "DIRECT"), H("Google Sheets", "DIRECT")], has), -1, -1, -1),
  "Excel + Sheets (both DIRECT) fold to one spreadsheet vote");
ok(eq(ontologyDelta([H("paid search", "ABSENT")], has), 1, 0, 1),
  "paid search ABSENT -> DIRECT (profile has paid advertising, narrower-of)");
ok(eq(ontologyDelta([H("cross-functional collaboration", "ABSENT")], has), 1, 0, 1),
  "cross-functional ABSENT -> DIRECT (equivalent of cross-department)");
ok(eq(ontologyDelta([H("digital marketing", "TRANSFERABLE")], has), 0, 0, 1),
  "digital marketing TRANSFERABLE -> DIRECT (>=3 components), met unchanged");
ok(eq(ontologyDelta([H("product management", "ABSENT", "OCCUPATIONAL")], has), 1, 0, 0),
  "product management -> TRANSFERABLE only, never DIRECT (dDirect stays 0)");
ok(eq(ontologyDelta([H("underwater basket weaving", "ABSENT")], has), 0, 0, 0),
  "an unmapped concept -> no change");
ok(eq(ontologyDelta([H("SEO", "DIRECT"), { concept: "nice to have", resolution: "ABSENT", hardness: "SOFT", requirementClass: "SKILL" }], has), 0, 0, 0),
  "a soft requirement is ignored; the existing DIRECT is untouched");
ok(eq(ontologyDelta([], has), 0, 0, 0), "empty concept detail -> zero delta");
ok(eq(ontologyDelta([H("Microsoft Excel", "ABSENT")], has), 0, 0, 0),
  "Excel ABSENT with no fold and no upgrade path -> unchanged (never manufactured)");

console.log("\nwithOntology (floor at 0; matchScore clamps the rest):");
ok(JSON.stringify(withOntology({ hardMet: 0, hardTotal: 2, hardDirect: 1 }, { dMet: 0, dTotal: 0, dDirect: 0 })) === JSON.stringify({ hardMet: 0, hardTotal: 2, hardDirect: 1 }),
  "zero delta preserves inputs exactly (incl. hardDirect > hardMet, as production allows)");
ok(withOntology({ hardMet: 1, hardTotal: 1, hardDirect: 1 }, { dMet: -1, dTotal: -1, dDirect: -1 }).hardTotal === 0,
  "negative delta floors at 0, never below");

console.log("\nmakeProfileHas containment:");
ok(has("Excel") === true && has("microsoft excel") === true, "substring + case-insensitive match");
ok(has("Kubernetes") === false, "a skill the profile lacks -> false");

console.log(bad ? `\n${bad} FAILED` : `\nmatchscore-ontology-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
