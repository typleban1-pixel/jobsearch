/**
 * Resume Builder v2, Step 3A: coverage-first selection + project-unit
 * composition. Hermetic property tests on synthetic candidates -- no DB, no
 * model. Locks the objective's guarantees so they cannot drift.
 */
import { coverageSelect, independentSelect, type Candidate, type ProjectSpec, type Budget, type ThemeValues } from "../lib/render/coverageSelect.ts";

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

const emp = (id: string, entry: string, themes: string[], quantitative = false): Candidate =>
  ({ id, text: `${id}: ${themes.join("/")}`, owner: { kind: "employment", entryId: entry, label: entry }, themes, quantitative, spaceCost: 1 });
const V: ThemeValues = { A: 3, B: 2, C: 2, D: 1 };
const B = (o: Partial<Budget> = {}): Budget => ({ totalBullets: 8, perEmployment: 4, perProject: 4, ...o });

// The RentPup traction wording is verbatim and must never be upgraded.
const RENTPUP = (execThemes: string[][], id = "rentpup"): ProjectSpec => ({
  id, label: "RentPup",
  purpose: { text: "Property-compliance monitoring product for Cleveland rental owners.", themes: ["A"] },
  traction: { text: "In use by 21 users and generating approximately $1,200 in monthly revenue.", themes: ["A"], quantitative: true },
  execution: execThemes.map((t, i) => ({ id: `${id}-e${i}`, text: `exec ${i}`, owner: { kind: "project", entryId: id, label: "RentPup" }, themes: t, quantitative: false, spaceCost: 1 })),
});

console.log("1. multi-theme credit from one bullet:");
{
  const r = coverageSelect([emp("M", "e1", ["A", "B", "C"]), emp("X", "e2", ["D"])], [], V, B({ totalBullets: 1 }));
  ok(!!r.selected[0]?.text.startsWith("M"), "the 3-theme bullet is chosen over a 1-theme bullet");
  ok(r.coverage.A === 1 && r.coverage.B === 1 && r.coverage.C === 1, "one bullet credits ALL themes it covers", JSON.stringify(r.coverage));
}

console.log("\n2. diminishing returns for duplicate-theme bullets:");
{
  const r = coverageSelect([emp("A1", "e1", ["A"]), emp("A2", "e2", ["A"]), emp("B1", "e3", ["B"])], [], V, B({ totalBullets: 2 }));
  const picks = r.selected.map((s) => s.text.split(":")[0]);
  ok(picks.includes("A1") && picks.includes("B1") && !picks.includes("A2"), "after A is covered, a fresh theme (B) beats a 2nd A bullet", picks.join(","));
  ok(r.coverage.A === 1 && r.coverage.B === 1, "no redundant second bullet piled on an already-covered theme");
}

console.log("\n3. project vs employment opportunity cost:");
{
  // weak project (only low-value D) loses to strong employment; not opened.
  const weak = coverageSelect([emp("A", "e1", ["A"]), emp("B", "e2", ["B"]), emp("C", "e3", ["C"])], [RENTPUP([["D"]])], V, B({ totalBullets: 3 }));
  ok(weak.projectsSelected.length === 0, "a weak project does NOT earn space against strong employment evidence");
  // strong project (covers high-value themes employment does not) is opened.
  const strong = coverageSelect([emp("D1", "e1", ["D"])], [RENTPUP([["B"]])], V, B({ totalBullets: 6 }));
  ok(strong.projectsSelected.includes("rentpup"), "a strong project DOES earn its space in the same opportunity-cost calc");
}

console.log("\n4. RentPup selected / not-selected:");
{
  const sel = coverageSelect([emp("D1", "e1", ["D"])], [RENTPUP([["B"], ["C"]])], V, B({ totalBullets: 6 }));
  ok(sel.projectsSelected.includes("rentpup"), "selected when it out-competes for the space");
  const notBudget = coverageSelect([emp("A", "e1", ["A"]), emp("B", "e2", ["B"])], [RENTPUP([["C"]])], V, B({ totalBullets: 2 }));
  ok(!notBudget.projectsSelected.includes("rentpup"), "absent when the budget is spent on stronger evidence (not pinned)");
  const notCeiling = coverageSelect([], [RENTPUP([["A"]])], V, B({ totalBullets: 6, perProject: 2 }));
  ok(!notCeiling.projectsSelected.includes("rentpup"), "cannot open when the per-project ceiling forbids a full unit");
}

console.log("\n5. RentPup purpose+traction invariant once selected:");
{
  const r = coverageSelect([emp("D1", "e1", ["D"])], [RENTPUP([["B"]])], V, B({ totalBullets: 6 }));
  const rp = r.selected.filter((s) => s.owner.entryId === "rentpup");
  ok(rp.some((s) => s.role === "purpose"), "the composed unit includes a purpose line");
  const traction = rp.find((s) => s.role === "traction");
  ok(!!traction && /21 users/.test(traction.text) && /\$1,200 in monthly revenue/.test(traction.text), "verified traction (21 users, ~$1,200/month) is present");
  ok(!!traction && !/\b(MRR|ARR|recurring|passive|contracted|guaranteed)\b/i.test(traction.text), "traction never uses MRR/ARR/recurring/passive/contracted/guaranteed");
  ok(rp.filter((s) => s.role === "bullet").length >= 1 && rp.filter((s) => s.role === "bullet").length <= 2, "the unit carries 1-2 execution bullets");
}

