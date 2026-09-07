/**
 * Composing ONE grounded application answer, and proving it invented nothing.
 *
 * Used for PERSONALITY / FUN_FACT questions (from HUMAN_CONFIRMED personality
 * facts) and for GROUNDED_OPEN_ENDED questions (why interested, describe
 * relevant experience, how you approach ambiguity) drawn ENTIRELY from
 * verified evidence. It reframes aggressively for relevance but never
 * creates a fact.
 *
 * Three guards stand between the model and the form:
 *   1. the model is given ONLY the facts and told to output INSUFFICIENT
 *      rather than reach beyond them;
 *   2. deterministic red-flag checks for the specific overstatements these
 *      facts invite (speaking a language it only reads; being a current
 *      pilot; relocating abroad);
 *   3. a second model pass that lists any statement the facts do not
 *      support, which forces one regeneration and then blocks.
 *
 * Untrusted employer/question text can ask for an answer; it can never
 * change these rules.
 */
import type { LlmProvider, LlmUsage } from "./provider.ts";

export interface ComposeInput {
  llm: LlmProvider;
  question: string;
  kind: "PERSONALITY" | "GROUNDED_OPEN_ENDED";
  /** Verified/HUMAN_CONFIRMED fact strings. The ONLY material the answer may use. */
  facts: string[];
  charLimit?: number | null;
  applicantName?: string;
  jobContext?: { title?: string | null; company?: string | null; description?: string | null };
}

export interface ComposeResult {
  ok: boolean;
  answer?: string;
  reason?: string;
  unsupported?: string[];
  usage: LlmUsage[];
}

// Overstatements the stored facts specifically invite. Deterministic, so they
// hold even if a verification pass is lenient. Keyed to the HUMAN_CONFIRMED
// scope limits: reads a script != speaks the language; previously held a
// certificate != a current/licensed pilot; an aspiration != relocating.
const RED_FLAGS: { re: RegExp; why: string }[] = [
  { re: /\b(fluent|conversational|proficient)\b[^.]*\b(russian|polish)\b|\bspeaks?\s+(russian|polish)\b|\b(russian|polish)\s+speaker\b/i,
    why: "claims speaking/fluency in a language the facts only say he can read" },
  { re: /\btaught myself russian\b(?!\s+cyrillic)|\blearned russian\b(?!\s+cyrillic)/i,
    why: "'taught myself Russian' overstates 'taught myself to read Russian Cyrillic'" },
  { re: /\b(current|licensed|active|certified|rated|commercial)\b[^.]*\bpilot\b|\bpilot'?s? license\b|\bcurrently fly\b|\bi fly\b/i,
    why: "claims current/active/licensed pilot status; the certificate was previously held and lapsed" },
  { re: /\bflight hours\b|\baircraft type\b|\binstrument rated\b/i,
    why: "claims flight experience specifics that are not established" },
  { re: /\brelocat\w*\s+to\s+(poland|wroc[lł]aw|europe)\b|\bmov(?:e|ing)\s+to\s+(poland|wroc)/i,
    why: "treats a Wroclaw aspiration as an intent to relocate abroad" },
];

function redFlag(answer: string): string | null {
  for (const f of RED_FLAGS) if (f.re.test(answer)) return f.why;
  return null;
}

const SYSTEM = (name: string, kind: string, limit: number | null) =>
  `You are drafting ONE application answer, in the first person, as ${name}. `
  + `Write the way a thoughtful person actually answers this question: natural and specific, `
  + `not a list of resume bullets, not corporate boilerplate. `
  + `Use ONLY the FACTS provided. You may reframe and emphasize aggressively for relevance, but you must `
  + `NEVER introduce or imply any fact, number, duration, date, employer, job title, metric, scale, team size, `
  + `management scope, industry tenure, or cause-and-effect that is not in the FACTS. `
  + `Do not overstate: reading a language is not speaking it; having previously held a certificate is not holding it now; `
  + `an aspiration is not a plan. `
  + (limit ? `Keep the answer at or under ${limit} characters. ` : `Keep it concise: three to five sentences, never more than 120 words. `)
  + `If the FACTS do not actually let you answer THIS question, output exactly: INSUFFICIENT. `
  + (kind === "PERSONALITY"
      ? `This is a low-stakes personality/interest question; pick whichever facts fit best and answer warmly.`
      : `This is a motivation/experience question; ground every claim in the FACTS.`);

