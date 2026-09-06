/**
 * The layout quality gate: judge the RENDERED artifact, not the source.
 *
 * A resume can be perfectly grounded and still fail a reader on the page:
 * a second sheet holding one education line, an orphan heading, a page 30%
 * full. These are defects of the artifact, and the artifact is the only
 * place they are visible (Part W). This module takes the rendered page
 * count and content height and reports them as inspectable warnings; a
 * serious one blocks autonomous submission (Part 21), fail-closed.
 *
 * It never rewrites content. It reports; the caller compacts or reselects.
 */
import type { ResumeDoc } from "./resume.ts";

export const LAYOUT_AUDIT_VERSION = 1;

/**
 * Effective printable content height per US Letter page for THIS
 * stylesheet, in the CSS px that document.body.scrollHeight reports.
 *
 * Calibrated empirically against the renderer, not derived from the paper
 * size: measured page breaks land between contentPx 845 (one page) and
 * 868 (two pages), so ~855 is where the second page begins. It is tied to
 * RENDERER_VERSION and the print CSS; recalibrate if either changes. Used
 * only to report last-page FILL -- the authoritative page COUNT comes
 * from the rendered PDF (/Count), never from this constant.
 */
export const PAGE_PX = 855;

/** Below this fraction, a trailing page has not earned its existence. */
export const MIN_LAST_PAGE_FILL = 0.25;

export interface LayoutInput {
  /** Pages in the rendered PDF. */
  pageCount: number;
  /** Total content height in CSS px, measured in the browser after render. */
  contentPx: number;
  doc: ResumeDoc;
  /** Text extracted from the rendered document (the ATS view). */
  text: string;
}

export interface LayoutReport {
  lastPageFill: number;
  warnings: string[];
  /** A blocking defect: a trailing near-empty page, or broken extraction. */
  blocking: string[];
  ok: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

export function auditLayout(input: LayoutInput): LayoutReport {
  const { pageCount, contentPx, doc, text } = input;
  const warnings: string[] = [];
  const blocking: string[] = [];

  const lastPageFill = pageCount <= 1
    ? 1
    : Math.max(0, (contentPx - (pageCount - 1) * PAGE_PX) / PAGE_PX);

  // 1. A trailing page that barely holds anything. The canonical failure
  //    is a second sheet carrying one education line.
  if (pageCount > 1 && lastPageFill < MIN_LAST_PAGE_FILL) {
    const msg = `page ${pageCount} is only ~${Math.round(lastPageFill * 100)}% full `
      + `(< ${Math.round(MIN_LAST_PAGE_FILL * 100)}%): trivial overflow that should be compacted onto ${pageCount - 1} page(s)`;
    blocking.push(msg);
  }

  // 2. Very dense first page followed by a nearly empty later one is the
  //    same defect seen from the other side; already covered by (1), but
  //    a 3+ page resume for this profile is itself suspect.
  if (pageCount >= 3) warnings.push(`${pageCount} pages is long for this profile; confirm every page earns its evidence`);

  // 3. ATS extraction survived (Part V). The rendered text must still
  //    carry the identity, the section structure, and every employer and
  //    school, in a machine-readable order.
  const t = norm(text);
  const nameOk = doc.name ? t.includes(norm(doc.name)) : true;
  if (!nameOk) blocking.push("the candidate name did not survive text extraction");
  for (const r of doc.roles ?? []) {
    if (r.employer && !t.includes(norm(r.employer)))
      warnings.push(`employer "${r.employer}" not found in extracted text`);
  }
  for (const e of doc.education ?? []) {
    const inst = (e as any).institution ?? (e as any).school ?? "";
    if (inst && !t.includes(norm(inst)))
      warnings.push(`school "${inst}" not found in extracted text`);
  }
  // A garbled extraction shows up as runs of replacement chars or as text
  // that lost its whitespace entirely.
  if (/�/.test(text)) blocking.push("extracted text contains replacement characters (encoding damage)");
  if (text.trim().length < 200) blocking.push("extracted text is implausibly short; the PDF may not be text-based");

  return { lastPageFill, warnings, blocking, ok: blocking.length === 0 };
}
