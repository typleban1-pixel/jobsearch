/**
 * Compaction: resolve a TRIVIAL page overflow by trimming the weakest
 * evidence, never by shrinking the type.
 *
 * A resume that spills 37px onto a second sheet is a layout failure, not
 * a content decision (Part 20). The compaction order the project sets is:
 * remove slack, then trim the lowest-relevance line; typography is a last
 * resort this module does not touch. Here we do the content step, and
 * only when the trailing page is nearly empty -- a second page carrying
 * real evidence is left alone.
 *
 * It measures the RENDERED artifact (Part W): the caller supplies a probe
 * that renders a doc and returns its true page count and content height.
 * Every trim is returned so the provenance trail records what was cut and
 * why, exactly like any other dropped line.
 */
import type { ResumeDoc, ResumeRole, ResumeProject } from "./resume.ts";
import { PAGE_PX, MIN_LAST_PAGE_FILL } from "./layoutAudit.ts";

export const COMPACT_VERSION = 1;

export interface CompactTrim { line: string; from: string; why: string }
export interface CompactResult {
  doc: ResumeDoc;
  /** Render the artifact with the tightened spacing stylesheet. */
  compact: boolean;
  trims: CompactTrim[];
  pages: number;
  contentPx: number;
  lastPageFill: number;
}

const fillOf = (pages: number, contentPx: number) =>
  pages <= 1 ? 1 : Math.max(0, (contentPx - (pages - 1) * PAGE_PX) / PAGE_PX);

/**
 * Remove one weakest bullet: the LAST line (bullets are relevance-ordered
 * strongest-first) of whichever role or project currently carries the
 * most bullets and can therefore best spare one. Never empties a project
 * of its identity, and never touches the summary, education, or a role's
 * chronology row. Returns null when nothing can be trimmed safely.
 */
function trimWeakest(doc: ResumeDoc): { doc: ResumeDoc; trim: CompactTrim } | null {
  type Cand = { kind: "role"; idx: number; count: number } | { kind: "project"; idx: number; count: number };
  const cands: Cand[] = [];
  (doc.roles ?? []).forEach((r, idx) => { if ((r.lines?.length ?? 0) >= 2) cands.push({ kind: "role", idx, count: r.lines.length }); });
  (doc.projects ?? []).forEach((p, idx) => { if ((p.optional?.length ?? 0) >= 1) cands.push({ kind: "project", idx, count: p.optional.length }); });
  if (!cands.length) {
    // Last resort within content: a role with exactly one bullet may drop
    // it (the role stays as a chronology row), but only if some role has
    // more than one so we thin the densest first -- already handled above.
    (doc.roles ?? []).forEach((r, idx) => { if ((r.lines?.length ?? 0) === 1) cands.push({ kind: "role", idx, count: 1 }); });
  }
  if (!cands.length) return null;
  // Densest first; stable, so an exact tie trims the earlier entry.
  cands.sort((a, b) => b.count - a.count);
  const c = cands[0]!;
  if (c.kind === "role") {
    const roles = doc.roles.map((r) => ({ ...r, lines: [...r.lines] }));
    const removed = roles[c.idx]!.lines.pop()!;
    return { doc: { ...doc, roles },
      trim: { line: removed.text, from: `${roles[c.idx]!.employer}`, why: "trimmed to remove a trivial page overflow (weakest bullet of the densest entry)" } };
  }
  const projects = doc.projects.map((p) => ({ ...p, optional: [...p.optional] }));
  const removed = projects[c.idx]!.optional.pop()!;
  return { doc: { ...doc, projects },
    trim: { line: removed.text, from: projects[c.idx]!.name, why: "trimmed to remove a trivial page overflow (weakest project claim)" } };
}

export async function compactToFit(
  doc: ResumeDoc,
  /** Renders a doc, optionally with tightened spacing, and reports the
   *  true page count and content height. */
  probe: (d: ResumeDoc, compact: boolean) => Promise<{ pages: number; contentPx: number }>,
  maxTrims = 3,
): Promise<CompactResult> {
  const start = await probe(doc, false);
  const noop: CompactResult = {
    doc, compact: false, trims: [], pages: start.pages, contentPx: start.contentPx,
    lastPageFill: fillOf(start.pages, start.contentPx),
  };
  // Only a TRIVIAL trailing overflow is compacted. A page that carries
  // real evidence is left to stand.
  if (start.pages <= 1 || fillOf(start.pages, start.contentPx) >= MIN_LAST_PAGE_FILL) return noop;

  // Step 1 (Part 20 order): tighten spacing before touching content. If
  // the modest stylesheet alone removes the overflow page, no evidence is
  // sacrificed at all.
  const c = await probe(doc, true);
  if (c.pages < start.pages) {
    return { doc, compact: true, trims: [], pages: c.pages, contentPx: c.contentPx, lastPageFill: fillOf(c.pages, c.contentPx) };
  }

  // Step 2: tightened spacing PLUS trimming the weakest evidence, one line
  // at a time, until the overflow page is gone. Reverted whole if it never
  // collapses a page within the budget -- no line is lost for no payoff.
  let cur = doc;
  const trims: CompactTrim[] = [];
  for (let i = 0; i < maxTrims; i++) {
    const t = trimWeakest(cur);
    if (!t) break;
    cur = t.doc; trims.push(t.trim);
    const r = await probe(cur, true);
    if (r.pages < start.pages) {
      return { doc: cur, compact: true, trims, pages: r.pages, contentPx: r.contentPx, lastPageFill: fillOf(r.pages, r.contentPx) };
    }
  }
  return noop;
}
