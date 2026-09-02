/**
 * Whether a piece of verified evidence speaks to a posting.
 *
 * Literal term overlap was tried and was wrong. Against a legal
 * operations posting almost nothing in this profile shares vocabulary,
 * and the resume collapsed to seven bullets across six roles, because
 * transferable work is usually described in the words of the place it
 * happened rather than the words of the job being applied for.
 *
 * So matching happens at the level of the CONCEPT. "Coordinated across
 * departments" and "cross-functional stakeholder management" are the
 * same responsibility wearing different vocabulary, and a posting asking
 * for one is answered by evidence describing the other.
 *
 * This decides ORDER and how much space something earns. It never
 * decides whether a claim is true, never rewrites one, and never
 * invents one. Reframing verified evidence is allowed; creating
 * evidence is not.
 */

export const RELEVANCE_VERSION = 1;

/**
 * Concepts, each a cluster of the words real postings and real resumes
 * use for the same underlying responsibility.
 *
 * Deliberately about WORK rather than about industries: the point is to
 * recognise a responsibility across vocabularies, not to guess that a
 * legal team and a marketing team need the same person.
 */
const CONCEPTS: Record<string, string[]> = {
  cross_functional: [
    "cross-functional", "crossfunctional", "cross functional", "stakeholder", "stakeholders",
    "collaborate", "collaboration", "coordinate", "coordination", "liaison", "partner",
    "department", "departments", "teams", "internal", "align", "alignment", "interdepartmental",
  ],
  requirements_intake: [
    "requirements", "intake", "specification", "specifications", "scope", "scoping", "define",
    "definition", "translate", "translating", "objectives", "goals", "brief", "discovery",
    "gather", "gathering", "elicit", "needs",
  ],
  process_workflow: [
    "process", "processes", "workflow", "workflows", "procedure", "procedures", "sop", "sops",
    "operations", "operational", "streamline", "efficiency", "improvement", "optimize",
    "standardize", "documentation", "playbook", "policy", "policies", "administration",
  ],
  project_execution: [
    "project", "projects", "program", "programs", "timeline", "timelines", "deadline",
    "deadlines", "priorities", "prioritize", "concurrent", "deliverable", "deliverables",
    "execution", "execute", "delivery", "manage", "management", "planning", "schedule",
  ],
  troubleshooting: [
    "troubleshoot", "troubleshooting", "debug", "diagnose", "resolve", "resolution", "support",
    "maintain", "maintenance", "fix", "issue", "issues", "problem", "problems", "root cause",
  ],
  systems_tools: [
    "system", "systems", "platform", "platforms", "tool", "tools", "integration", "integrations",
    "software", "automation", "automate", "crm", "saas", "implementation", "implement",
    "configure", "configuration", "adoption", "onboarding", "migration", "technical",
  ],
  data_analysis: [
    "analytics", "analysis", "analytical", "data", "report", "reporting", "reports", "metrics",
    "dashboard", "dashboards", "insight", "insights", "measure", "measurement", "track", "tracking",
  ],
  vendor_contract: [
    "vendor", "vendors", "contract", "contracts", "procurement", "negotiation", "negotiate",
    "compliance", "agreement", "agreements", "billing", "invoicing", "subscription", "renewal",
    "legal", "risk", "audit",
  ],
  marketing_growth: [
    "marketing", "campaign", "campaigns", "email", "seo", "content", "audience", "brand",
    "branding", "ecommerce", "acquisition", "lifecycle", "growth", "social", "advertising",
    "copy", "messaging", "positioning", "launch", "launches",
  ],
  product_development: [
    "product", "roadmap", "prototype", "prototyping", "iteration", "iterative", "feature",
    "features", "design", "development", "build", "shipped", "release", "user", "customer",
    "research", "testing", "validation",
  ],
  teaching_enablement: [
    "training", "train", "teaching", "teach", "mentor", "mentoring", "enablement", "instruction",
    "instructor", "curriculum", "coaching", "educate", "guidance", "workshop",
  ],
  client_service: [
    "client", "clients", "customer", "customers", "account", "accounts", "relationship",
    "service", "success", "consulting", "advisory", "communication", "presenting",
  ],
  creative_production: [
    "video", "editing", "editor", "production", "creative", "motion", "graphics", "photography",
    "camera", "post-production", "film", "footage", "adobe", "premiere",
  ],
};

/**
 * Dots and hyphens are inside the class so that "node.js", "e-billing",
 * "cross-functional" and "go-to-market" survive as single tokens rather
 * than being split into halves that mean something else. Commas, colons,
 * semicolons, brackets and quotes are outside it and already separate
 * words, which is why only these two characters need trimming below.
 */
