/**
 * One extraction per distinct description.
 *
 * 42.2% of open jobs share a byte-identical description_hash with
 * another job, and extract.ts selected per job and never grouped, so 705
 * of 2,562 historical extractions re-sent text the model had already
 * seen. Same input, same model, same prompt: the second call could only
 * produce the same answer, at full price.
 *
 * EXACT, NOT APPROXIMATE
 *
 * Grouping is on the hash of the description and nothing else. Not
 * title, not company, not similarity, not embeddings. Two postings with
 * the same title at the same company routinely differ in their text --
 * 817 such pairs in this corpus do -- and sharing an extraction between
 * them would invent requirements for one from the other's words. The
 * hash is the only signal that proves the inputs are the same thing.
 *
 * A job with no description hash is never a follower. Absence of a hash
 * is not evidence of sameness.
 *
 * INVALIDATION
 *
 * Reuse is keyed to the hash that produced it. When a posting's
 * description changes its hash changes, so the job no longer belongs to
 * the group it was filed under and is extracted again. That falls out of
 * grouping on the live hash rather than needing a rule of its own.
 */

export interface DedupJob {
  id: string;
  /** Hash of the description as it stands NOW. Null when unknown. */
  descriptionHash: string | null;
}

export interface ExtractionPlan<T extends DedupJob> {
  /** Jobs that will actually be sent to the model. */
  leaders: T[];
  /** leader id -> the jobs that reuse its result. */
  followers: Map<string, T[]>;
  /** Distinct hashes needing work, plus every hashless job. */
  uniqueInputs: number;
  /** Calls avoided. */
  reused: number;
}

/**
 * Splits a pool into the calls that must happen and the reuse that follows.
 *
 * Leader choice is deterministic -- lowest id in the group -- so the same
 * pool always produces the same plan. A run that is interrupted and
 * restarted picks the same leaders and cannot half-attribute a group.
 */
export function planExtraction<T extends DedupJob>(pool: T[]): ExtractionPlan<T> {
  const byHash = new Map<string, T[]>();
  const leaders: T[] = [];
  const followers = new Map<string, T[]>();

  for (const j of pool) {
    // No hash, no proof of sameness: it stands alone.
    if (!j.descriptionHash) { leaders.push(j); continue; }
    byHash.set(j.descriptionHash, [...(byHash.get(j.descriptionHash) ?? []), j]);
  }

  for (const [, group] of byHash) {
    const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));
    const leader = sorted[0]!;
    leaders.push(leader);
    if (sorted.length > 1) followers.set(leader.id, sorted.slice(1));
  }

  const reused = [...followers.values()].reduce((n, g) => n + g.length, 0);
  return { leaders, followers, uniqueInputs: leaders.length, reused };
}

/**
 * Whether a stored reuse is still valid.
 *
 * The follower must still carry the same hash it was filed under, and so
 * must the job it borrowed from. Either changing means the two are no
 * longer known to be the same text, and the follower needs its own
 * extraction.
 */
export function reuseStillValid(input: {
  followerHash: string | null;
  sourceHash: string | null;
  hashAtReuse: string | null;
}): boolean {
  const { followerHash, sourceHash, hashAtReuse } = input;
  if (!followerHash || !sourceHash || !hashAtReuse) return false;
  return followerHash === hashAtReuse && sourceHash === hashAtReuse;
}

/** What a run would have cost without dedup, and what it costs with it. */
export function dedupSavings(plan: ExtractionPlan<DedupJob>, costPerCall: number) {
  const without = (plan.leaders.length + plan.reused) * costPerCall;
  const withDedup = plan.leaders.length * costPerCall;
  return { without, withDedup, saved: without - withDedup,
           ratio: without > 0 ? withDedup / without : 1 };
}
