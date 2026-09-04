/**
 * Turning one pasted posting into a grounded, rendered resume.
 *
 * This is the Resume Builder's half of the worker. It runs ONLY on the
 * Mac (it needs the Anthropic key to extract + reframe and local Chrome
 * to render), exactly like application preparation, and it goes through
 * the SAME shared engine: extract requirements -> composeFromRequirements
 * (grounding + provenance gates unchanged) -> renderAndStore (the exact
 * immutable artifact). No application record is touched.
 *
 * generateResume() does the work and returns an outcome; it never writes
 * the generation row to DONE. The caller (the listener) writes DONE with
 * the bindings this returns, so the DB's integrity trigger can prove the
 * recorded hashes match the resume it links.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LlmProvider } from "../llm/provider.ts";
import {
  extractRequirements, sanitizeRequirement, reconcileHardness, dedupeRequirements, EXTRACTION_VERSION,
} from "../llm/extractRequirements.ts";
import { htmlToText, normalizeWhitespace } from "../ingest/normalize/text.ts";
import { composeFromRequirements, type RequirementInput } from "./prepare.ts";
import { renderAndStore } from "../render/artifact.ts";
import { GROUNDING_VERSION } from "../render/grounding.ts";

export { EXTRACTION_VERSION };

export interface ResumeGenerationRow {
  id: string;
  pasted_text: string;
  pasted_html: string | null;
  detected_title: string | null;
  detected_company: string | null;
  corrected_title: string | null;
  corrected_company: string | null;
}

export type GenerationOutcome =
  | {
      ok: true;
      resumeId: string;
      artifactSha256: string;
      contentSha256: string;
      profileVersion: number;
      tailoringSummary: Record<string, unknown>;
    }
  | { ok: false; errorCategory: GenerationErrorCategory; errorDetail: string };

export type GenerationErrorCategory =
  | "POSTING_UNCLEAR" | "EXTRACTION_FAILED" | "GROUNDING_FAILED" | "RENDER_FAILED";

const effective = (a: string | null, b: string | null) => (a ?? b ?? "").trim();

/** The "Show Tailoring Details" payload: evidence provenance, never model reasoning. */
function tailoringSummary(c: any): Record<string, unknown> {
  const accepted = c.result?.accepted ?? [];
  return {
    jobThemes: c.themes?.terms ?? [],
    reframes: accepted
      .filter((a: any) => a.generation === "REFRAMED" && a.text !== a.original)
      .map((a: any) => ({ from: a.original, to: a.text })),
    emphasized: accepted.map((a: any) => a.text).slice(0, 12),
    revertedForProvenance: c.revertedForProvenance ?? [],
    dropped: c.dropped ?? [],
  };
}

export async function generateResume(
  db: SupabaseClient, gen: ResumeGenerationRow, llm: LlmProvider,
): Promise<GenerationOutcome> {
  const title = effective(gen.corrected_title, gen.detected_title);
  const company = effective(gen.corrected_company, gen.detected_company);

  // The plain text drives extraction; sanitized HTML, if present, is only
  // a richer rendering of the same posting, never a separate source.
  const descriptionText = gen.pasted_text?.trim()
    ? gen.pasted_text
    : (gen.pasted_html ? htmlToText(gen.pasted_html) : "");
  if (normalizeWhitespace(descriptionText).length < 40) {
    return { ok: false, errorCategory: "POSTING_UNCLEAR", errorDetail: "the pasted posting had too little content to work from" };
  }

  // 1. Extract requirements from the pasted text -- the same extractor,
  //    sanitiser, hardness reconciliation and dedupe the ingest path uses.
  let requirements: RequirementInput[];
  try {
    const { content } = await extractRequirements(llm, { title, company, descriptionText });
    const cleaned = (content.requirements ?? [])
      .map((r) => sanitizeRequirement(r)?.requirement)
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .map((r) => reconcileHardness(r));
    requirements = dedupeRequirements(cleaned as any).kept;
  } catch (e) {
    return { ok: false, errorCategory: "EXTRACTION_FAILED", errorDetail: String((e as Error)?.message ?? e).slice(0, 300) };
  }

  // 2. Compose through the ONE shared, grounding-checked engine. A pasted
  //    posting with no recoverable title still composes against themes.
  const composeTitle = title || "the role";
  const c = await composeFromRequirements(db, { requirements, title: composeTitle }, llm);
  if (c.provenanceFailure) {
    return { ok: false, errorCategory: "GROUNDING_FAILED", errorDetail: c.provenanceFailure.slice(0, 300) };
  }
  if (!c.doc || !c.result || !c.masterResumeId || typeof c.profileVersion !== "number") {
    return { ok: false, errorCategory: "GROUNDING_FAILED", errorDetail: "no groundable resume could be composed from the evidence" };
  }

  // 3. Persist a NEW resumes row + its claims. Never mutates a prior one;
  //    a regenerate is always a fresh row and a fresh artifact.
  const { data: resume, error } = await db.from("resumes").insert({
    label: `Resume Builder: ${company || "posting"} - ${composeTitle} (profile version ${c.profileVersion})`,
    is_master: false,
    content: { lines: c.result.accepted.map((a) => a.text) } as any,
    tailoring_strategy: "REFRAME_WITHIN_CITED_EVIDENCE",
    grounding_version: GROUNDING_VERSION,
    derived_from: c.masterResumeId,
  }).select("id").single();
  if (error || !resume) {
    return { ok: false, errorCategory: "RENDER_FAILED", errorDetail: `could not store resume: ${error?.message ?? "unknown"}` };
  }
  const claimRows = [
    ...c.result.accepted.map((a: any) => ({
      resume_id: resume.id, claim: a.text, evidence_ids: a.evidenceIds,
      source_text: a.sourceText, generation: a.generation,
      grounding_checks: { ok: true, checks: a.verdict?.checks, version: GROUNDING_VERSION } as any,
    })),
    ...c.result.rejected.map((r: any) => ({
      resume_id: resume.id, claim: r.proposed, evidence_ids: r.evidenceIds,
      source_text: r.sourceText, generation: "REFRAMED",
      grounding_checks: { ok: false, failedCheck: r.failedCheck, detail: r.failureDetail, version: GROUNDING_VERSION } as any,
    })),
  ];
  if (claimRows.length) await db.from("resume_claims").insert(claimRows);

  // 4. Render + store the immutable PDF (sets artifact + content hashes).
  let rendered;
  try {
    rendered = await renderAndStore(db, resume.id, c.doc);
  } catch (e) {
    return { ok: false, errorCategory: "RENDER_FAILED", errorDetail: String((e as Error)?.message ?? e).slice(0, 300) };
  }

  return {
    ok: true,
    resumeId: resume.id,
    artifactSha256: rendered.sha256,
    contentSha256: rendered.contentSha256,
    profileVersion: c.profileVersion,
    tailoringSummary: tailoringSummary(c),
  };
}
