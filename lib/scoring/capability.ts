import type { MatchStatus } from "../matching/match.ts";
import { toConcept } from "../matching/concepts.ts";

/**
 * Resolves a requirement concept against the profile.
 *
 * Four outcomes that must never collapse into one another:
 *
 *   DIRECT        verified evidence IS this thing
 *   TRANSFERABLE  adjacent verified evidence partially supports it
 *   UNKNOWN       proposed but unverified, or a credential we have not
 *                 asked about. Costs nothing and raises uncertainty.
 *   ABSENT        nothing in the profile speaks to it
 *
 * UNKNOWN and ABSENT are the pair that matters most. Scoring an unknown
 * as an absence invents a gap; scoring an absence as unknown hides a real
 * one.
 */

export type Resolution = "DIRECT" | "TRANSFERABLE" | "UNKNOWN" | "ABSENT";

export interface CapabilityIndex {
  /** normalized concept -> relation */
  relations: Map<string, { skill: string; relation: "DIRECT" | "TRANSFERABLE"; rationale: string }>;
  matchTerm: (term: string) => { status: MatchStatus; skillName: string | null; method: string; terminal: "NAME" | "RELATED" | null };
}

export interface ResolutionResult {
  resolution: Resolution;
  via: string | null;
  rationale: string;
}

export function resolveConcept(
  concept: string,
  index: CapabilityIndex,
  opts: { isGatingCredential?: boolean; credentialsDeclared?: boolean } = {},
): ResolutionResult {
  // A regulated credential the user has never been asked about is UNKNOWN,
  // not absent. His rule: "If the credential requirement is unknown or
  // ambiguous, preserve uncertainty." Once he states which credentials he
  // holds or does not hold, these become genuine ABSENT and turn into real
  // qualification failures.
  if (opts.isGatingCredential && !opts.credentialsDeclared) {
    return { resolution: "UNKNOWN", via: null,
             rationale: "regulated credential; the profile has not yet declared which credentials are held" };
  }
  return resolveConceptInner(concept, index);
}

function resolveConceptInner(concept: string, index: CapabilityIndex): ResolutionResult {
  const key = toConcept(concept).concept;
  const m = index.matchTerm(key);

  // 1. Terminal match on the skill's own NAME is the thing itself. An
  //    alias hop that ends on a related term is not, however direct the
  //    method looks.
  if (m.status === "VERIFIED" && m.terminal === "NAME") {
    return { resolution: "DIRECT", via: m.skillName, rationale: `verified skill matched via ${m.method}` };
  }

  // 2. The capability graph, checked BEFORE related-term matching.
  //
  //    Order matters and getting it wrong was a real false positive.
  //    "project management" sits in Project coordination's related_terms,
  //    so a matcher-first order returned DIRECT and granted full credit,
  //    silently overruling the graph row that deliberately says
  //    TRANSFERABLE. Coordinating projects is not owning project
  //    management, and the graph is where that judgement lives.
  const rel = index.relations.get(key);
  if (rel) {
    return { resolution: rel.relation, via: rel.skill, rationale: rel.rationale };
  }

  // 3. A related-term match with no graph row. Adjacent by construction,
  //    so partial credit, never full: related_terms are synonyms the
  //    profile volunteered, not claims of equivalence.
  if (m.status === "VERIFIED") {
    return { resolution: "TRANSFERABLE", via: m.skillName,
             rationale: `matched a related term on ${m.skillName}; adjacent rather than the thing itself` };
  }

  // 3. A proposed but unverified skill. Unknown, never a gap.
  if (m.status === "SUGGESTED") {
    return { resolution: "UNKNOWN", via: m.skillName, rationale: "matches a skill that is proposed but not yet verified" };
  }

  return { resolution: "ABSENT", via: null, rationale: "no verified or proposed evidence speaks to this" };
}

/** Credit toward coverage. TRANSFERABLE earns partial, never full. */
export function creditFor(r: Resolution): number | null {
  switch (r) {
    case "DIRECT": return 1;
    case "TRANSFERABLE": return 0.5;
    case "ABSENT": return 0;
    case "UNKNOWN": return null;   // excluded from the ratio entirely
  }
}
