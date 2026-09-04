/**
 * Resume Builder v2, Step 2b: the deterministic narrative plan.
 *
 * The plan is the résumé-level representation the later selector, summary
 * and reframer will consume. It is built entirely from the V2 themes and
 * the evidence map -- no model call, and it NEVER states a fact. It carries
 * references, weights, coverage states and posting terminology only.
 *
 * Design guarantees:
 *  - primaryStory is chosen from the INTERSECTION of important job themes and
 *    strong (DIRECT) verified evidence, not merely the highest-weight themes.
 *  - `terminology` is emitted only for covered themes (DIRECT/TRANSFERABLE),
 *    so a gap (financial services, power bi, crm) is visible in `gaps` but
 *    can never reach the employer-language reframer.
 *  - the HARD-derived `core` signal is preserved as an input signal, not
 *    frozen as the definition of centrality; weight, coverage and story
 *    score are all retained for later refinement.
 */
import type { WeightedTheme } from "../applications/themesV2.ts";
import { isCovered, type Coverage, type EvidenceIndex, type EvidenceRef } from "./evidenceMap.ts";

export const NARRATIVE_PLAN_VERSION = "np.v1";

/** Coarse functional areas for clustering a story. First match wins, so the
 *  order encodes precedence (coordination before growth so "strategic growth
 *  programs" reads as coordination, not marketing). */
const AREAS: { id: string; label: string; re: RegExp }[] = [
  { id: "coordination", label: "cross-functional coordination & execution", re: /collabor|cross-functional|coordinat|project|milestone|process|stakeholder|execution|program|operation|workflow|deliver|\bplan|initiative|multitask/ },
  { id: "product", label: "product development & delivery", re: /product|requirement|solution|launch|ideation|iterative|roadmap|prototyp/ },
  { id: "marketing", label: "marketing & growth", re: /market|seo|campaign|email|advertis|audience|funnel|acquisition|brand|content|growth|ecommerce|conversion|paid/ },
  { id: "analysis", label: "analysis & reporting", re: /analy|report|metric|research|competitive|data|insight|dashboard|forecast|problem/ },
  { id: "communication", label: "communication & presentation", re: /communicat|present|writing|teaching|mentor/ },
];
const areaOf = (term: string): string => AREAS.find((a) => a.re.test(term))?.id ?? "other";
const labelOf = (id: string): string => AREAS.find((a) => a.id === id)?.label ?? id;

const COV_WEIGHT: Record<Coverage, number> = { DIRECT: 1, TRANSFERABLE: 0.55, WEAK: 0.2, NONE: 0 };

export interface PlannedTheme {
  id: string;
  kind: string;
  hardness: string;
  weight: number;
  /** HARD-derived input signal; NOT the final definition of centrality. */
  coreSignal: boolean;
  area: string;
  coverage: Coverage;
  evidence: EvidenceRef[];
  /** weight x coverage strength -- how much this theme can carry the résumé. */
  storyScore: number;
}

export interface NarrativePlan {
  planVersion: string;
  primaryStory: { areaId: string; label: string; themeIds: string[] };
  supportingThemes: string[];
  themes: PlannedTheme[];
  gaps: { themeId: string; coverage: Coverage; reason: string }[];
  /** themeId -> employer phrases, COVERED themes only. Never a claim. */
  terminology: Record<string, string[]>;
}

/** Split a posting's raw requirement text into a few employer-language
 *  phrases, verbatim. Terminology, not facts. */
function phrasesFrom(term: string, rawText: string): string[] {
  const out = new Set<string>([term]);
  for (const seg of String(rawText).split(/[,.;:()]|\band\b|\bor\b/i)) {
    const s = seg.trim().replace(/^(strong|excellent|proficiency in|ability to|experience (in|with|supporting)|proficiency)\s+/i, "").trim();
    if (s.length >= 4 && s.length <= 60 && /[a-z]/i.test(s)) out.add(s.toLowerCase());
  }
  return [...out].slice(0, 4);
}

export function buildNarrativePlan(themes: WeightedTheme[], index: EvidenceIndex, title: string): NarrativePlan {
  const planned: PlannedTheme[] = themes.map((t) => {
    const cov = index.byTheme.get(t.term)?.coverage ?? "NONE";
    const ev = index.byTheme.get(t.term)?.evidence ?? [];
    return {
      id: t.term, kind: t.kind, hardness: t.hardness, weight: t.weight,
      coreSignal: t.core, area: areaOf(t.term), coverage: cov, evidence: ev,
      storyScore: t.weight * COV_WEIGHT[cov],
    };
  });

  // primaryStory: cluster the DIRECT-covered themes by area; the area with the
  // greatest summed story score wins. Strong verified evidence gates entry --
  // a high-weight theme with no evidence contributes nothing.
  const strong = planned.filter((p) => p.coverage === "DIRECT");
  const areaScore = new Map<string, number>();
  for (const p of strong) areaScore.set(p.area, (areaScore.get(p.area) ?? 0) + p.storyScore);
  const rawTheme = new Map(themes.map((t) => [t.term, t.rawText]));

  let primaryAreaId = "other";
  if (areaScore.size) {
    primaryAreaId = [...areaScore.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  } else {
    // No strong evidence anywhere: fall back to the best transferable area.
    const t2 = new Map<string, number>();
    for (const p of planned.filter((x) => x.coverage === "TRANSFERABLE")) t2.set(p.area, (t2.get(p.area) ?? 0) + p.storyScore);
    if (t2.size) primaryAreaId = [...t2.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  }

  const inPrimary = planned
    .filter((p) => p.area === primaryAreaId && isCovered(p.coverage))
    .sort((a, b) => b.storyScore - a.storyScore || a.id.localeCompare(b.id));
  const primaryIds = new Set(inPrimary.map((p) => p.id));

  const supportingThemes = planned
    .filter((p) => isCovered(p.coverage) && !primaryIds.has(p.id))
    .sort((a, b) => b.storyScore - a.storyScore || a.id.localeCompare(b.id))
    .map((p) => p.id);

  const gaps = planned
    .filter((p) => !isCovered(p.coverage))
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
    .map((p) => ({ themeId: p.id, coverage: p.coverage, reason: p.coverage === "NONE" ? "no verified evidence" : "only weak/tangential evidence" }));

  // Terminology: covered themes ONLY. A gap term never appears here, so it
  // cannot be handed to the reframer as allowed employer language.
  const terminology: Record<string, string[]> = {};
  for (const p of planned) {
    if (isCovered(p.coverage)) terminology[p.id] = phrasesFrom(p.id, rawTheme.get(p.id) ?? p.id);
  }

  return {
    planVersion: NARRATIVE_PLAN_VERSION,
    primaryStory: { areaId: primaryAreaId, label: labelOf(primaryAreaId), themeIds: inPrimary.map((p) => p.id) },
    supportingThemes,
    themes: planned,
    gaps,
    terminology,
  };
}
