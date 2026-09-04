/**
 * Deterministic concept relations for evidence resolution.
 *
 * PURPOSE. The base matcher resolves a requirement concept against verified
 * profile skills by EXACT / ALIAS only, so it misses cases where verified
 * evidence genuinely establishes the requirement under a different name, a
 * broader capability, or a set of components. This layer adds those
 * recognitions -- and ONLY those -- deterministically.
 *
 * HARD RULES (all enforced below):
 *  - ADDITIVE / FAIL-SAFE. An existing DIRECT is never downgraded, and the
 *    absence of any relationship returns the current resolution unchanged.
 *    A missing ontology entry can only fail to upgrade; it can never erase a
 *    legitimate EXACT/ALIAS match.
 *  - NEVER MANUFACTURE. A relation upgrades only when the profile actually
 *    holds the entailing evidence: an equivalent skill, the broader skill
 *    that genuinely entails a narrower requirement, or >= the configured
 *    number of an umbrella's components. There is no "adjacency" relation,
 *    so adjacency alone can never become DIRECT.
 *  - UMBRELLA CEILINGS. Each umbrella declares a maximum resolution. Where
 *    holding the components establishes the practice (digital marketing),
 *    the max is DIRECT; where the umbrella is a distinct professional
 *    discipline larger than the component tasks (product management), the
 *    max is TRANSFERABLE, so product-lifecycle evidence never becomes DIRECT
 *    professional Product Management.
 *  - PROVENANCE. Every non-trivial resolution returns the exact frozen
 *    evidence (`via`) and the rule (`basis`) that produced it.
 *
 * GENERALIZABLE. The tables describe relationships BETWEEN CONCEPTS, not one
 * person's skills; `profileHas` is injected, so the same ontology serves any
 * profile. It is a seed to be extended, not a per-profile allow-list.
 */
export type Resolution = "DIRECT" | "TRANSFERABLE" | "UNKNOWN" | "ABSENT";

export interface RelationResult {
  resolution: Resolution;
  /** The frozen evidence that justified an upgrade, if any. */
  via: string[] | null;
  /** Human-readable rule, for the audit trail. Null when nothing changed. */
  basis: string | null;
}

export const norm = (s: string) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** A ≡ B: the same capability under different names. Symmetric. */
const EQUIVALENTS: string[][] = [
  ["cross-functional collaboration", "cross-department collaboration"],
  ["cross functional collaboration", "cross-department collaboration"],
];

/**
 * The requirement is NARROWER than, and genuinely entailed by, a broader
 * verified capability: doing the broader thing means doing this. Only true
 * subset relations belong here (paid search is a form of paid advertising),
 * never mere relatedness.
 */
const NARROWER_OF: Record<string, string[]> = {
  "paid search": ["paid advertising"],
  "search engine marketing": ["paid advertising"],
};

/** An umbrella recognised only when enough of its components are verified. */
interface Umbrella { components: string[]; min: number; max: "DIRECT" | "TRANSFERABLE" }
const UMBRELLAS: Record<string, Umbrella> = {
  "microsoft office": { components: ["excel", "powerpoint", "word"], min: 2, max: "DIRECT" },
  "digital marketing": {
    components: ["seo", "paid advertising", "email marketing", "campaign execution",
      "marketing funnel design", "audience segmentation", "conversion testing"],
    min: 3, max: "DIRECT",
  },
  // A distinct professional discipline: having done product-lifecycle tasks
  // supports it only as TRANSFERABLE, never DIRECT.
  "product management": {
    components: ["product ideation", "iterative product development", "requirements definition",
      "product launch", "solution development"],
    min: 3, max: "TRANSFERABLE",
  },
};

const RANK: Record<Resolution, number> = { ABSENT: 0, UNKNOWN: 1, TRANSFERABLE: 2, DIRECT: 3 };

/**
 * Resolve one concept, upgrading ONLY via a justified relation.
 *
 * `current` is whatever the base EXACT/ALIAS matcher already produced.
 * `profileHas(name)` reports whether the frozen profile holds a skill
 * matching `name`. The return never ranks below `current`.
 */
export function relationResolve(
  concept: string, current: Resolution, profileHas: (name: string) => boolean,
): RelationResult {
  const c = norm(concept);
  const keep = (): RelationResult => ({ resolution: current, via: null, basis: null });

  // Never touch an existing match. Absence of a relation cannot erase it.
  if (current === "DIRECT") return keep();

  // 1. Equivalent verified skill -> DIRECT.
  for (const set of EQUIVALENTS) {
    if (!set.includes(c)) continue;
    const hit = set.find((s) => s !== c && profileHas(s));
    if (hit) return upgrade(current, "DIRECT", [hit], `equivalent to verified "${hit}"`);
  }

  // 2. Broader verified capability that entails this narrower requirement -> DIRECT.
  for (const broader of NARROWER_OF[c] ?? []) {
    if (profileHas(broader)) {
      return upgrade(current, "DIRECT", [broader], `entailed by broader verified capability "${broader}"`);
    }
  }

  // 3. Umbrella: enough verified components -> the umbrella's max resolution.
  const u = UMBRELLAS[c];
  if (u) {
    const held = u.components.filter(profileHas);
    if (held.length >= u.min) {
      return upgrade(current, u.max, held,
        `umbrella: ${held.length}/${u.components.length} verified components (min ${u.min}); capped at ${u.max}`);
    }
  }

  return keep();
}

/** Apply an upgrade only if it genuinely raises the resolution. */
function upgrade(current: Resolution, to: Resolution, via: string[], basis: string): RelationResult {
  if (RANK[to] <= RANK[current]) return { resolution: current, via: null, basis: null };
  return { resolution: to, via, basis };
}

/** Test-only view of the tables, so a self-test can prove they are sane. */
export const _ontology = { EQUIVALENTS, NARROWER_OF, UMBRELLAS };
