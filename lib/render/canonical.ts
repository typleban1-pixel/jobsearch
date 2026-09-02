/**
 * A stable fingerprint of what the resume SAYS, independent of the PDF.
 *
 * Two hashes exist and they answer different questions:
 *
 *   content_sha256   this file. The employer-facing ResumeDoc, reduced
 *                    to a canonical string and hashed. Identical content
 *                    always produces an identical value, whatever
 *                    Chromium stamps into a PDF.
 *
 *   artifact_sha256  the literal bytes of the rendered PDF. Not
 *                    reproducible: a PDF carries a creation timestamp
 *                    and a document id, so re-rendering identical
 *                    content yields different bytes.
 *
 * The byte hash is the gate. Approval binds to it and the fill path
 * requires it to match before uploading. The content hash exists so a
 * human can tell "the same resume, re-rendered" from "a different
 * resume", and for audit. It is NEVER permission to re-render a missing
 * or mismatched artifact: a document nobody approved is not made
 * approvable by having the same words as one that was.
 *
 * Canonicalization is explicit rather than JSON.stringify, because
 * stringify preserves whatever key order an object happened to be built
 * with. Every field is emitted in a fixed order under a fixed label, so
 * a refactor that reorders a literal cannot change the hash, and adding
 * a field that matters is a deliberate edit here.
 */
import { createHash } from "node:crypto";
import type { ResumeDoc, ResumeLine, ResumeRole } from "./resume.ts";

export const CANONICAL_VERSION = 1;

/** Collapses incidental whitespace; keeps every character that carries meaning. */
const norm = (s: string | null | undefined): string =>
  (s ?? "").replace(/\s+/g, " ").trim();

/**
 * A line contributes its text and the evidence it rests on.
 *
 * Sources are sorted: they are a set, and the order they arrive in is an
 * artefact of how the row was assembled, not part of the claim.
 */
function canonLine(l: ResumeLine): string {
  return `text=${norm(l.text)}\tsources=${[...l.sources].sort().join(",")}`;
}

function canonRole(r: ResumeRole): string {
  return [
    `employer=${norm(r.employer)}`,
    `title=${norm(r.title)}`,
    `location=${norm(r.location)}`,
    `start=${norm(r.start)}`,
    `end=${norm(r.end)}`,
    `startPrecision=${norm(r.startPrecision)}`,
    `endPrecision=${norm(r.endPrecision)}`,
    // Bullet ORDER is meaningful: tailoring decides it, and a reordered
    // resume is a different document to a reader.
    ...r.lines.map((l, i) => `line[${i}]=${canonLine(l)}`),
  ].join("\n");
}

/**
 * The canonical form of an employer-facing document.
 *
 * Everything the employer can read, and nothing else. Presentation is
 * deliberately absent: the same content rendered by a different
 * template is the same content, and a design change must not read as a
 * change to what was said.
 */
export function canonicalizeResume(doc: ResumeDoc): string {
  const parts: string[] = [
    `canonical_version=${CANONICAL_VERSION}`,
    `name=${norm(doc.name)}`,
    `email=${norm(doc.email)}`,
    `phone=${norm(doc.phone)}`,
    `location=${norm(doc.location)}`,
  ];

  // Links carry text and destination separately, and both are visible to
  // a reader: the label is on the page, the href is what a click does.
  doc.links.forEach((l, i) => {
    parts.push(`link[${i}].text=${norm(l.text)}`, `link[${i}].href=${norm(l.href)}`);
  });

  parts.push(`summary=${canonLine(doc.summary)}`);
  doc.roles.forEach((r, i) => parts.push(`role[${i}]\n${canonRole(r)}`));

  doc.education.forEach((e, i) => {
    parts.push(`education[${i}]=${norm(e.credential)}|${norm(e.field)}|${norm(e.institution)}`);
  });

  doc.skillGroups.forEach((g, i) => {
    // Skills within a group are a list the reader scans in order.
    parts.push(`skills[${i}].label=${norm(g.label)}`,
      `skills[${i}].values=${g.skills.map(norm).join("|")}`);
  });

  doc.projects.forEach((p, i) => {
    parts.push(`project[${i}].name=${norm(p.name)}`, `project[${i}].line=${canonLine(p.line)}`);
  });

  return parts.join("\n");
}

export function contentHash(doc: ResumeDoc): string {
  return createHash("sha256").update(canonicalizeResume(doc), "utf8").digest("hex");
}
