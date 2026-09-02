/**
 * Credential-family properties.
 *
 * The distinction these pin down is the whole point of declaring
 * credential families per family instead of assuming:
 *
 *   NOT_HELD  he has confirmed he does not hold it. A posting requiring
 *             it is a qualification failure, and Fit says so.
 *   UNDECLARED nobody has said either way. That is uncertainty, and it
 *             must never cost the same as a confirmed absence, or the
 *             OTHER family becomes the catch-all absence the profile
 *             explicitly refuses.
 *
 * Regression origin: credentialFamiliesUnmet counted UNKNOWN resolutions
 * alongside ABSENT ones, so an UNDECLARED family produced exactly the
 * penalty of a confirmed NOT_HELD family. It was dormant only because
 * OTHER happened to be empty.
 */
import { buildFitBreakdown } from "../lib/scoring/fit.ts";
import { TermMatcher } from "../lib/matching/match.ts";
import type { CapabilityIndex } from "../lib/scoring/capability.ts";

const matcher = new TermMatcher([{ id: "s1", name: "Project coordination", relatedTerms: [], status: "VERIFIED" }], []);
const index: CapabilityIndex = {
  relations: new Map(),
  matchTerm: (t: string) => { const m = matcher.match(t); return { status: m.status, skillName: m.skillName, method: m.method, terminal: m.terminal }; },
};

const req = (id: string, term: string, raw: string) =>
  ({ id, normalized_term: term, raw_text: raw, is_hard_requirement: "HARD" });

/** A clinical credential plus enough other requirements to be scorable. */
const REQUIREMENTS = [
  req("r1", "rn license", "Active RN license required"),
  req("r2", "project coordination", "Experience with project coordination"),
  req("r3", "scheduling", "Experience with scheduling"),
  req("r4", "reporting", "Experience with reporting"),
];

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

console.log("credential families\n");

const notHeld = buildFitBreakdown(REQUIREMENTS, "Care Manager", index, { CLINICAL: "NOT_HELD" }, []);
check("NOT_HELD is a confirmed absence and counts as unmet",
  notHeld.credentialFamiliesUnmet.includes("CLINICAL"),
  `got ${JSON.stringify(notHeld.credentialFamiliesUnmet)}`);
check("NOT_HELD is not also reported as undeclared",
  !notHeld.credentialFamiliesUndeclared.includes("CLINICAL"));

const undeclared = buildFitBreakdown(REQUIREMENTS, "Care Manager", index, { CLINICAL: "UNDECLARED" }, []);
check("UNDECLARED never counts as unmet",
  undeclared.credentialFamiliesUnmet.length === 0,
  `got ${JSON.stringify(undeclared.credentialFamiliesUnmet)}`);
check("UNDECLARED is reported separately so it stays visible",
  undeclared.credentialFamiliesUndeclared.includes("CLINICAL"));

const absent = buildFitBreakdown(REQUIREMENTS, "Care Manager", index, {}, []);
check("a family missing from the declarations entirely never counts as unmet",
  absent.credentialFamiliesUnmet.length === 0,
  `got ${JSON.stringify(absent.credentialFamiliesUnmet)}`);
check("a family missing from the declarations is reported as undeclared",
  absent.credentialFamiliesUndeclared.includes("CLINICAL"));

// The property that matters: an undeclared family and a confirmed one
// must not produce the same penalty input.
check("undeclared and NOT_HELD do not produce the same unmet count",
  undeclared.credentialFamiliesUnmet.length !== notHeld.credentialFamiliesUnmet.length,
  `both produced ${notHeld.credentialFamiliesUnmet.length}`);

// OTHER is the family this protects. An unclassified credential must not
// silently acquire a penalty just because it landed there.
const other = buildFitBreakdown(
  [req("r1", "widget certification", "Must hold a Widget Institute certification"), ...REQUIREMENTS.slice(1)],
  "Widget Operator", index, { CLINICAL: "NOT_HELD", OTHER: "UNDECLARED" }, []);
check("an unclassified credential in OTHER is not penalized",
  other.credentialFamiliesUnmet.length === 0,
  `got ${JSON.stringify(other.credentialFamiliesUnmet)}`);

// And the resolution itself must still be UNKNOWN rather than ABSENT, so
// the concept stays out of the coverage numerator AND denominator.
const conceptStates = undeclared.concepts.filter((c: any) => c.requirementClass === "GATING_CREDENTIAL").map((c: any) => c.resolution);
check("an undeclared credential resolves UNKNOWN, not ABSENT",
  conceptStates.every((r: string) => r === "UNKNOWN"),
  `got ${JSON.stringify(conceptStates)}`);

console.log(`\n${failed === 0 ? "all passed" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
