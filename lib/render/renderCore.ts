/**
 * Rendering machinery shared by every template.
 *
 * The parts that must behave identically whatever a resume looks like:
 * turning HTML into a PDF, hashing the bytes, extracting the text, and
 * refusing to return a document that does not contain every line it was
 * given. A template supplies markup and nothing else.
 *
 * That last check is the boundary between presentation and content. A
 * renderer that drops a bullet to make a page fit has edited a claim,
 * so it is caught here rather than reported later.
 */
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import type { ResumeDoc, ResumeLine, ResumeRole } from "./resume.ts";
import { documentLines } from "./tailoredDoc.ts";
import { launchBrowser, newPreparedContext, newPreparedPage } from "../browser/launch.ts";

export interface RenderedResume {
  pdf: Buffer;
  sha256: string;
  bytes: number;
  pages: number;
  rendererVersion: number;
  /** Text as a reader and an ATS see it, for verification. */
  extractedText: string;
}

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const year = (d: string | null) => (d === null ? "Present" : d.slice(0, 4));

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/** A date at the precision its record holds, never more. */
function atPrecision(d: string | null, precision: string | undefined): string {
  if (d === null) return "Present";
  return precision === "MONTH"
    ? `${MONTH_NAMES[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`
    : year(d);
}

/**
 * The dates beside an entry.
 *
 * When an entry presents several real periods, every one of them is
 * printed. Collapsing them into an outer span would assert continuous
 * employment across a gap that happened, which is the thing the
 * chronology guard exists to prevent.
 */
export function dateRange(r: ResumeRole): string {
  const periods = r.periods?.length ? r.periods : [r];
  return [...periods]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((p) => `${atPrecision(p.start, p.startPrecision)} – ${atPrecision(p.end ?? null, p.endPrecision)}`)
    .join(", ");
}

/** Display text and destination stay separate, always. */
export const anchor = (l: { text: string; href: string }) =>
  `<a href="${esc(l.href)}">${esc(l.text)}</a>`;

export function hashPdf(pdf: Buffer | Uint8Array): string {
  return createHash("sha256").update(pdf).digest("hex");
}

/**
 * Renders one template's HTML, then verifies it kept everything.
 *
 * `pageHeightPx` is the printable height for the template's own page
 * margins, so a template with more generous margins is not misreported
 * as running long.
 */
export async function renderHtmlToPdf(
  html: string, doc: ResumeDoc, rendererVersion: number, pageHeightPx: number,
): Promise<RenderedResume> {
  const browser = await launchBrowser();
  try {
    const page = await newPreparedPage(browser, );
    await page.setContent(html, { waitUntil: "load" });

    const pdf = await page.pdf({ format: "Letter", printBackground: true, preferCSSPageSize: true });
    const extractedText = (await page.evaluate(() => document.body.innerText)) ?? "";
    // Counted from the PDF itself, not estimated from the body height.
    //
    // The old measurement divided the continuous scroll height by a
    // printable-height constant, which knows nothing about where pages
    // actually break. It reported Candidate #5 as two pages when the
    // file contained three, and that wrong number is why nobody noticed
    // the document had spread out.
    const pages = countPdfPages(pdf, pageHeightPx);

    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    const rendered = normalize(extractedText);
    const lines = documentLines(doc);
    const missing = lines.filter((l) => l && !rendered.includes(normalize(l)));
    if (missing.length > 0) {
      throw new Error(
        `the renderer did not output ${missing.length} line(s) the document contains; ` +
        `layout never removes content: ${JSON.stringify(missing[0]?.slice(0, 80))}`,
      );
    }

    // A line stated once appears once. A template that repeated a bullet
    // to fill a column would be adding employer-facing content nobody
    // approved, which is the same class of fault as deleting one.
    const occurrences = (needle: string) => {
      let n = 0, i = 0;
      while ((i = rendered.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
      return n;
    };
    for (const l of lines) {
      if (!l) continue;
      const stated = lines.filter((x) => normalize(x) === normalize(l)).length;
      const printed = occurrences(normalize(l));
      if (printed > stated) {
        throw new Error(
          `the renderer printed a line ${printed} times that the document states ${stated} time(s); ` +
          `layout never adds content: ${JSON.stringify(l.slice(0, 80))}`,
        );
      }
    }

    return { pdf, sha256: hashPdf(pdf), bytes: pdf.length, pages, rendererVersion, extractedText };
  } finally {
    await browser.close();
  }
}

export type { ResumeDoc, ResumeLine, ResumeRole };


/**
 * How many pages a rendered PDF actually has.
 *
 * The page tree records the total in /Count on the root Pages node. A
 * linearized or object-stream PDF can hide it, so a /Type /Page tally is
 * the fallback, and the caller's height estimate is the last resort. The
 * point is that the reported number describes the file rather than a
 * guess about it.
 */
export function countPdfPages(pdf: Buffer, pageHeightPx: number, bodyHeightPx?: number): number {
  const text = pdf.toString("latin1");
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  if (counts.length) return Math.max(1, Math.max(...counts));
  const typed = (text.match(/\/Type\s*\/Page(?![s/])/g) ?? []).length;
  if (typed > 0) return typed;
  return Math.max(1, Math.ceil((bodyHeightPx ?? pageHeightPx) / pageHeightPx));
}
