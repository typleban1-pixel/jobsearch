/**
 * Composite occupational concepts, decomposed only when the evidence
 * genuinely supports every part.
 *
 * THE DEFECT THIS EXISTS FOR
 *
 * "product operations" resolves ABSENT because no verified skill is
 * NAMED that, yet the profile holds a whole category of product skills
 * and a whole category of operations skills. Treating the composite as a
 * single un-owned occupation made a job whose two halves the profile
 * clearly covers read as a role-defining gap.
 *
 * THE RULE
 *
 * A multi-word concept is credited TRANSFERABLE (never DIRECT: adjacency
 * is not the thing itself) only when EVERY content component is
 * independently supported by verified evidence. That is what keeps a
 * genuine specialist discipline a genuine gap:
 *
 *   product operations   product (category) + operations (category)  -> TRANSFERABLE
 *   marketing operations  marketing + operations                     -> TRANSFERABLE
 *   revenue operations    revenue (nothing) + operations             -> stays ABSENT
 *   clinical operations   clinical (nothing) + operations            -> stays ABSENT
 *   financial modeling    financial (nothing) + modeling (nothing)   -> stays ABSENT
 *
 * It never manufactures credit from a single unsupported half, and it is
 * deliberately not a string-splitter that waves through any "X
 * operations": the components must each already be things the profile
 * evidences. It is the composite that is new, not the evidence.
 *
 * WHY TRANSFERABLE AND NOT DIRECT
 *
 * Holding product skills and operations skills is not the same as having
 * done "product operations" as a named discipline. It is adjacent and
 * real, which is exactly what TRANSFERABLE means, and it routes a job to
 * a stretch a person reviews, never to an autonomous application on its
 * own.
 */

import type { Resolution } from "./capability.ts";

export const COMPOSITE_VERSION = 1;

export interface CompositeContext {
  /** Resolve a single component against the profile (base resolver). */
  resolve: (concept: string) => Resolution;
  /** Skill categories broad enough to support a component: >= 2 verified skills. */
  supportingCategories: Set<string>;
}

/**
 * Words that are grammar or hedges, not components. "or related",
 * "or similar", "functions", "and" carry no capability of their own and
 * must not each demand independent support.
 */
const NON_COMPONENT = new Set([
  "and", "or", "of", "the", "a", "an", "with", "in", "to", "for", "&",
  "related", "similar", "equivalent", "comparable", "adjacent", "other",
  "relevant", "such", "as", "e.g", "eg", "ie", "etc",
  "functions", "function", "roles", "role", "areas", "area",
]);

/** Split a concept into candidate content components. */
function components(concept: string): string[] {
  return String(concept ?? "")
    .toLowerCase()
    .split(/\s+|\s*[\/,&]\s*|\s+(?:and|or)\s+/)
    .map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").trim())
    .filter((w) => w.length >= 3 && !NON_COMPONENT.has(w));
}

/**
 * Attempts to credit an ABSENT composite concept from its parts.
 *
 * Returns null unless the concept has >= 2 distinct content components
 * AND every one of them is independently supported. The caller applies
 * this only to a concept the base resolver and evidence layer left
 * ABSENT, so it can only ever move ABSENT -> TRANSFERABLE.
 */
export function compositeResolution(
  concept: string,
  ctx: CompositeContext,
): { resolution: Resolution; via: string; rationale: string } | null {
  const parts = [...new Set(components(concept))];
  if (parts.length < 2) return null;

  const supportedBy: string[] = [];
  for (const p of parts) {
    const r = ctx.resolve(p);
    if (r === "DIRECT" || r === "TRANSFERABLE") { supportedBy.push(`${p} (verified capability)`); continue; }
    if (ctx.supportingCategories.has(p)) { supportedBy.push(`${p} (a whole verified skill category)`); continue; }
    // A single unsupported component means the composite is a discipline
    // the profile does not cover. This is the guard that keeps revenue
    // operations, clinical operations and securities operations REJECTs.
    return null;
  }

  return {
    resolution: "TRANSFERABLE",
    via: "composite of verified capabilities",
    rationale: `no skill is named "${concept}", but every part is independently evidenced (`
      + supportedBy.join("; ") + "); adjacent to the composite rather than the named discipline itself",
  };
}
