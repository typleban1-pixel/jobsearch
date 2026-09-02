/**
 * The only place the rest of the system is allowed to know an LLM exists.
 *
 * Nothing above this file imports a vendor SDK, names a model, or knows
 * what a token costs. Swapping Anthropic for something else should be a
 * new file in this directory and one line of configuration, not a
 * refactor, which is the explicit requirement.
 *
 * Two things are deliberately part of the interface rather than left to
 * each call site:
 *
 * 1. Every task declares a TIER, not a model. Call sites say how hard the
 *    work is; configuration decides what that costs. This is what makes
 *    the cost funnel enforceable: a job cannot quietly be sent to an
 *    expensive model because somebody hardcoded one.
 *
 * 2. Every call reports usage. Cost control that depends on remembering
 *    to log is cost control that stops working in week three.
 */

export type ModelTier =
  /** Cheap, high volume. Classification, normalization, extraction. */
  | "fast"
  /** Judgement. Fit reasoning, requirement interpretation, drafting. */
  | "reasoning"
  /** Embeddings for the semantic prefilter. */
  | "embedding";

export interface LlmUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostCents: number;
  latencyMs: number;
}

export interface CompletionRequest {
  tier: Exclude<ModelTier, "embedding">;
  system?: string;
  prompt: string;
  /** Ask for structured output. Providers that support it natively should
   *  use that; those that do not must still return parsed JSON or throw,
   *  so callers never write their own parsing. */
  jsonSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  temperature?: number;
  /** Identifies the task for cost attribution: "extract_requirements",
   *  "score_fit", "draft_answer". Recorded against every call. */
  purpose: string;
  /**
   * Overrides the tier's model for this one call.
   *
   * Exists so one task can be benchmarked across models without moving
   * every other task with it. The model actually used is reported back
   * in usage, so a stored result always names what produced it rather
   * than what was configured at the time.
   */
  model?: string;
}

export interface CompletionResult<T = string> {
  content: T;
  usage: LlmUsage;
}

export interface EmbeddingRequest {
  input: string[];
  purpose: string;
}

export interface EmbeddingResult {
  vectors: number[][];
  usage: LlmUsage;
}

export interface LlmProvider {
  readonly name: string;
  complete<T = string>(req: CompletionRequest): Promise<CompletionResult<T>>;
  embed(req: EmbeddingRequest): Promise<EmbeddingResult>;
}

/**
 * Guard rails that belong to the boundary rather than to any provider.
 *
 * A provider is free to be fast or cheap; it is not free to let the
 * system spend without bound. The runner wraps every provider so that
 * budget, retry and usage recording happen once rather than in each of
 * the dozen places that will eventually call an LLM.
 */
export interface LlmRunnerOptions {
  /** Hard stop. Reaching it throws rather than degrading silently, so a
   *  runaway loop fails loudly during the run that caused it. */
  dailyBudgetCents: number;
  onUsage: (usage: LlmUsage & { purpose: string }) => Promise<void>;
}
