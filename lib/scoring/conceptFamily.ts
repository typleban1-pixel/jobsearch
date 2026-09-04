/**
 * Semantic de-duplication of redundant tool requirements, for AGGREGATE
 * voting only.
 *
 * A posting that names Excel AND Google Sheets is naming one capability
 * (spreadsheets) twice; counting both as independent role-defining votes
 * lets a generic tool outweigh the requirement that actually defines the
 * job. This groups semantically-equivalent requirements into a family that
 * contributes ONE vote toward the aggregate Match Score, carrying the
 * STRONGEST resolution among its members.
 *
 * Deliberately narrow. Families are only for genuinely interchangeable
 * tools; anything with a distinct professional meaning is left alone. And
 * this changes only AGGREGATION: every original requirement stays in the
 * job record for qualification, explanation, gaps, and audit -- the members
 * are returned alongside each vote precisely so nothing is lost.
 */
import type { Resolution } from "./conceptRelations.ts";
import { norm } from "./conceptRelations.ts";

/** concept -> family key. Conservative: interchangeable tools only. */
const FAMILY: Record<string, string> = {
  "excel": "spreadsheet",
  "microsoft excel": "spreadsheet",
  "ms excel": "spreadsheet",
  "google sheets": "spreadsheet",
  "spreadsheets": "spreadsheet",
  "powerpoint": "presentation",
  "microsoft powerpoint": "presentation",
  "google slides": "presentation",
  "keynote": "presentation",
  "word": "word-processing",
  "microsoft word": "word-processing",
  "google docs": "word-processing",
};

/** The family a concept belongs to, or null when it stands on its own. */
export function familyOf(concept: string): string | null {
  return FAMILY[norm(concept)] ?? null;
}

const RANK: Record<Resolution, number> = { ABSENT: 0, UNKNOWN: 1, TRANSFERABLE: 2, DIRECT: 3 };

export interface Vote {
  /** Family key when de-duplicated, else the concept itself. */
  key: string;
  resolution: Resolution;
  /** The original requirement concepts folded into this vote (>= 1). */
  members: string[];
}

/**
 * Collapse a set of resolved hard concepts into aggregate votes: one per
 * family (strongest resolution wins), one per stand-alone concept. Input
 * order is preserved for the first appearance of each key. Nothing is
 * dropped -- every input concept appears in exactly one vote's `members`.
 */
export function dedupeForVoting(
  concepts: Array<{ concept: string; resolution: Resolution }>,
): Vote[] {
  const byKey = new Map<string, Vote>();
  const order: string[] = [];
  for (const { concept, resolution } of concepts) {
    const key = familyOf(concept) ?? norm(concept);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { key, resolution, members: [concept] });
      order.push(key);
    } else {
      existing.members.push(concept);
      if (RANK[resolution] > RANK[existing.resolution]) existing.resolution = resolution;
    }
  }
  return order.map((k) => byKey.get(k)!);
}

export const _families = FAMILY;