const WORD = /[a-z0-9+#.-]+/g;

/**
 * The same class also swallowed the full stop that ends a sentence, so
 * the final token of a claim was "operations." and no concept term ever
 * matched it. Every claim in the profile ends in one, so every claim
 * lost its last word: the identical sentence scored 4 without its last
 * character and 0 with it.
 *
 * Trimming is therefore at the EDGES only. An interior dot or hyphen is
 * part of the word and stays; a leading or trailing one is punctuation
 * the class caught by accident. This is the whole fix, and it changes no
 * concept, no weight and no formula.
 */
const EDGE_PUNCTUATION = /^[.-]+|[.-]+$/g;

export function wordsOf(text: string): Set<string> {
  return new Set((text.toLowerCase().match(WORD) ?? [])
    .map((w) => w.replace(EDGE_PUNCTUATION, ""))
    .filter((w) => w.length > 2));
}

/**
 * Which concepts a set of already-extracted words expresses.
 *
 * Separated from conceptsOf so that tokenizing and matching are two
 * steps rather than one. The before-and-after analysis of the
 * tokenization fix needs to run the identical dictionary over two
 * different word sets; without this seam it would have to copy the
 * dictionary, which is the drift that has bitten this codebase twice.
 */
export function conceptsFromWords(words: Set<string>, lower: string): Set<string> {
  const found = new Set<string>();
  for (const [concept, terms] of Object.entries(CONCEPTS)) {
    for (const t of terms) {
      if (t.includes(" ") ? lower.includes(t) : words.has(t)) { found.add(concept); break; }
    }
  }
  return found;
}

/** Which concepts a piece of text expresses. */
export function conceptsOf(text: string): Set<string> {
  return conceptsFromWords(wordsOf(text), text.toLowerCase());
}

export interface RelevanceProfile {
  /** Concepts the posting asks for. */
  concepts: Set<string>;
  /** The posting's own words, for the residual literal signal. */
  words: Set<string>;
}

export function profileFor(roleTitle: string, requirementTerms: string[]): RelevanceProfile {
  const all = [roleTitle, ...requirementTerms].join(" ");
  return { concepts: conceptsOf(all), words: wordsOf(all) };
}

/**
 * How strongly a claim speaks to this posting.
 *
 * Concept agreement dominates, because that is the signal that survives
 * a change of vocabulary. A small literal bonus remains so that an exact
 * term match still counts for something, but it cannot carry a claim on
 * its own.
 *
 * A number for ordering, not a probability and not a confidence. It says
 * nothing about whether the claim is true; grounding decided that long
 * before this ran.
 */
export function scoreClaim(claim: string, profile: RelevanceProfile): number {
  return scoreFromTokens(conceptsOf(claim), wordsOf(claim), profile);
}

/**
 * The formula, over tokens that have already been extracted.
 *
 * Split out for the same reason conceptsFromWords is: so a comparison
 * of two tokenizers runs one copy of the weights rather than two.
 * Three per agreeing concept, plus at most three for literal overlap.
 * Unchanged by the tokenization fix.
 */
export function scoreFromTokens(
  claimConcepts: Set<string>, claimWords: Set<string>, profile: RelevanceProfile,
): number {
  let score = 0;
  for (const c of claimConcepts) if (profile.concepts.has(c)) score += 3;
  let literal = 0;
  for (const w of claimWords) if (profile.words.has(w) && w.length > 4) literal++;
  return score + Math.min(literal, 3);
}

/**
 * Whether a capability is worth employer-facing space.
 *
 * A skill earns a place by helping explain fit for THIS posting, not by
 * existing in the profile. The verified inventory stays comprehensive;
 * what an employer sees is deliberately narrower.
 */
/**
 * Brand names, which say who makes a tool and not which tool it is.
 *
 * A posting asking for Google Sheets contains the word "google", and
 * plain word overlap therefore made every Google product relevant to it.
 * That is how Google Docs reached a resume for a job that asked for
 * spreadsheets and never mentioned documents: it shared a vendor with
 * the thing actually required.
 *
 * These tokens are ignored on their own. They still count as part of a
 * full tool name, so "Google Sheets" against a Google Sheets requirement
 * matches on "sheets" and on the whole name, and nothing about a genuine
 * match is weakened.
 *
 * Used only by scoreCapability, which decides which verified skills are
 * worth printing. Claim relevance and corpus scoring do not consult it.
 */
const VENDOR_TOKENS = new Set([
  "google", "microsoft", "ms", "adobe", "apple", "amazon", "meta",
  "oracle", "ibm", "salesforce", "atlassian", "intuit", "autodesk",
]);

/**
 * How relevant one verified skill is to this posting.
 *
 * Three signals, strongest first. The whole tool name appearing in the
 * posting is the strongest thing that can happen and is scored as such;
 * a shared concept is next; a shared ordinary word is the weakest and is
 * what the vendor rule above exists to keep honest.
 */
export function scoreCapability(skill: string, profile: RelevanceProfile): number {
  let score = 0;

  // The exact tool, named. "google sheets" asked for and "Google Sheets"
  // held is not an overlap of tokens, it is the same tool.
  const name = skill.toLowerCase().trim();
  const asked = [...profile.concepts, ...profile.words].join(" ");
  if (name.includes(" ") && asked.includes(name)) score += 6;

  for (const c of conceptsOf(skill)) if (profile.concepts.has(c)) score += 2;

  for (const w of wordsOf(skill)) {
    if (w.length <= 3 || VENDOR_TOKENS.has(w)) continue;
    if (profile.words.has(w)) score += 2;
  }
  return score;
}
