/**
 * Resume Builder v2, Step 3B: deterministic summary framing. Hermetic property
 * tests -- no DB, no model. Proves the summary leads with the plan's dominant
 * story, uses only strong evidence, never leaks a gap or forces a metric, and
 * that the same profile produces materially different summaries for materially
 * different roles.
 */
import { buildSummary } from "../lib/render/summaryPlan.ts";
import type { NarrativePlan, PlannedTheme } from "../lib/render/narrativePlan.ts";
import type { SelectionResult, SelectedLine } from "../lib/render/coverageSelect.ts";

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

const theme = (id: string, area: string, coverage: PlannedTheme["coverage"], weight = 2, ev: string[] = ["ev-" + id]): PlannedTheme =>
  ({ id, kind: "SKILL", hardness: "HARD", weight, coreSignal: true, area, coverage, evidence: ev.map((r) => ({ ref: r, source: "skills", strength: 1 })), storyScore: weight });

const plan = (areaId: string, primary: string[], supporting: string[], themes: PlannedTheme[], gaps: string[]): NarrativePlan => ({
  planVersion: "np.v1",
  primaryStory: { areaId, label: areaId, themeIds: primary },
  supportingThemes: supporting,
  themes,
  gaps: gaps.map((g) => ({ themeId: g, coverage: "NONE" as const, reason: "no verified evidence" })),
  terminology: {},
});
const sel = (lines: Partial<SelectedLine>[]): SelectionResult => ({
  selected: lines.map((l) => ({ text: l.text ?? "", owner: l.owner ?? { kind: "employment", entryId: "e", label: "e" }, themes: l.themes ?? [], role: l.role ?? "bullet" })),
  coverage: {}, spaceByOwner: {}, projectsSelected: [], uncoveredThemes: [],
});

// Coordination role, with a strong evidence set and gaps present.
const coordPlan = plan("coordination", ["project coordination", "collaboration"], ["communication skills", "process improvement"],
  [theme("project coordination", "coordination", "DIRECT"), theme("collaboration", "coordination", "DIRECT"),
   theme("communication skills", "communication", "DIRECT"), theme("process improvement", "coordination", "DIRECT"),
   theme("financial services experience", "other", "NONE", 3), theme("milestone tracking", "coordination", "TRANSFERABLE")],
  ["financial services experience", "power bi", "crm platforms", "executive reporting"]);
const coordSel = sel([{ text: "Coordinated projects across teams from planning through delivery.", themes: ["project coordination", "collaboration"] }]);
const coord = buildSummary(coordPlan, coordSel);

// Marketing role, same profile, with a quantitative marketing accomplishment selected.
const mktPlan = plan("marketing", ["seo", "digital marketing"], ["email marketing"],
  [theme("seo", "marketing", "DIRECT"), theme("digital marketing", "marketing", "DIRECT"), theme("email marketing", "marketing", "DIRECT")], []);
const mktSel = sel([{ text: "Built segmented email funnels for an audience of roughly 70,000 to 180,000 contacts.", themes: ["digital marketing", "email marketing"] }]);
const mkt = buildSummary(mktPlan, mktSel);

console.log("summaries:");
console.log("  COORD:  " + coord.text);
console.log("  MKT:    " + mkt.text);

console.log("\nassertions:");
ok(coord.leadArea === "coordination" && /coordination|cross-functional|planning through execution/i.test(coord.text), "coordination role leads with coordination/execution");
ok(mkt.leadArea === "marketing" && /marketing/i.test(mkt.text), "marketing role leads with marketing");
ok(coord.text !== mkt.text, "same profile -> materially different summaries for different roles");
// only strong (DIRECT) themes drive; a high-weight NONE gap never drives
ok(!coord.drivingThemes.some((d) => d.id === "financial services experience"), "a high-weight gap theme does NOT drive the summary");
ok(coord.drivingThemes.every((d) => d.evidence.length > 0), "every driving theme carries supporting evidence (grounded)");
// no gap mention / no domain implication
for (const banned of ["financial services", "wealth management", "power bi", "crm", "executive reporting"]) {
  ok(!coord.text.toLowerCase().includes(banned), `summary never mentions the gap "${banned}"`);
}
ok(coord.gapsExcluded.includes("financial services experience"), "gaps are recorded as excluded");
// metric discipline
ok(coord.metric === null, "no metric is forced when no selected quantitative accomplishment covers a primary theme");
ok(mkt.metric !== null && /70,000|180,000/.test(mkt.metric.text) && mktPlan.primaryStory.themeIds.includes(mkt.metric.strengthens), "a metric is included only when it strengthens a primary story theme");
// house style
ok(!/—|--/.test(coord.text) && !/—|--/.test(mkt.text), "no em dashes in employer-facing copy");
// product story only when supported
const prodUnsupported = buildSummary(plan("communication", ["communication skills"], [], [theme("communication skills", "communication", "DIRECT")], []), sel([]));
ok(prodUnsupported.leadArea === "communication" && !/product/i.test(prodUnsupported.text), "a PM posting with no product evidence does NOT claim a product story");
const prodSupported = buildSummary(plan("product", ["product launch", "iterative product development"], [], [theme("product launch", "product", "DIRECT"), theme("iterative product development", "product", "DIRECT")], []), sel([]));
ok(prodSupported.leadArea === "product" && /product/i.test(prodSupported.text), "a product story IS led when the plan supports it");

console.log(bad ? `\n${bad} FAILED` : `\nsummary-plan-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
