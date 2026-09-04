/**
 * Resume Builder v2, Step 3A: coverage-first evidence selection + project-unit
 * composition. Pure and import-inert; wired by nothing yet.
 *
 * Objective: maximise weighted job-theme COVERAGE and evidence strength per
 * résumé-space cost, while minimising redundancy and over-concentration.
 * Concretely a submodular greedy: each theme's value is credited with sharply
 * diminishing returns as more bullets cover it, one bullet is credited for
 * ALL themes it covers, and employment and project evidence compete in the
 * same per-space opportunity-cost calculation. Quantitative accomplishments
 * get a modest tie-break, never unconditional inclusion.
 *
 * A project earns its space as a whole: "opening" a project costs its purpose
 * + traction plus a first execution bullet, so it is selected only when that
 * bundle out-competes employment evidence. Once opened it is composed as a
 * unit -- purpose, verified traction, and its best 1-2 execution bullets --
 * bounded by the per-project ceiling. A project is never pinned: if stronger
 * evidence should hold the space, it is simply absent.
 *
 * The selector chooses among candidates; it never writes their text and never
 * relaxes a grounding rule. Traction text is passed through verbatim.
 */

export interface Candidate {
  id: string;
  text: string;
  owner: { kind: "employment" | "project"; entryId: string; label: string };
  /** themeIds this bullet covers (a bullet may cover several). */
  themes: string[];
  quantitative: boolean;
  spaceCost: number;
}

export interface ProjectSpec {
  id: string;
  label: string;
  purpose: { text: string; themes: string[] };
  traction: { text: string; themes: string[]; quantitative: boolean };
  execution: Candidate[];
}

export interface Budget {
  totalBullets: number;
  perEmployment: number;
  /** total bullets a single project may occupy (purpose + traction + execution). */
  perProject: number;
}

export interface SelectedLine {
  text: string;
  owner: Candidate["owner"];
  themes: string[];
  role: "bullet" | "purpose" | "traction";
}

export interface SelectionResult {
  selected: SelectedLine[];
  /** themeId -> number of selected lines covering it. */
  coverage: Record<string, number>;
  /** owner label -> lines occupied. */
  spaceByOwner: Record<string, number>;
  projectsSelected: string[];
  /** covered-eligible themes (value > 0) that no selected line covers. */
  uncoveredThemes: string[];
}

/** value[themeId] = job weight x evidence strength; 0 for WEAK/NONE themes. */
export type ThemeValues = Record<string, number>;

const DR = 0.3;        // diminishing-returns factor: 2nd bullet on a theme is worth 30%, 3rd 9%.
const QBONUS = 0.2;    // modest quantitative tie-break, only when covering a relevant theme.
const EPS = 0.05;      // stop adding once the best marginal value is negligible (no bloat, no forced coverage).

const marginal = (themes: string[], count: Record<string, number>, values: ThemeValues, quantitative: boolean): number => {
  let v = 0;
  let coversRelevant = false;
  for (const t of themes) {
    const base = values[t] ?? 0;
    if (base <= 0) continue;
    coversRelevant = true;
    v += base * Math.pow(DR, count[t] ?? 0);
  }
  if (quantitative && coversRelevant) v += QBONUS;
  return v;
};

const applyCover = (themes: string[], count: Record<string, number>) => {
  for (const t of themes) count[t] = (count[t] ?? 0) + 1;
};

/**
 * Coverage-first selection (Step 3A).
 */
