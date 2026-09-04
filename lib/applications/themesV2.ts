/**
 * Resume Builder v2 theme extraction (multi-class, weighted).
 *
 * The v1 `themesFrom` (in prepare.ts) admits only requirements whose
 * `requirementClass` resolves to SKILL, which silently drops a posting's
 * tools, experience themes and -- once the extractor emits them -- its
 * responsibilities. v2 keys off the extraction `kind` directly and admits
 * the classes that carry a job's actual shape, weights them by hardness and
 * kind, and marks core themes so a downstream selector can optimise for
 * coverage of what matters rather than the sum of independent bullet scores.
 *
 * This is résumé-selection logic and, exactly like v1's exclusions, is seen
 * ONLY by theme selection. It does not touch Match Score, candidacy, or the
 * capability resolver, and adding RESPONSIBILITY rows to the shared
 * job_requirements representation leaves those consumers unchanged until a
 * later, explicitly-gated step opts them in.
 *
 * Nothing here is wired into the live composer yet; it is selected only
 * behind the NARRATIVE_V2 strategy boundary (a later step).
 */

/**
 * Work-arrangement / administrative conditions that are never résumé themes.
 * Mirrors ADMINISTRATIVE_CONDITION in prepare.ts (kept local so the v1 path
 * is untouched); the two must stay in step.
 */
const ADMINISTRATIVE_CONDITION =
  /\b(?:onsite|on-site|in-office|in-person|hybrid|remote work|relocat|residency|commut|visa|sponsorship|work authorization|authorized to work|clearance|days? (?:a|per) week|per week|shift work|weekend|overtime|salary|compensation|pay range|drug (?:test|screen)|background check|valid driver)/i;

/** Extraction kinds that carry a job's shape and become weighted themes. */
export type ThemeKind = "SKILL" | "TOOL" | "EXPERIENCE_YEARS" | "DOMAIN" | "RESPONSIBILITY";

const THEME_KINDS = new Set<string>(["SKILL", "TOOL", "EXPERIENCE_YEARS", "DOMAIN", "RESPONSIBILITY"]);

/** Kind weighting. Capabilities and duties lead; a bare tool is worth less. */
const KIND_WEIGHT: Record<ThemeKind, number> = {
  SKILL: 1.0,
  RESPONSIBILITY: 1.0,
  EXPERIENCE_YEARS: 0.9,
  DOMAIN: 0.9,
  TOOL: 0.8,
};

const HARDNESS_WEIGHT: Record<string, number> = { HARD: 2, PREFERRED: 1, UNCLEAR: 0.5 };

/** How many themes flow downstream as the flat term list. Wider than v1's 12
 *  because v2 admits more classes; core themes are surfaced separately so a
 *  selector can guarantee their coverage regardless of this cap. */
const TERM_CAP = 18;

export interface WeightedTheme {
  term: string;
  kind: ThemeKind;
  hardness: "HARD" | "PREFERRED" | "UNCLEAR";
  /** hardness weight x kind weight. */
  weight: number;
  /** A HARD requirement -- a theme the résumé should try to cover. */
  core: boolean;
  rawText: string;
}

export interface RoleThemesV2 {
  context: string;
  /** Ordered by weight, strongest first; deduped by term. */
  themes: WeightedTheme[];
  /** Flattened term list, capped, for back-compat with term-based consumers. */
  terms: string[];
  /** The subset of `terms` that are core (HARD). */
  coreTerms: string[];
  requirementCount: number;
  /** Diagnostics: how many requirements each kind contributed or why dropped. */
  excludedByKind: Record<string, number>;
  themeless: boolean;
}

interface ReqLike {
  normalized_term?: string | null;
  raw_text?: string | null;
  is_hard_requirement?: string | null;
  kind?: string | null;
}

/**
 * The same computation over requirements already in hand, so a corpus-wide
 * analysis can load once and run the identical selection.
 */
export function themesFromV2(reqs: ReqLike[], title: string): RoleThemesV2 {
  const excludedByKind: Record<string, number> = {};
  const bump = (k: string) => { excludedByKind[k] = (excludedByKind[k] ?? 0) + 1; };

  const byTerm = new Map<string, WeightedTheme>();
  for (const r of reqs) {
    const term = String(r.normalized_term ?? "").trim();
    if (!term) { bump("EMPTY_TERM"); continue; }
    const kind = String(r.kind ?? "").toUpperCase();
    if (!THEME_KINDS.has(kind)) { bump(kind || "UNKNOWN_KIND"); continue; }
    const raw = String(r.raw_text ?? "");
    if (ADMINISTRATIVE_CONDITION.test(term) || ADMINISTRATIVE_CONDITION.test(raw)) {
      bump("ADMINISTRATIVE");
      continue;
    }
    const hardnessRaw = String(r.is_hard_requirement ?? "UNCLEAR").toUpperCase();
    const hardness = (hardnessRaw === "HARD" || hardnessRaw === "PREFERRED") ? hardnessRaw : "UNCLEAR";
    const weight = (HARDNESS_WEIGHT[hardness] ?? 0.5) * KIND_WEIGHT[kind as ThemeKind];
    const theme: WeightedTheme = {
      term, kind: kind as ThemeKind, hardness: hardness as WeightedTheme["hardness"],
      weight, core: hardness === "HARD", rawText: raw,
    };
    // Dedup by term: keep the strongest (highest weight) instance.
    const prior = byTerm.get(term);
    if (!prior || theme.weight > prior.weight) byTerm.set(term, theme);
  }

  const themes = [...byTerm.values()].sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));
  const terms = themes.slice(0, TERM_CAP).map((t) => t.term);
  const coreTerms = themes.filter((t) => t.core).map((t) => t.term);

  return {
    context: terms.length ? `${title}. Themes: ${terms.join(", ")}.` : title,
    themes,
    terms,
    coreTerms,
    requirementCount: reqs.length,
    excludedByKind,
    themeless: terms.length === 0,
  };
}
