/**
 * Storing and retrieving the exact document.
 *
 * The artifact is the PDF bytes and their hash together. Approval binds
 * to the hash; the fill path re-derives it from the stored bytes and
 * refuses to upload anything that does not match. Nothing re-renders at
 * fill time, so there is no path by which a resume can quietly become a
 * different resume between approval and upload.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { hashPdf, renderResume, RENDERER_VERSION } from "./resumePdf.ts";
import { contentHash } from "./canonical.ts";
import { compactToFit, type CompactTrim } from "./compact.ts";
import { auditLayout, type LayoutReport } from "./layoutAudit.ts";
import type { ResumeDoc } from "./resume.ts";

export interface StoredArtifact {
  pdf: Buffer;
  sha256: string;
  bytes: number;
  rendererVersion: number | null;
}

/**
 * Renders a document and stores it against a resume row.
 *
 * Before rendering the final artifact it runs the compaction pass
 * (compact.ts): a trivial trailing overflow is resolved by tightening
 * spacing and, only if that is not enough, trimming the weakest evidence.
 * A bullet trimmed for layout is no longer on the resume, so its
 * resume_claims row is removed too -- the artifact and the recorded
 * provenance never disagree. The rendered artifact is then audited
 * (layoutAudit); the report is returned so the caller can fail closed on
 * a blocking layout defect (Part 21).
 *
 * Pass { noCompact: true } to store a document exactly as given (used by
 * tests that assert a fixed artifact hash).
 */
export async function renderAndStore(
  db: SupabaseClient, resumeId: string, doc: ResumeDoc, opts: { noCompact?: boolean } = {},
): Promise<{ sha256: string; contentSha256: string; bytes: number; pages: number; trims: CompactTrim[]; layout: LayoutReport }> {
  const probe = async (d: ResumeDoc, compact: boolean) => {
    const rr = await renderResume(d, { compact });
    return { pages: rr.pages, contentPx: rr.contentPx };
  };
  const fit = opts.noCompact
    ? { doc, compact: false, trims: [] as CompactTrim[] }
    : await compactToFit(doc, probe);
  const finalDoc = fit.doc;
  const r = await renderResume(finalDoc, { compact: fit.compact });

  // Keep provenance honest: a bullet trimmed to fit is not on the resume,
  // so the claim recorded for it must go. Matched on the exact line text,
  // which is what resume_claims stores.
  for (const t of fit.trims) {
    await db.from("resume_claims").delete().eq("resume_id", resumeId).eq("claim", t.line);
  }

  const content = contentHash(finalDoc);
  // The document itself is stored beside its hash and artifact. The row
  // was inserted with only the accepted line texts, which the review page
  // counts; the Workday experience filler needs the roles, education and
  // skill groups of the document that was actually rendered (after any
  // compaction), and reads them from here. The line list is kept.
  const { data: existing } = await db.from("resumes").select("content").eq("id", resumeId).maybeSingle();
  const lines = Array.isArray((existing?.content as any)?.lines) ? (existing!.content as any).lines : undefined;
  const { error } = await db.from("resumes").update({
    content: { ...(finalDoc as any), ...(lines ? { lines } : {}) },
    content_sha256: content,
    artifact_pdf: r.pdf.toString("base64"),
    artifact_sha256: r.sha256,
    artifact_bytes: r.bytes,
    artifact_rendered_at: new Date().toISOString(),
    renderer_version: r.rendererVersion,
  }).eq("id", resumeId);
  if (error) throw new Error(`could not store the resume artifact: ${error.message}`);

  const layout = auditLayout({ pageCount: r.pages, contentPx: r.contentPx, doc: finalDoc, text: r.extractedText });
  return { sha256: r.sha256, contentSha256: content, bytes: r.bytes, pages: r.pages, trims: fit.trims, layout };
}

export async function loadArtifact(db: SupabaseClient, resumeId: string): Promise<StoredArtifact | null> {
  const { data } = await db.from("resumes")
    .select("artifact_pdf,artifact_sha256,artifact_bytes,renderer_version").eq("id", resumeId).maybeSingle();
  if (!data?.artifact_pdf || !data.artifact_sha256) return null;
  const pdf = Buffer.from(data.artifact_pdf, "base64");
  return { pdf, sha256: data.artifact_sha256, bytes: data.artifact_bytes ?? pdf.length, rendererVersion: data.renderer_version };
}

export type ArtifactVerdict =
  | { ok: true; pdf: Buffer; sha256: string }
  | { ok: false; why: string };

/**
 * The artifact for an application, verified against what was approved.
 *
 * Four ways this fails, and all of them stop rather than regenerate:
 * no resume, no artifact, no approval recorded, or bytes whose hash no
 * longer matches the approval.
 */
export async function approvedArtifact(
  db: SupabaseClient, applicationId: string,
): Promise<ArtifactVerdict> {
  const { data: app } = await db.from("applications")
    .select("resume_id,approved_artifact_sha256,human_approved,authorization_mode").eq("id", applicationId).maybeSingle();
  if (!app) return { ok: false, why: "no such application" };
  if (!app.resume_id) return { ok: false, why: "this application has no resume" };
  // Authorization is the same union the submit gate and readiness use: a
  // person approved it, OR policy authorized it in advance. Requiring
  // human_approved here alone silently broke the autonomous path, which
  // binds an artifact under POLICY_AUTHORIZED and would then be told "no
  // approved artifact is recorded" at the resume gate.
  const authorized = app.human_approved || app.authorization_mode === "POLICY_AUTHORIZED";
  if (!authorized || !app.approved_artifact_sha256) {
    return { ok: false, why: "no approved artifact is recorded for this application" };
  }

  const artifact = await loadArtifact(db, app.resume_id);
  if (!artifact) return { ok: false, why: "the approved resume has no stored PDF artifact" };

  // Re-derived from the bytes, not read from the column beside them.
  const actual = hashPdf(artifact.pdf);
  if (actual !== app.approved_artifact_sha256) {
    return {
      ok: false,
      why: `the stored resume no longer matches what was approved (approved ${app.approved_artifact_sha256.slice(0, 12)}, found ${actual.slice(0, 12)}); it must be reviewed again rather than regenerated`,
    };
  }
  if (actual !== artifact.sha256) {
    return { ok: false, why: "the stored artifact's recorded hash disagrees with its bytes" };
  }
  return { ok: true, pdf: artifact.pdf, sha256: actual };
}

export { RENDERER_VERSION };
