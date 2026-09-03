/**
 * Workday prompts are trees, not lists.
 *
 * "How Did You Hear About Us?" offers eight first-level entries and not
 * one of them can be chosen: each is a category that opens a second
 * level. Treating the first level as the answer typed the category into
 * the search box, committed nothing, and left Workday reporting the
 * required field as empty while the control read back the text we had
 * just typed. A read-back that reads what you wrote proves nothing.
 *
 * The tree is read from the DOM rather than assumed. A node Workday can
 * store carries a real instance id; a category carries the literal
 * NO_METADATA_ID and a side charm (the chevron). That distinction is the
 * employer's own, which is why it is used instead of guessing from the
 * label.
 */

export type OptionNode = {
  label: string;
  /** data-uxi-multiselectlistitem-instanceid */
  instanceId: string | null;
  /** data-uxi-multiselectlistitem-hassidecharm */
  hasSideCharm: boolean;
};

export const NO_METADATA = "NO_METADATA_ID";

/** Selectable, or a category that has to be opened first. */
export function classifyOption(o: OptionNode): "LEAF" | "BRANCH" {
  if (!o.instanceId || o.instanceId === NO_METADATA) return "BRANCH";
  return "LEAF";
}

/**
 * The answer as a path.
 *
 * A stored answer may name the leaf alone, or the whole route to it.
 * Recording the route keeps the hierarchy as evidence: "Northern Trust
 * Web Site > Careers Web Site" says which category the leaf sits under,
 * and two employers with a "Referral" leaf under different categories
 * stay distinguishable.
 */
export function parseOptionPath(answer: string): string[] {
  return String(answer ?? "")
    .split(/\s*(?:>|→|→|\/)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export const formatOptionPath = (parts: string[]): string => parts.join(" > ");

export type Choice =
  | { ok: true; label: string; kind: "LEAF" | "BRANCH" }
  | { ok: false; why: string; offered: string[] };

/**
 * One option, matched exactly.
 *
 * Never by containment: a "Referral" leaf sits inside "Employee
 * Referral", and among these very options "Job Board" is a substring of
 * nothing but "Social Network" and "Network" would collide if this ever
 * loosened.
 */
export function chooseOption(options: OptionNode[], wanted: string): Choice {
  const want = String(wanted ?? "").trim().toLowerCase();
  if (!want) return { ok: false, why: "no option was asked for", offered: options.map((o) => o.label) };
  const hits = options.filter((o) => o.label.trim().toLowerCase() === want);
  if (hits.length === 1) return { ok: true, label: hits[0]!.label, kind: classifyOption(hits[0]!) };
  if (hits.length > 1) {
    return { ok: false, why: `${hits.length} options are labelled ${JSON.stringify(wanted)}`, offered: options.map((o) => o.label) };
  }
  return { ok: false, why: `no option is labelled ${JSON.stringify(wanted)}`, offered: options.map((o) => o.label) };
}

/**
 * What to do at a level, given the remaining path.
 *
 * When the path names the next step, that name decides. When it does not
 * and the level offers exactly one selectable leaf, that leaf is
 * unambiguous and is taken. Anything else stops: picking among several
 * leaves without being told which is a guess about what the person
 * meant.
 */
export type Step =
  | { action: "SELECT"; label: string }
  | { action: "DESCEND"; label: string }
  | { action: "STOP"; why: string; offered: string[] };

export function nextStep(options: OptionNode[], remaining: string[]): Step {
  if (!options.length) return { action: "STOP", why: "the level offered no options", offered: [] };
  if (remaining.length) {
    const c = chooseOption(options, remaining[0]!);
    if (!c.ok) return { action: "STOP", why: c.why, offered: c.offered };
    return c.kind === "LEAF" ? { action: "SELECT", label: c.label } : { action: "DESCEND", label: c.label };
  }
  const leaves = options.filter((o) => classifyOption(o) === "LEAF");
  if (leaves.length === 1) return { action: "SELECT", label: leaves[0]!.label };
  return { action: "STOP",
    why: leaves.length
      ? `${leaves.length} selectable options here and the answer does not say which`
      : "no selectable option at this level and the answer does not say which category to open",
    offered: options.map((o) => o.label) };
}
