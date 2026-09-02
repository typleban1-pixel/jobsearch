/**
 * Telling "no evidence" apart from "not established".
 *
 * THE DEFECT
 *
 * resolveConcept matches a requirement against skill NAMES, aliases and
 * related terms. When nothing matches it returns ABSENT with the
 * rationale "no verified or proposed evidence speaks to this". For most
 * concepts that is true. For some it is false, and SpotHero is the case
 * that showed it: the profile holds eighteen VERIFIED skills categorised
 * "operations" and the word appears in the job title of both Genius One
 * stints, and "5+ years of operations experience" resolved ABSENT
 * because no skill is literally named "operations".
 *
 * ABSENT reaches Model 3 as a core gap, which asserts the evidence shows
 * he cannot do this. It showed no such thing.
 *
 * WHAT THIS LAYER DOES
 *
 * It sits after the base resolver and can move a result in exactly one
 * direction: ABSENT to UNKNOWN, when verified evidence of the right kind
 * exists but does not establish the requirement. It can also settle a
 * duration question when the profile records an explicit one.
 *
 * It can never produce DIRECT or TRANSFERABLE. Credit is the base
 * resolver's business, and a layer that could invent credit would be a
 * way to manufacture qualifications.
 *
 * THE RULE THIS EXISTS TO PROTECT
 *
 *   Employment duration is not capability duration.
 *
 * Five and a half years in a role titled "Digital Marketing, Product &
 * Operations Specialist" is not five years of operations: the role was
 * three things at once, and only one responsibility line of nine
 * mentions operations at all. So tenure is not consulted here, at all,
 * and a duration requirement with no explicit capability duration behind
 * it resolves UNKNOWN rather than being satisfied by how long a job
 * lasted.
 *
 * WHAT IS DELIBERATELY NOT USED
 *
 * Word presence in responsibility prose. A corpus dry run showed it
 * rescuing "trade" because "trade shows" appears in a responsibility,
 * and "business" because "business needs" does. Neither is an
 * occupational claim. Only two signals count: a verified skill CATEGORY
 * naming the concept exactly, and an explicitly recorded capability
 * duration.
 */
import type { Resolution } from "./capability.ts";

export interface EvidenceContext {
  /** Categories of VERIFIED, non-EXPOSURE skills. Exact names only. */
  verifiedCategories: Set<string>;
  /** Durations the profile states for a capability, in years. */
  capabilityYears: Map<string, number>;
  /** Capabilities or credentials explicitly declared as not held. */
  notHeld: Set<string>;
}

export interface EvidenceResolution {
  resolution: Resolution;
  rationale: string;
  /** True when this layer moved the base resolver's answer. */
  changed: boolean;
}

const norm = (s: string) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Refines one base resolution using evidence the matcher cannot see.
 *
 * Order is deliberate. A declared negative is checked before anything
 * else, because "he does not hold this" is the strongest statement the
 * profile can make and no amount of adjacent evidence may soften it.
 */
export function resolveWithEvidence(
  concept: string,
  base: { resolution: Resolution; via: string | null; rationale: string },
  ctx: EvidenceContext,
  req: { minimumYears?: number | null },
): EvidenceResolution {
  const key = norm(concept);
  const unchanged = { resolution: base.resolution, rationale: base.rationale, changed: false };

  // 1. An explicit negative settles it, whatever else is nearby.
  if (ctx.notHeld.has(key)) {
    return {
      resolution: "ABSENT",
      rationale: "the profile declares this is not held, so nothing adjacent substitutes for it",
      changed: base.resolution !== "ABSENT",
    };
  }

  // 2. An explicitly recorded capability duration answers a duration
  //    requirement, in both directions. This is the only place a number
  //    of years may decide anything, and it reads a duration the profile
  //    states about the CAPABILITY, never one inferred from a job.
  const years = ctx.capabilityYears.get(key);
  if (typeof req.minimumYears === "number" && typeof years === "number") {
    if (years >= req.minimumYears) return unchanged;
    return {
      resolution: "ABSENT",
      rationale: `the profile records ${years} years of this and the requirement asks for ${req.minimumYears}, `
        + "so the shortfall is established rather than merely unproven",
      changed: base.resolution !== "ABSENT",
    };
  }

  // 3. Only an ABSENT is open to reinterpretation. A base resolver that
  //    found something keeps its answer.
  if (base.resolution !== "ABSENT") return unchanged;

  // 4. A verified skill CATEGORY naming this concept exactly.
  //
  //    Exact, not substring. "operational risk management" contains
  //    "operations" nowhere as a word and must not be rescued by it, and
  //    "market research" is not the "marketing" category. Substring
  //    similarity was the first thing tried and it produced exactly the
  //    kind of false support this system exists to refuse.
  if (ctx.verifiedCategories.has(key)) {
    const durationNote = typeof req.minimumYears === "number"
      ? ` The requirement asks for ${req.minimumYears} years and the profile records no duration for this `
        + "capability, so the duration is unestablished; time spent in a role that included this work is not "
        + "a measure of the work itself."
      : "";
    return {
      resolution: "UNKNOWN",
      rationale: "verified skills are categorised under this concept, so relevant evidence exists, but no skill "
        + "names it and nothing establishes the requirement itself." + durationNote,
      changed: true,
    };
  }

  return unchanged;
}

/**
 * Builds the context from profile rows.
 *
 * Kept beside the rule so what counts as evidence is visible in one
 * place rather than assembled differently by each caller.
 */
export function buildEvidenceContext(input: {
  skills: Array<{ name: string; category?: string | null; status?: string | null; level?: string | null }>;
  metrics: Array<{ label?: string | null; unit?: string | null; numeric_value?: number | null; approved_for_use?: boolean | null }>;
  notHeld?: string[];
}): EvidenceContext {
  const verified = input.skills.filter((s) =>
    s.status === "VERIFIED" && s.level !== "EXPOSURE");

  const verifiedCategories = new Set(
    verified.map((s) => norm(s.category ?? "")).filter(Boolean));

  // Only durations the profile states about a capability, and only ones
  // approved for use. "Years of hands-on FDM 3D printing experience"
  // becomes fdm 3d printing -> 4.
  const capabilityYears = new Map<string, number>();
  for (const m of input.metrics) {
    if (m.approved_for_use === false) continue;
    if (norm(m.unit ?? "") !== "years" || typeof m.numeric_value !== "number") continue;
    const label = norm(m.label ?? "")
      .replace(/^years of\s+/, "")
      .replace(/^hands[- ]on\s+/, "")
      .replace(/\s+experience$/, "");
    if (label) capabilityYears.set(label, m.numeric_value);
  }

  return { verifiedCategories, capabilityYears, notHeld: new Set((input.notHeld ?? []).map(norm)) };
}
