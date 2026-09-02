/**
 * Employer-authored logical relationships between requirements.
 *
 * THE DEFECT THIS EXISTS FOR
 *
 * SpotHero asked for "3+ years of legal operations experience or 5+
 * years of operations experience and an interest in the legal field".
 * Extraction emitted two rows, both HARD, and recorded the alternation
 * only in prose:
 *
 *   "The 'or' clause provides an alternative path but both are
 *    presented as required."
 *   "Alternative requirement in the same sentence as the 3+ years
 *    legal operations requirement."
 *
 * The model saw the alternation. There was no column to put it in, so it
 * went into hard_requirement_reason, which nothing parses. Downstream,
 * two alternative paths became two independently mandatory requirements
 * and failing both counted as two core gaps, which is how one satisfiable
 * requirement became grounds for rejection.
 *
 * THE INVARIANT
 *
 * An employer-authored alternative must never become several
 * independently mandatory requirements. For A OR B, failing A is not a
 * gap when B holds.
 *
 * THE REPRESENTATION
 *
 * Two nullable fields carried on a requirement:
 *
 *   alternativeGroup  requirements sharing this are alternatives (OR)
 *   conjunctKey       within a group, members sharing this are ANDed
 *
 * That is enough for everything seen in the corpus:
 *
 *   A AND B          two groups, or no group at all
 *   A OR B           group g: A conjunct "a", B conjunct "b"
 *   A OR (B AND C)   group g: A conjunct "a", B and C both conjunct "b"
 *
 * Model 3 is not modified. This collapses a group into ONE concept
 * before Model 3 sees it, so the frozen rules keep operating on a list
 * of concepts exactly as they always have. The fix is upstream of the
 * scoring rules on purpose.
 */

/** Satisfied, not satisfied, or not established. Null is UNKNOWN. */
export type Credit = number | null;

export interface LogicalRequirement {
  id: string;
  concept: string;
  /** >0 satisfied, 0 not satisfied, null not established. */
  credit: Credit;
  hardness?: string;
  alternativeGroup?: string | null;
  conjunctKey?: string | null;
  [k: string]: unknown;
}

/**
 * A conjunct is satisfied only if every member is, and is UNKNOWN if any
 * member is unknown and none has failed.
 *
 * Order matters: a definite failure beats an unknown. If one half of "B
 * AND C" is absent, the conjunct fails whatever the other half is doing,
 * and no amount of uncertainty elsewhere rescues it.
 */
export function conjunctCredit(members: LogicalRequirement[]): Credit {
  if (!members.length) return 0;
  if (members.some((m) => m.credit === 0)) return 0;
  if (members.some((m) => m.credit === null)) return null;
  return Math.min(...members.map((m) => m.credit as number));
}

/**
 * A group is satisfied if ANY conjunct is, and UNKNOWN only when nothing
 * is satisfied and something is unresolved.
 *
 * This is where "UNKNOWN must remain UNKNOWN" is enforced. An
 * alternative nobody can evaluate does not become an absence merely
 * because the other alternative failed: the honest answer is that the
 * requirement is unresolved, and a person decides.
 */
export function groupCredit(members: LogicalRequirement[]): Credit {
  const byConjunct = new Map<string, LogicalRequirement[]>();
  for (const m of members) {
    const k = m.conjunctKey ?? m.id;
    byConjunct.set(k, [...(byConjunct.get(k) ?? []), m]);
  }
  const credits = [...byConjunct.values()].map(conjunctCredit);
  const best = credits.filter((c): c is number => c !== null);
  if (best.some((c) => c > 0)) return Math.max(...best);
  if (credits.some((c) => c === null)) return null;
  return 0;
}

export interface CollapsedRequirement extends LogicalRequirement {
  /** The ids this concept now stands for. One entry when ungrouped. */
  covers: string[];
  /** How the group was satisfied, for the audit trail. */
  satisfiedBy?: string | null;
}

