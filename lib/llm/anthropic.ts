import { required } from "../env.ts";
import type {
  CompletionRequest, CompletionResult, EmbeddingRequest, EmbeddingResult,
  LlmProvider, LlmUsage, ModelTier,
} from "./provider.ts";

/**
 * Anthropic implementation of the provider interface.
 *
 * The ONLY file in the system that names a model or knows a price. Call
 * sites declare a tier and a purpose; what that costs is configuration.
 *
 * The key is read through env.ts and never appears in a log, an error
 * message, or a stored row. Errors deliberately surface status and a
 * truncated body, never the request headers.
 */

const MODELS: Record<Exclude<ModelTier, "embedding">, string> = {
  fast: "claude-haiku-4-5-20251001",
  reasoning: "claude-sonnet-5",
};

/** Dollars per million tokens. Used only to estimate; never billed against. */
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5-20251001": { in: 1.0, out: 5.0 },
  "claude-sonnet-5": { in: 3.0, out: 15.0 },
};

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private key: string;

  constructor() {
    this.key = required("ANTHROPIC_API_KEY");
  }

  async complete<T = string>(req: CompletionRequest): Promise<CompletionResult<T>> {
    const model = MODELS[req.tier];
    const started = Date.now();

    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxOutputTokens ?? 2048,
      temperature: req.temperature ?? 0,
      messages: [{ role: "user", content: req.prompt }],
    };
    if (req.system) body["system"] = req.system;
    // Structured output via a single forced tool call: the model cannot
    // reply with prose, so callers never write their own JSON salvaging.
    if (req.jsonSchema) {
      body["tools"] = [{
        name: "emit",
        description: "Return the structured result.",
        input_schema: req.jsonSchema,
      }];
      body["tool_choice"] = { type: "tool", name: "emit" };
    }

    // Retry only what is worth retrying. 429 and 529 are the API asking
    // us to slow down, and 5xx is transient; a 400 is a bad request that
    // will be exactly as bad the second time, so retrying it just burns
    // latency and hides the bug.
    let res: Response;
    let text = "";
    let attempt = 0;
    for (;;) {
      attempt++;
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      text = await res.text();
      if (res.ok) break;

      const retriable = res.status === 429 || res.status === 529 || res.status >= 500;
      if (!retriable || attempt >= 5) {
        // Body only, and truncated. Never the headers: they carry the key.
        throw new Error(`anthropic ${res.status} after ${attempt} attempt(s): ${text.slice(0, 300)}`);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30_000, 2 ** attempt * 1000) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const parsed = JSON.parse(text) as {
      content: Array<{ type: string; text?: string; input?: unknown }>;
      usage: { input_tokens: number; output_tokens: number };
    };

    let content: unknown;
    if (req.jsonSchema) {
      const tool = parsed.content.find((c) => c.type === "tool_use");
      if (!tool || tool.input === undefined) {
        throw new Error("anthropic: structured output requested but no tool_use block returned");
      }
      content = tool.input;
    } else {
      content = parsed.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    }

    const price = PRICING[model] ?? { in: 0, out: 0 };
    const usage: LlmUsage = {
      provider: this.name,
      model,
      inputTokens: parsed.usage.input_tokens,
      outputTokens: parsed.usage.output_tokens,
      estimatedCostCents:
        (parsed.usage.input_tokens / 1_000_000) * price.in * 100 +
        (parsed.usage.output_tokens / 1_000_000) * price.out * 100,
      latencyMs: Date.now() - started,
    };

    return { content: content as T, usage };
  }

  async embed(_req: EmbeddingRequest): Promise<EmbeddingResult> {
    // Deferred by decision: aliases and related_terms first, embeddings
    // only if the measured miss rate justifies them.
    throw new Error("embeddings are deferred until the miss rate is measured");
  }
}

export function modelForTier(tier: Exclude<ModelTier, "embedding">): string {
  return MODELS[tier];
}
