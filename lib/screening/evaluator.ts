/**
 * The outside reader.
 *
 * Deliberately its own prompt and its own call, sharing no context with
 * the model that wrote the tailored claims. The writer knows what the
 * evidence supports and will defend its choices; the point of this pass
 * is to get a reading from something that knows only what an employer
 * knows. Anything less than a separate context is not an independent
 * review, it is the author marking their own work.
 *
 * The output is validated hard. An evaluator is a source of opinions,
 * and an opinion that arrives in an unexpected shape is discarded rather
 * than interpreted: a finding nobody designed a response to cannot be
 * acted on safely.
 */
import type { CompletionResult, LlmProvider, LlmUsage } from "../llm/provider.ts";
import { assertNoEvidenceLeak, renderPacket, type ScreeningPacket } from "./packet.ts";
import type { FindingKind, ScreeningFinding, ScreeningResult, RequirementCoverage } from "./types.ts";

export const EVALUATOR_VERSION = 1;

const KINDS: FindingKind[] = [
  "REQUIREMENT_CLEARLY_SUPPORTED", "REQUIREMENT_PARTIALLY_SUPPORTED", "REQUIREMENT_UNSUPPORTED",
  "CAPABILITY_BURIED", "TERMINOLOGY_MISMATCH", "CLAIM_TOO_VAGUE", "CHRONOLOGY_CONFUSING",
  "STRONGEST_EVIDENCE_UNDEREMPHASIZED", "IRRELEVANT_MATERIAL_DOMINATES", "PRESENTATION_RISK",
];

const SYSTEM = `You are a screening system used by an employer to read a resume against one posting.

You see only the posting and the resume, which is all the employer sees. You do not
know anything about the candidate beyond what the resume says, and you must not
assume anything it does not state.

Report what a reader of THIS DOCUMENT would conclude. That is different from what is
true about the candidate, and where the resume is unclear the honest finding is that
it is unclear, not that the candidate lacks the experience.

Be specific and be brief. "Could be stronger" helps nobody; neither does a paragraph.
Say which requirement, what the resume says about it, and what a screening reader
would take from that, in one or two sentences. Cover every requirement in coverage,
even where the answer is short.

When a finding is about the resume's presentation rather than about a requirement,
quote the exact sentence from the resume that it is about, in quotedFromResume. A
presentation finding that names no sentence cannot be acted on.

You are not writing the resume. Do not propose replacement wording, and do not
suggest adding anything the resume does not already say.

The assessment score is an integer from 0 to 100, where 0 means a screening reader
would reject immediately and 100 means every requirement is clearly and visibly met.
It is used only to compare drafts of the same resume against each other. Do not
return a fraction between 0 and 1.`;

const SCHEMA = {
  type: "object",
  required: ["findings", "coverage", "assessment"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "detail", "severity"],
        properties: {
          kind: { type: "string", enum: KINDS },
          requirement: { type: ["string", "null"] },
          detail: { type: "string" },
          quotedFromResume: { type: ["string", "null"] },
          severity: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
        },
      },
    },
    coverage: {
      type: "array",
      items: {
        type: "object",
        required: ["requirement", "appears"],
        properties: {
          requirement: { type: "string" },
          appears: { type: "string", enum: ["CLEAR", "PARTIAL", "ABSENT"] },
          where: { type: ["string", "null"] },
        },
      },
    },
    assessment: {
      type: "object",
      required: ["score", "summary"],
      properties: {
        // Stated in the prompt as well: an unqualified "number" was read
        // as a 0-to-1 fraction on several real postings, which made the
        // figure incomparable between evaluations.
        score: { type: "number", minimum: 0, maximum: 100 },
        summary: { type: "string" },
        strongestSignal: { type: ["string", "null"] },
        weakestSignal: { type: ["string", "null"] },
      },
    },
  },
} as const;

export interface EvaluateOptions {
  /** Configurable so cheaper and stronger models can be compared. */
  model?: string;
  /** Injected in tests. Production passes the real provider. */
  complete?: LlmProvider["complete"];
}

/**
 * How much room the evaluator gets to answer.
 *
 * Measured, not guessed. Against 20 real postings the mean output was
 * 2,553 tokens and a quarter of evaluations were cut off at 3,000, and a
 * truncated tool call is discarded rather than stored, so the ceiling
 * was throwing away one evaluation in four. This is roughly three times
 * the observed mean, which leaves room for the longest postings without
 * inviting more words: the prompt asks for brevity, and paying for
 * headroom is not the same as asking for it.
 */
export const MAX_OUTPUT_TOKENS = 8000;

/**
 * What to say when the model returns something the schema refuses.
 *
 * Deliberately carries no new information: it repeats what was wrong and
 * nothing else. The retry must not become a second, better-informed
 * prompt, because then a failed first attempt would be a way to tell the
 * evaluator things the packet does not.
 */
const RETRY_NOTE = `Your previous response did not match the required structure and was discarded.

Return ONLY the structured result the tool schema describes: a findings array, a
coverage array, and an assessment object containing a numeric score from 0 to 100
and a summary. Do not place the whole result inside a single string field, and do
not add fields the schema does not name.`;

export interface Evaluation extends ScreeningResult {
  usage: LlmUsage;
  packetChars: number;
  /** 1 when the first response was usable, 2 when the retry produced it. */
  attempts: number;
  /** Why the first attempt was rejected, when there was a retry. */
  firstAttemptFailure: string | null;
}

/**
 * Runs one blind evaluation.
 *
 * The leak check happens here rather than at the call site, so there is
 * no path to an evaluation that skipped it.
 */