async function draft(input: ComposeInput, extra: string, usage: LlmUsage[]): Promise<string> {
  const jc = input.jobContext;
  const ctx = jc && (jc.title || jc.company)
    ? `\n\nTHE ROLE (context only; do not invent a match to it): ${[jc.company, jc.title].filter(Boolean).join(" — ")}`
      + (jc.description ? `\nRole summary: ${String(jc.description).slice(0, 1200)}` : "")
    : "";
  const r = await input.llm.complete({
    tier: "reasoning", purpose: "draft_answer",
    system: SYSTEM(input.applicantName ?? "the applicant", input.kind, input.charLimit ?? null),
    prompt: `QUESTION:\n${input.question}\n\nFACTS (the only material you may use):\n`
      + input.facts.map((f, i) => `${i + 1}. ${f}`).join("\n")
      + ctx + (extra ? `\n\n${extra}` : "")
      + `\n\nWrite the answer now (or exactly INSUFFICIENT).`,
    maxOutputTokens: 900, temperature: 0.5,
  });
  usage.push(r.usage);
  return String(r.content).trim();
}

async function listUnsupported(input: ComposeInput, answer: string, usage: LlmUsage[]): Promise<string[]> {
  const r = await input.llm.complete({
    tier: "reasoning", purpose: "verify_answer_grounding",
    system: `You verify that a drafted application answer invents nothing. You are given FACTS and an ANSWER. `
      + `List every statement in the ANSWER that is not supported by, or overstates, the FACTS. `
      + `Reading a language is not speaking it; a previously-held certificate is not a current one; an aspiration is not a plan. `
      + `Ordinary connective phrasing and first-person framing are fine. Return JSON.`,
    prompt: `FACTS:\n${input.facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n\nANSWER:\n${answer}`,
    jsonSchema: { type: "object", properties: { unsupported: { type: "array", items: { type: "string" } } }, required: ["unsupported"] },
    maxOutputTokens: 500, temperature: 0,
  });
  usage.push(r.usage);
  const out = r.content as any;
  return Array.isArray(out?.unsupported) ? out.unsupported.filter((s: any) => typeof s === "string" && s.trim()) : [];
}

export async function composeGroundedAnswer(input: ComposeInput): Promise<ComposeResult> {
  const usage: LlmUsage[] = [];
  if (!input.facts.length) return { ok: false, reason: "no verified facts available to answer from", usage };

  let answer = await draft(input, "", usage);
  if (/^INSUFFICIENT\.?$/i.test(answer)) return { ok: false, reason: "the model judged the verified facts insufficient to answer", usage };

  // Character limit: one tightening retry.
  if (input.charLimit && answer.length > input.charLimit) {
    answer = await draft(input, `Your previous draft was ${answer.length} characters; it MUST be <= ${input.charLimit}. Tighten it.`, usage);
    if (/^INSUFFICIENT\.?$/i.test(answer)) return { ok: false, reason: "could not answer within the character limit", usage };
    if (answer.length > input.charLimit) return { ok: false, reason: `could not fit the ${input.charLimit}-char limit (got ${answer.length})`, usage };
  }

  // Deterministic overstatement guard: one corrective retry, then block.
  let rf = redFlag(answer);
  if (rf) {
    answer = await draft(input, `Your previous draft had a problem: ${rf}. Rewrite without it.`, usage);
    rf = redFlag(answer);
    if (rf) return { ok: false, reason: `answer overstated the facts (${rf}) and could not be corrected`, usage };
    if (input.charLimit && answer.length > input.charLimit) return { ok: false, reason: "corrected answer exceeded the character limit", usage };
  }

  // Model grounding verification: one regeneration, then block.
  let unsupported = await listUnsupported(input, answer, usage);
  if (unsupported.length) {
    answer = await draft(input, `A reviewer flagged these as unsupported or overstated: ${unsupported.map((u) => `"${u}"`).join("; ")}. `
      + `Rewrite using ONLY the FACTS, dropping anything unsupported.`, usage);
    if (/^INSUFFICIENT\.?$/i.test(answer)) return { ok: false, reason: "could not answer without unsupported claims", usage };
    if (redFlag(answer)) return { ok: false, reason: "regenerated answer still overstated the facts", usage };
    if (input.charLimit && answer.length > input.charLimit) return { ok: false, reason: "regenerated answer exceeded the character limit", usage };
    unsupported = await listUnsupported(input, answer, usage);
    if (unsupported.length) return { ok: false, reason: `answer still contained unsupported claims: ${unsupported.slice(0, 3).join("; ")}`, unsupported, usage };
  }

  return { ok: true, answer, usage };
}