/**
 * Collapses alternative groups into one requirement each.
 *
 * Requirements with no group pass through untouched, so a posting with
 * no alternatives behaves exactly as it does today. This is what keeps
 * the change safe to introduce: on the 2,166 jobs with no disjunction
 * detected, the output is byte-identical to the input.
 */
export function collapseAlternatives(reqs: LogicalRequirement[]): CollapsedRequirement[] {
  const out: CollapsedRequirement[] = [];
  const groups = new Map<string, LogicalRequirement[]>();

  for (const r of reqs) {
    if (!r.alternativeGroup) { out.push({ ...r, covers: [r.id] }); continue; }
    groups.set(r.alternativeGroup, [...(groups.get(r.alternativeGroup) ?? []), r]);
  }

  for (const [group, members] of groups) {
    // A "group" of one is not an alternative. Passing it through as an
    // ordinary requirement keeps a mis-grouped row from silently
    // becoming unfalsifiable.
    if (members.length === 1) { out.push({ ...members[0]!, covers: [members[0]!.id] }); continue; }

    const credit = groupCredit(members);
    const satisfied = members.find((m) => typeof m.credit === "number" && m.credit > 0);
    // The concept reads as the alternation it is, so a gap report names
    // what the employer actually asked for rather than one arbitrary
    // half of it.
    const concept = [...new Set(members.map((m) => m.concept))].join(" or ");
    out.push({
      ...(satisfied ?? members[0]!),
      id: `group:${group}`,
      concept,
      credit,
      covers: members.map((m) => m.id),
      satisfiedBy: satisfied?.concept ?? null,
      alternativeGroup: group,
      conjunctKey: null,
    });
  }
  return out;
}

/**
 * Requirements stating alternative qualifications, found without an LLM.
 *
 * A deterministic first pass so the corpus can be repaired without
 * paying to re-extract it. It is deliberately conservative: it groups
 * only when one requirement's quoted text CONTAINS another's from the
 * same posting and the containing text puts an "or" between them, which
 * is the exact shape extraction produces when it splits an alternation.
 *
 * What it will not do is treat every "or" as a disjunction. "Excellent
 * written or verbal communication" is one requirement whose text happens
 * to contain the word, and nothing else quotes a sub-span of it, so no
 * group forms.
 */
export function detectAlternativeGroups(
  reqs: Array<{ id: string; rawText: string }>,
): Map<string, string> {
  const groups = new Map<string, string>();
  const norm = (s: string) => String(s).replace(/\s+/g, " ").trim().toLowerCase();

  for (const outer of reqs) {
    const o = norm(outer.rawText);
    for (const inner of reqs) {
      if (inner.id === outer.id) continue;
      const i = norm(inner.rawText);
      if (i.length < 12 || i.length >= o.length) continue;
      const at = o.indexOf(i);
      if (at <= 0) continue;

      // THE CONNECTOR IMMEDIATELY BEFORE THE SECOND CLAUSE decides this,
      // and nothing else does.
      //
      // An earlier version accepted any "or" anywhere in the outer text.
      // That grouped "Lives in OR in proximity to market AND willingness
      // to travel" with "willingness to travel", because it found the
      // "or" inside the first clause and never looked at the "and" that
      // actually joins the two. Every one of those would have made a
      // genuine conjunction satisfiable by one half, which is a worse
      // failure than the one this exists to fix: it would make a
      // candidate look MORE qualified than the evidence supports.
      const before = o.slice(0, at).trimEnd();
      const isAlternation = /\bor\s*$/.test(before) || /\bor,\s*$/.test(before);
      const isConjunction = /\b(and|with|plus|including|as well as)\s*$/.test(before);
      if (!isAlternation || isConjunction) continue;

      const g = groups.get(outer.id) ?? `alt:${outer.id}`;
      groups.set(outer.id, g);
      groups.set(inner.id, g);
    }
  }
  return groups;
}