export function coverageSelect(
  employment: Candidate[], projects: ProjectSpec[], values: ThemeValues, budget: Budget,
): SelectionResult {
  const count: Record<string, number> = {};
  const ownerUsed: Record<string, number> = {};
  const projectUsed: Record<string, number> = {};
  const openProjects = new Set<string>();
  const selected: SelectedLine[] = [];
  let remaining = budget.totalBullets;

  const takenEmp = new Set<string>();
  const takenExec = new Set<string>();

  while (remaining > 0) {
    type Move = { kind: "emp" | "open" | "exec"; per: number; value: number; apply: () => void };
    let best: Move | null = null;
    const consider = (m: Move) => { if (m.value > (best?.value ?? EPS)) best = m; };

    // employment bullets (cost 1)
    for (const c of employment) {
      if (takenEmp.has(c.id)) continue;
      if ((ownerUsed[c.owner.entryId] ?? 0) >= budget.perEmployment) continue;
      if (c.spaceCost > remaining) continue;
      const gain = marginal(c.themes, count, values, c.quantitative);
      consider({
        kind: "emp", per: gain / c.spaceCost, value: gain / c.spaceCost,
        apply: () => {
          takenEmp.add(c.id); ownerUsed[c.owner.entryId] = (ownerUsed[c.owner.entryId] ?? 0) + 1;
          applyCover(c.themes, count); remaining -= c.spaceCost;
          selected.push({ text: c.text, owner: c.owner, themes: c.themes, role: "bullet" });
        },
      });
    }

    // project moves
    for (const p of projects) {
      if (!openProjects.has(p.id)) {
        // opening bundle: purpose + traction + best execution bullet.
        const openCost = 3;
        if (openCost > remaining || budget.perProject < 3) continue;
        const execChoices = p.execution.filter((e) => !takenExec.has(e.id));
        let bestExec: Candidate | null = null; let bestExecGain = -1;
        for (const e of execChoices) {
          const g = marginal(e.themes, count, values, e.quantitative);
          if (g > bestExecGain) { bestExecGain = g; bestExec = e; }
        }
        const purposeGain = marginal(p.purpose.themes, count, values, false);
        const tractionGain = marginal(p.traction.themes, count, values, p.traction.quantitative);
        const execGain = bestExec ? bestExecGain : 0;
        const gain = purposeGain + tractionGain + execGain;
        consider({
          kind: "open", per: gain / openCost, value: gain / openCost,
          apply: () => {
            openProjects.add(p.id); projectUsed[p.id] = 3; remaining -= 3;
            applyCover(p.purpose.themes, count); applyCover(p.traction.themes, count);
            selected.push({ text: p.purpose.text, owner: { kind: "project", entryId: p.id, label: p.label }, themes: p.purpose.themes, role: "purpose" });
            selected.push({ text: p.traction.text, owner: { kind: "project", entryId: p.id, label: p.label }, themes: p.traction.themes, role: "traction" });
            if (bestExec) { takenExec.add(bestExec.id); applyCover(bestExec.themes, count); selected.push({ text: bestExec.text, owner: bestExec.owner, themes: bestExec.themes, role: "bullet" }); }
          },
        });
      } else {
        // further execution bullets for an open project (cost 1)
        if ((projectUsed[p.id] ?? 0) >= budget.perProject) continue;
        for (const e of p.execution) {
          if (takenExec.has(e.id) || e.spaceCost > remaining) continue;
          const gain = marginal(e.themes, count, values, e.quantitative);
          consider({
            kind: "exec", per: gain / e.spaceCost, value: gain / e.spaceCost,
            apply: () => {
              takenExec.add(e.id); projectUsed[p.id] = (projectUsed[p.id] ?? 0) + 1;
              applyCover(e.themes, count); remaining -= e.spaceCost;
              selected.push({ text: e.text, owner: e.owner, themes: e.themes, role: "bullet" });
            },
          });
        }
      }
    }

    if (!best) break;
    (best as Move).apply();
  }

  const spaceByOwner: Record<string, number> = {};
  for (const s of selected) spaceByOwner[s.owner.label] = (spaceByOwner[s.owner.label] ?? 0) + 1;
  const uncoveredThemes = Object.keys(values).filter((t) => (values[t] ?? 0) > 0 && (count[t] ?? 0) === 0);

  return { selected, coverage: count, spaceByOwner, projectsSelected: [...openProjects], uncoveredThemes };
}

/**
 * The pre-Step-3A behaviour, for comparison: independent per-bullet scores
 * (sum of theme values, NO diminishing returns, no coverage term), greedily
 * taken to budget under the ceilings. Project purpose/traction/execution
 * compete as independent lines, so traction can be dropped and a project can
 * fragment -- the audit's failure mode.
 */
export function independentSelect(
  employment: Candidate[], projects: ProjectSpec[], values: ThemeValues, budget: Budget,
): SelectionResult {
  const staticScore = (themes: string[], quantitative: boolean) => {
    let v = 0; for (const t of themes) v += Math.max(0, values[t] ?? 0);
    return v + (quantitative && v > 0 ? QBONUS : 0);
  };
  const pool: { line: SelectedLine; entryId: string; projectId?: string; score: number; cost: number }[] = [];
  for (const c of employment) pool.push({ line: { text: c.text, owner: c.owner, themes: c.themes, role: "bullet" }, entryId: c.owner.entryId, score: staticScore(c.themes, c.quantitative), cost: c.spaceCost });
  for (const p of projects) {
    pool.push({ line: { text: p.purpose.text, owner: { kind: "project", entryId: p.id, label: p.label }, themes: p.purpose.themes, role: "purpose" }, entryId: p.id, projectId: p.id, score: staticScore(p.purpose.themes, false), cost: 1 });
    pool.push({ line: { text: p.traction.text, owner: { kind: "project", entryId: p.id, label: p.label }, themes: p.traction.themes, role: "traction" }, entryId: p.id, projectId: p.id, score: staticScore(p.traction.themes, p.traction.quantitative), cost: 1 });
    for (const e of p.execution) pool.push({ line: { text: e.text, owner: e.owner, themes: e.themes, role: "bullet" }, entryId: p.id, projectId: p.id, score: staticScore(e.themes, e.quantitative), cost: e.spaceCost });
  }
  pool.sort((a, b) => b.score - a.score);
  const count: Record<string, number> = {}; const ownerUsed: Record<string, number> = {};
  const selected: SelectedLine[] = []; let remaining = budget.totalBullets;
  for (const item of pool) {
    if (remaining < item.cost) continue;
    const cap = item.projectId ? budget.perProject : budget.perEmployment;
    if ((ownerUsed[item.entryId] ?? 0) >= cap) continue;
    if (item.score <= 0) continue;
    ownerUsed[item.entryId] = (ownerUsed[item.entryId] ?? 0) + 1; remaining -= item.cost;
    applyCover(item.line.themes, count); selected.push(item.line);
  }
  const spaceByOwner: Record<string, number> = {};
  for (const s of selected) spaceByOwner[s.owner.label] = (spaceByOwner[s.owner.label] ?? 0) + 1;
  const projectsSelected = [...new Set(selected.filter((s) => s.owner.kind === "project").map((s) => s.owner.entryId))];
  const uncoveredThemes = Object.keys(values).filter((t) => (values[t] ?? 0) > 0 && (count[t] ?? 0) === 0);
  return { selected, coverage: count, spaceByOwner, projectsSelected, uncoveredThemes };
}
