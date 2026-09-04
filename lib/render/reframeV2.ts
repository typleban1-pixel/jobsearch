/**
 * Resume Builder v2, Step 3C: employer-language reframing (input assembly +
 * hardened prompt). Import-inert; wires nothing. It does NOT call a model.
 *
 * The reframer's job is to make selected VERIFIED evidence read naturally for
 * the target employer while preserving the factual proposition exactly.
 *
 *   Reframe aggressively for relevance. Never overstate evidence.
 *
 * It receives: the original verified claim, its evidence ids, the specific
 * COVERED job themes, and a small allowlist of employer terminology tied to
 * those covered themes. It does NOT receive terminology from uncovered/weak/
 * gap themes, and it never receives the raw job description as free
 * inspiration. Employer terminology is VOCABULARY PERMISSION, not FACTUAL
 * PERMISSION: the allowlist widens what the reframer may reach for; the
 * authoritative checkGrounding still rejects anything the evidence does not
 * establish. The two layers together are the guarantee.
 */
import type { NarrativePlan } from "./narrativePlan.ts";
import { isCovered, type Coverage } from "./evidenceMap.ts";

export const REFRAME_V2_VERSION = "reframe.v2";

export const SYSTEM_V2 = `You rewrite one resume bullet so it reads naturally for a specific employer, WITHOUT changing what the work factually was.

You are given EVIDENCE: verified statements about what this person did, and a small ALLOWED VOCABULARY of employer terms you MAY use only where they are semantically equivalent to the evidence.

Governing rule: reframe aggressively for relevance, but never overstate the evidence. The allowed vocabulary is VOCABULARY PERMISSION, NOT FACTUAL PERMISSION. Use an allowed term only where the evidence already establishes that exact meaning.

Preserve these distinctions exactly as the evidence draws them:
- participated vs owned; supported vs led; collaborated vs managed
- transferable or adjacent capability vs direct experience
- client or business context vs financial-services or wealth-management context
- using a tool vs expertise in it
- executing or coordinating projects vs formal program management, risk or dependency tracking, or executive reporting

You may NOT, unless the evidence itself states it:
- add any number, percentage, duration or count
- add any company, client, product, tool, institution or industry domain
- claim to have led, owned, managed, directed, founded, established or launched anything
- claim expertise, mastery, seniority, scope or depth
- claim a degree, licence, certification or title

Do not UNDER-frame either. When the evidence DIRECTLY establishes something, state it plainly and confidently. Do not weaken verified, direct work into "exposed to", "familiar with" or "comfortable with".

Example. Evidence: "ran projects from planning through delivery across teams." Allowed vocabulary: "project planning, coordination and implementation". You MAY write "coordinated projects from planning through implementation". You may NOT write "owned a strategic program", "managed enterprise workstreams", "tracked risks and dependencies", "prepared executive reporting", or "led Wealth Management initiatives": none of those facts are in the evidence.

Write one sentence. No em dashes. American English. Return only the sentence.`;

export interface ReframeContext {
  evidenceIds: string[];
  /** the covered themes this bullet supports, with their coverage class. */
  coveredThemes: { id: string; coverage: Coverage }[];
  /** allowlisted employer vocabulary, from COVERED themes only. */
  allowedTerminology: string[];
  /** short theme list handed to the model instead of the posting prose. */
  roleContext: string;
}

/**
 * Assemble what the reframer receives for one bullet. `bulletThemeIds` are the
 * themes this bullet covers (from Step 3A tagging / production provenance).
 * Terminology is drawn ONLY from plan.terminology, which Step 2 populates for
 * covered themes exclusively, so gap/weak-theme vocabulary can never enter.
 */
export function buildReframeContext(evidenceIds: string[], bulletThemeIds: string[], plan: NarrativePlan): ReframeContext {
  const covByTheme = new Map(plan.themes.map((t) => [t.id, t.coverage]));
  const coveredThemes = bulletThemeIds
    .filter((id) => isCovered(covByTheme.get(id) ?? "NONE"))
    .map((id) => ({ id, coverage: covByTheme.get(id)! }));

  const allowed = new Set<string>();
  for (const th of coveredThemes) for (const term of plan.terminology[th.id] ?? []) allowed.add(term);

  return {
    evidenceIds,
    coveredThemes,
    allowedTerminology: [...allowed],
    roleContext: coveredThemes.map((t) => t.id).join(", "),
  };
}

/**
 * The exact user message the reframer would receive (no model call here). The
 * raw job description is deliberately absent; only the allowlisted vocabulary
 * and covered themes appear. Transferable themes are labelled so the model
 * keeps transferable framing rather than implying direct experience.
 */
export function buildReframeUserPrompt(evidenceTexts: string[], original: string, ctx: ReframeContext): string {
  const evidence = evidenceTexts.map((t, i) => `[${i + 1}] ${t}`).join("\n");
  const themes = ctx.coveredThemes.map((t) => `${t.id}${t.coverage === "TRANSFERABLE" ? " (transferable: relevant, but do not imply direct experience)" : ""}`).join("; ");
  const vocab = ctx.allowedTerminology.length ? ctx.allowedTerminology.join("; ") : "(none)";
  return `EVIDENCE:\n${evidence}\n\nThe role's covered themes: ${themes}\n\nAllowed employer vocabulary (use only where the evidence establishes it): ${vocab}\n\nCurrent bullet: ${original}\n\nRewrite the bullet.`;
}