export async function evaluateBlind(
  packet: ScreeningPacket, provider: LlmProvider, opts: EvaluateOptions = {},
): Promise<Evaluation> {
  assertNoEvidenceLeak(packet);
  const text = renderPacket(packet);
  const complete = opts.complete ?? provider.complete.bind(provider);

  const ask = (note: string | null) => complete<any>({
    tier: "reasoning",
    model: opts.model,
    system: SYSTEM,
    prompt: note ? `${text}\n\n---\n${note}` : text,
    jsonSchema: SCHEMA as unknown as Record<string, unknown>,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    purpose: "screen_resume",
  }) as Promise<CompletionResult<any>>;

  // One attempt, and one retry for one specific reason.
  //
  // Against the real model, one response in two arrived with the whole
  // result stuffed into a single string field. That is a formatting
  // failure, and saying so is usually enough. A provider error is not:
  // a timeout or a 500 says nothing about the answer, and retrying it
  // here would duplicate the retry the provider already does. Those
  // propagate, and the document they were about is untouched.
  let first: CompletionResult<any>;
  try {
    first = await ask(null);
  } catch (e) {
    throw e;
  }

  try {
    return {
      ...validate(decodeMangledToolOutput(first.content)),
      evaluatorVersion: EVALUATOR_VERSION,
      model: first.usage.model,
      usage: first.usage,
      packetChars: text.length,
      attempts: 1,
      firstAttemptFailure: null,
    };
  } catch (invalid) {
    const why = String(invalid).replace(/^Error:\s*/, "").slice(0, 200);
    const second = await ask(RETRY_NOTE);
    // A second failure is a failure. validate() is not relaxed for it.
    const parsed = validate(decodeMangledToolOutput(second.content));
    return {
      ...parsed,
      evaluatorVersion: EVALUATOR_VERSION,
      model: second.usage.model,
      // Both attempts were paid for, so both are reported.
      usage: {
        ...second.usage,
        inputTokens: first.usage.inputTokens + second.usage.inputTokens,
        outputTokens: first.usage.outputTokens + second.usage.outputTokens,
        estimatedCostCents: first.usage.estimatedCostCents + second.usage.estimatedCostCents,
        latencyMs: first.usage.latencyMs + second.usage.latencyMs,
      },
      packetChars: text.length,
      attempts: 2,
      firstAttemptFailure: why,
    };
  }
}

/**
 * Undoes one specific transport mangling, before validation runs.
 *
 * The real model returns, often, a tool input shaped like this:
 *
 *   { "assessment": "{\"score\": 12, ...}, \"findings\": [...], \"coverage\": []" }
 *
 * That is the correct answer with a quotation mark in the wrong place:
 * the first key's value swallowed the rest of the object and became a
 * string. Re-parsing it recovers exactly what the model meant and adds
 * nothing, which is why this is decoding rather than accommodating.
 *
 * validate() is not relaxed by this and does not know it happened.
 * Whatever comes out of here still has to satisfy the schema, and a
 * string that does not parse, or parses into something with fewer keys
 * than it started with, is passed through untouched to be rejected.
 */
export function decodeMangledToolOutput(raw: any): any {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;

    // Two shapes, because the string may or may not carry the outer
    // object's own closing brace. The real model includes it: the value
    // ends "...\"coverage\": []}" and adding a second brace made the
    // parse fail, which is why the first version of this decoder never
    // recovered a single real response. The synthetic fixture it was
    // written against happened to omit that brace.
    for (const candidate of [`{${JSON.stringify(key)}:${trimmed}`, `{${JSON.stringify(key)}:${trimmed}}`]) {
      try {
        const rebuilt = JSON.parse(candidate);
        if (rebuilt && typeof rebuilt === "object" && !Array.isArray(rebuilt)
            && Object.keys(rebuilt).length > Object.keys(raw).length) {
          return rebuilt;
        }
      } catch {
        // Not this shape. Try the other, then leave it to validation.
      }
    }
  }
  return raw;
}

/**
 * Accepts only what the contract describes.
 *
 * Findings of an unknown kind are dropped, not coerced to the nearest
 * one. A score outside 0 to 100 is a broken evaluator, and a broken
 * evaluator's number is worse than no number.
 */
export function validate(raw: any): Omit<ScreeningResult, "evaluatorVersion" | "model"> {
  const findings: ScreeningFinding[] = [];
  for (const f of Array.isArray(raw?.findings) ? raw.findings : []) {
    if (!KINDS.includes(f?.kind)) continue;
    if (typeof f?.detail !== "string" || !f.detail.trim()) continue;
    findings.push({
      kind: f.kind,
      requirement: typeof f.requirement === "string" ? f.requirement : null,
      detail: f.detail.trim(),
      quotedFromResume: typeof f.quotedFromResume === "string" ? f.quotedFromResume : null,
      severity: ["HIGH", "MEDIUM", "LOW"].includes(f?.severity) ? f.severity : "LOW",
    });
  }

  const coverage: RequirementCoverage[] = [];
  for (const c of Array.isArray(raw?.coverage) ? raw.coverage : []) {
    if (typeof c?.requirement !== "string") continue;
    if (!["CLEAR", "PARTIAL", "ABSENT"].includes(c?.appears)) continue;
    coverage.push({ requirement: c.requirement, appears: c.appears, where: typeof c.where === "string" ? c.where : null });
  }

  const score = Number(raw?.assessment?.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`the evaluator returned an unusable score (${raw?.assessment?.score}); a comparison number that is out of range is worse than none`);
  }

  return {
    findings, coverage,
    assessment: {
      score,
      summary: String(raw?.assessment?.summary ?? "").trim(),
      strongestSignal: typeof raw?.assessment?.strongestSignal === "string" ? raw.assessment.strongestSignal : null,
      weakestSignal: typeof raw?.assessment?.weakestSignal === "string" ? raw.assessment.weakestSignal : null,
    },
  };
}
