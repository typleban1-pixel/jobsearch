/**
 * Freezing the corpus a score was computed against.
 *
 * Information weighting makes Fit depend on how many postings demand each
 * concept, so the same job legitimately scores differently once more
 * postings are ingested. That is correct, and it is a reproducibility
 * hazard: without the frequencies, a historical score cannot be
 * recomputed or defended.
 *
 * A snapshot is written per run and never edited, exactly as profile
 * versions are. A historical score cites one.
 */
import { createHash } from "node:crypto";
import type { CorpusStatistics } from "./fit.ts";

export function statisticsHash(df: Record<string, number>, jobCount: number): string {
  const canonical = Object.keys(df).sort().map((k) => `${k}:${df[k]}`).join("|");
  return createHash("sha256").update(`${jobCount}\n${canonical}`).digest("hex");
}

export function toCorpusStatistics(
  df: Record<string, number>,
  jobCount: number,
  floor: number,
): CorpusStatistics {
  return { documentFrequency: new Map(Object.entries(df)), jobCount, floor };
}
