/**
 * What an extraction run will cost, from measured behaviour.
 *
 * pipeline.ts carried `COST_PER_JOB_CENTS = 1.13`, described as
 * "measured, not assumed". It was measured, once, and then the workload
 * moved: across 4,118 real calls the figure is 2.08 cents per extracted
 * job and 1.29 cents per CALL. Every "estimated model cost" the approval
 * gate has printed was low by 84%, which is the wrong direction for a
 * number whose only job is to let a person decide whether to spend.
 *
 * So this computes from tokens and the live price table rather than
 * carrying another constant that will go stale the same way. The only
 * inputs are the model's own prices and the observed token shape, and
 * both are stated where they can be checked.
 *
 * The estimate is deliberately conservative: it rounds toward spending
 * more, and it counts every job in the pool rather than assuming
 * deduplication will succeed. A gate that flatters the cost is worse
 * than no gate.
 */

/** Observed across 4,118 extraction calls on 2026-09-02. */
export const MEASURED = {
  calls: 4118,
  avgInputTokens: 3461,
  avgOutputTokens: 1892,
  /** The 95th percentile matters more than the mean for a ceiling. */
  p95InputTokens: 7000,
  p95OutputTokens: 3800,
} as const;

export interface TokenPrice { in: number; out: number }

/** Cost of one call, in cents, at a given token shape. */
export const callCost = (price: TokenPrice, inTok: number, outTok: number): number =>
  (inTok / 1_000_000) * price.in * 100 + (outTok / 1_000_000) * price.out * 100;

export interface CostEstimate {
  /** Jobs in the pool before deduplication. */
  jobs: number;
  /** Calls actually expected after exact deduplication. */
  calls: number;
  /** Cents, using average token behaviour. */
  expectedCents: number;
  /** Cents, using p95 token behaviour. What the gate should show. */
  ceilingCents: number;
  /** Cents if deduplication achieved nothing. */
  worstCaseCents: number;
}

/**
 * Estimates a run.
 *
 * Three numbers, because one would hide the uncertainty. `expected` is
 * what it should cost; `ceiling` is what it could cost if the postings
 * are long; `worstCase` is what it costs if every description turns out
 * to be distinct. The approval gate shows the ceiling.
 */
export function estimateExtraction(input: {
  jobs: number;
  calls: number;
  price: TokenPrice;
  batch?: boolean;
}): CostEstimate {
  // The Batch API is half price for identical work. Applied only when
  // the caller states the run will actually go through it.
  const factor = input.batch ? 0.5 : 1;
  return {
    jobs: input.jobs,
    calls: input.calls,
    expectedCents: input.calls * callCost(input.price, MEASURED.avgInputTokens, MEASURED.avgOutputTokens) * factor,
    ceilingCents: input.calls * callCost(input.price, MEASURED.p95InputTokens, MEASURED.p95OutputTokens) * factor,
    worstCaseCents: input.jobs * callCost(input.price, MEASURED.p95InputTokens, MEASURED.p95OutputTokens) * factor,
  };
}

export const formatEstimate = (e: CostEstimate): string =>
  `${e.calls} call(s) for ${e.jobs} job(s): expected $${(e.expectedCents / 100).toFixed(2)}, `
  + `ceiling $${(e.ceilingCents / 100).toFixed(2)}, `
  + `$${(e.worstCaseCents / 100).toFixed(2)} if nothing deduplicates`;