console.log("\n6. no forced one-bullet-per-theme:");
{
  // A multi-cover bullet plus a genuinely uncovered low-value theme D with no
  // good candidate: D must be allowed to remain uncovered.
  const r = coverageSelect([emp("M", "e1", ["A", "B", "C"])], [], V, B({ totalBullets: 8 }));
  ok(r.selected.length === 1, "one strong multi-theme bullet is not padded with a bullet per theme", String(r.selected.length));
  ok(r.uncoveredThemes.includes("D"), "an uncovered theme with no candidate is left uncovered, not forced", r.uncoveredThemes.join(","));
}

console.log("\n(contrast) independent-greedy 'before' can fragment a project / drop traction:");
{
  // Traction themes low value under this job -> independent greedy drops it even if purpose is taken.
  const Vp: ThemeValues = { A: 3, T: 0 };
  const proj: ProjectSpec = { id: "p", label: "RentPup", purpose: { text: "purpose", themes: ["A"] }, traction: { text: "In use by 21 users and generating approximately $1,200 in monthly revenue.", themes: ["T"], quantitative: true }, execution: [] };
  const before = independentSelect([], [proj], Vp, B({ totalBullets: 4 }));
  const after = coverageSelect([], [proj], Vp, B({ totalBullets: 4 }));
  ok(before.selected.some((s) => s.role === "purpose") && !before.selected.some((s) => s.role === "traction"), "BEFORE: purpose kept but traction dropped (fragmented)");
  ok(!after.projectsSelected.includes("p") || after.selected.some((s) => s.role === "traction"), "AFTER: a project is either whole (purpose+traction) or absent");
}

console.log("\nStep 4C: admission bar, narrative density, unused capacity:");
{
  const r = coverageSelect([emp("A", "e1", ["A"]), emp("B", "e2", ["B"])], [], V, B({ totalBullets: 6 }));
  ok(r.selected.length === 2, "unused budget stays unused; no low-value filler", `used ${r.selected.length}/6`);
}
{
  const r = coverageSelect([emp("A", "e1", ["A"]), emp("Z", "e2", [])], [], V, B({ totalBullets: 6 }));
  ok(!r.selected.some((s) => s.owner.entryId === "e2"), "a zero-coverage bullet is never selected as filler");
}
{
  // weak transferable-only project: purpose/traction cover nothing, exec is adjacency to an already-covered theme.
  const Vt: ThemeValues = { COORD: 2, MILE: 1.2 };
  const proj: ProjectSpec = { id: "p", label: "RentPup", purpose: { text: "pp", themes: [] }, traction: { text: "In use by 21 users and generating approximately $1,200 in monthly revenue.", themes: [], quantitative: true }, execution: [{ id: "e", text: "x", owner: { kind: "project", entryId: "p", label: "RentPup" }, themes: ["MILE"], quantitative: false, spaceCost: 1 }] };
  const r = coverageSelect([emp("c", "e1", ["COORD"]), emp("m", "e2", ["MILE"])], [proj], Vt, B({ totalBullets: 8 }));
  ok(!r.projectsSelected.includes("p"), "a weak transferable-only project does NOT justify a full unit");
}
{
  // strong DIRECT project coverage of an uncovered important theme.
  const Vp: ThemeValues = { PROD: 3 };
  const proj: ProjectSpec = { id: "p", label: "RentPup", purpose: { text: "pp", themes: ["PROD"] }, traction: { text: "In use by 21 users and generating approximately $1,200 in monthly revenue.", themes: [], quantitative: true }, execution: [{ id: "e", text: "x", owner: { kind: "project", entryId: "p", label: "RentPup" }, themes: ["PROD"], quantitative: false, spaceCost: 1 }] };
  const r = coverageSelect([], [proj], Vp, B({ totalBullets: 6 }));
  ok(r.projectsSelected.includes("p"), "strong DIRECT project coverage DOES justify the same full unit");
}
{
  // density: a mixed off-narrative bullet loses to a cleaner bullet on the SAME theme.
  const clean: Candidate = { id: "clean", text: "clean", owner: { kind: "employment", entryId: "e1", label: "e1" }, themes: ["A"], quantitative: false, spaceCost: 1, density: 1 };
  const mixed: Candidate = { id: "mixed", text: "mixed", owner: { kind: "employment", entryId: "e2", label: "e2" }, themes: ["A"], quantitative: false, spaceCost: 1, density: 0.25 };
  const r = coverageSelect([clean, mixed], [], { A: 2 }, B({ totalBullets: 6 }));
  ok(r.selected.some((s) => s.text === "clean") && !r.selected.some((s) => s.text === "mixed"), "cleaner bullet wins; the mixed off-narrative bullet on an already-covered theme is dropped");
}
{
  // density: a mixed bullet is STILL selectable when it is uniquely strong for an important uncovered theme.
  const mixed: Candidate = { id: "mixed", text: "mixed", owner: { kind: "employment", entryId: "e1", label: "e1" }, themes: ["U"], quantitative: false, spaceCost: 1, density: 0.25 };
  const r = coverageSelect([mixed], [], { U: 2 }, B({ totalBullets: 6 }));
  ok(r.selected.some((s) => s.text === "mixed"), "a low-density bullet uniquely covering an important theme is still selected");
}

console.log(bad ? `\n${bad} FAILED` : `\ncoverage-select-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
