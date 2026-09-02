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
import type { ResumeDoc } from "./resume.ts";

export interface StoredArtifact {
  pdf: Buffer;
  sha256: string;
  bytes: number;
  rendererVersion: number | null;
}

/** Renders a document and stores it against a resume row. */
export async function renderAndStore(
  db: SupabaseClient, resumeId: string, doc: ResumeDoc,
): Promise<{ sha256: string; contentSha256: string; bytes: number; pages: number }> {
  const r = await renderResume(doc);
  const content = contentHash(doc);
  const { error } = await db.from("resumes").update({
    content_sha256: content,
    artifact_pdf: r.pdf.toString("base64"),
    artifact_sha256: r.sha256,
    artifact_bytes: r.bytes,
    artifact_rendered_at: new Date().toISOString(),
    renderer_version: r.rendererVersion,
  }).eq("id", resumeId);
  if (error) throw new Error(`could not store the resume artifact: ${error.message}`);
  return { sha256: r.sha256, contentSha256: content, bytes: r.bytes, pages: r.pages };
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
    .select("resume_id,approved_artifact_sha256,human_approved").eq("id", applicationId).maybeSingle();
  if (!app) return { ok: false, why: "no such application" };
  if (!app.resume_id) return { ok: false, why: "this application has no resume" };
  if (!app.human_approved || !app.approved_artifact_sha256) {
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
