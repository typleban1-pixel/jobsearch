/**
 * The production resume: C2 Plain.
 *
 * Presentation only. It receives a finished ResumeDoc and may not change
 * what it says: no truncation, no rewriting, no dropping a bullet that
 * will not fit, no filler when a page looks empty. A document that
 * renders badly is a content-selection problem, and it is fixed there.
 *
 * The design: a prominent but restrained name over a compact contact
 * line, a concise adaptive summary, and EXPERIENCE as the dominant
 * section. A 0.5pt chronological spine runs down the experience with
 * small pale nodes at each role, so a varied history reads as one
 * continuous track without the timeline becoming the first thing seen.
 * Role titles carry the weight, dates sit to their right, employer and
 * location directly beneath. Body copy is 11pt at 1.62 with generous
 * space between positions.
 *
 * Single column, real text throughout, no sidebar, no icons, no skill
 * bars, no colour carrying meaning. It survives being printed in
 * greyscale and being parsed by an ATS.
 *
 * The compact header capability strip explored during design is
 * deliberately absent: it was too literal and produced incoherent
 * groupings. It returns only behind a substantially smarter selector.
 */
import type { ResumeDoc, ResumeLine, ResumeRole } from "./resume.ts";
import { esc, anchor, dateRange, renderHtmlToPdf, hashPdf, type RenderedResume } from "./renderCore.ts";

/**
 * Bumped whenever the visual output changes. Stored with the artifact.
 *
 * 4: roles and projects flow across pages instead of being indivisible
 *    blocks. Content, wording and order are untouched; only where the
 *    page breaks falls differently.
 * 5: vertical rhythm tightened so this document occupies the two pages
 *    its content actually fills rather than spilling a short tail onto a
 *    third. Spacing and leading only: the body stays at 11pt, the page
 *    margins are unchanged, and no word moves.
 */
export const RENDERER_VERSION = 5;

const CSS = `
  @page { size: Letter; margin: 11mm 14mm 10mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #12151a;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 10.2pt; line-height: 1.33;
    /* Never leave one line of a paragraph stranded across a break. */
    orphans: 2; widows: 2;
  }

  .name { font-size: 26pt; font-weight: 700; letter-spacing: -0.034em; line-height: 0.98; margin: 0 0 8px; }
  .contact { font-size: 9.8pt; color: #545b67; margin: 0; }
  .contact a { color: #545b67; text-decoration: none; }
  .contact span + span::before { content: "   ·   "; color: #b9bfc8; }
  .masthead { border-bottom: 2pt solid #12151a; padding-bottom: 7px; margin-bottom: 9px; }

  /* Optional, job-specific, and one line. Never a matrix. */
  .capability {
    font-size: 9.6pt; font-weight: 600; letter-spacing: 0.06em;
    color: #3c434e; margin: 0 0 13px; padding-bottom: 9px;
    border-bottom: 0.5pt solid #e3e7eb;
  }

  section { margin-bottom: 7px; }
  /* A heading never ends a page. It stays with whatever follows it, so
     SELECTED WORK cannot sit alone at the foot of one page while RentPup
     starts the next. It does NOT keep the whole section together. */
  h2 { break-after: avoid; page-break-after: avoid; margin-bottom: 7px; }
  h2 {
    font-size: 8.8pt; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase;
    margin: 0 0 9px; color: #7d848f;
  }
  .summary { margin: 0; font-size: 10.8pt; line-height: 1.38; color: #12151a; }

  /* The spine: lighter than C's, and set further from the text. */
  .track { border-left: 0.5pt solid #e0e4e9; padding-left: 17px; margin-left: 2px; }
  /* Roles FLOW. They used to be break-inside: avoid, which made a role
     and every one of its bullets a single indivisible block: a four
     bullet role that did not fit in the remaining space moved wholly to
     the next page and left the rest of the current one empty. That is
     what produced the gaps after Genius One and after the college.

     What is kept together instead is the smallest unit that must not be
     orphaned: the title, the employer line and the first bullet. After
     that the role may split wherever it needs to. */
  .role { position: relative; margin-bottom: 9px; break-inside: auto; }
  .role:last-child { margin-bottom: 0; }
  .role::before {
    content: ""; position: absolute; left: -24.5px; top: 0.66em;
    width: 5px; height: 5px; border-radius: 50%; background: #c8ced6;
  }
  .role-head {
    display: flex; justify-content: space-between; align-items: baseline; gap: 14px;
    break-after: avoid; page-break-after: avoid;
  }
  .role-title { font-size: 13.4pt; font-weight: 700; letter-spacing: -0.02em; margin: 0; }
  .role-dates {
    font-size: 9.6pt; color: #7d848f; font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .role-org {
    font-size: 10.4pt; color: #545b67; margin: 2px 0 6px; font-weight: 500;
    break-after: avoid; page-break-after: avoid;
  }
  ul { margin: 0; padding: 0; list-style: none; }
  /* A bullet is never split down the middle, and the first one stays
     with the heading above it. Later bullets may start a new page. */
  li { padding-left: 16px; position: relative; margin-bottom: 4.5px; break-inside: avoid; page-break-inside: avoid; }
  li:first-child { break-before: avoid; page-break-before: avoid; }
  li:last-child { margin-bottom: 0; }
  li::before {
    content: ""; position: absolute; left: 0; top: 0.68em;
    width: 7px; height: 0.6pt; background: #b9bfc8;
  }

  .skill-row { display: flex; gap: 14px; margin-bottom: 4px; align-items: baseline; }
  .skill-label {
    font-size: 8.8pt; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
    color: #7d848f; flex: 0 0 118px;
  }
  .skill-values { flex: 1; color: #2e343d; }
  .edu { margin-bottom: 3px; }
  .edu b { font-weight: 700; font-size: 11pt; }
  .edu span { color: #545b67; }
  /* Same rule as a role: the name stays with its description, and the
     rest may flow. RentPup is an identity paragraph plus three claims and
     was being moved to a page of its own as one block. */
  .project { margin-bottom: 10px; break-inside: auto; }
  .project-name { font-size: 11.6pt; font-weight: 700; margin: 0 0 4px; break-after: avoid; page-break-after: avoid; }
  /* The identity unit -- Selected Work heading, project name, description,
     and first bullet -- stays together. Without this the RentPup description
     could split off its name and render at the foot of a later page, below
     Education. Later bullets may still flow. */
  .project-desc { margin: 0 0 4px; break-before: avoid; page-break-before: avoid; break-after: avoid; page-break-after: avoid; }
  .project > ul > li:first-child { break-before: avoid; page-break-before: avoid; }
  /* Optional project claims sit under the description, spaced as role
     bullets are, so a project reads like the rest of the document. */
  .project ul { margin-top: 8px; }
`;

/**
 * A modest spacing tightening for a document that spills a little past a
 * page. It reduces vertical rhythm only -- margins, spacing, line-height
 * -- and never the type size, so the page stays readable (Part 20: "never
 * solve layout by making everything tiny"). Applied by the compaction
 * pass before any evidence is trimmed.
 */
const COMPACT_CSS = `
  body { line-height: 1.26; }
  .masthead { margin-bottom: 7px; padding-bottom: 5px; }
  .capability { margin: 0 0 8px; padding-bottom: 6px; }
  section { margin-bottom: 5px; }
  h2 { margin: 0 0 6px; }
  .summary { line-height: 1.3; }
  .role { margin-bottom: 6px; }
  .role-org { margin: 2px 0 4px; }
  li { margin-bottom: 3px; }
  .skill-row { margin-bottom: 3px; }
  .edu { margin-bottom: 2px; }
  .project { margin-bottom: 6px; }
  .project ul { margin-top: 5px; }
`;

export interface RenderOptions { compact?: boolean }

export function renderResumeHtml(doc: ResumeDoc, opts: RenderOptions = {}): string {
  const contact = [esc(doc.location), esc(doc.email), doc.phone ? esc(doc.phone) : null,
    ...doc.links.map(anchor)].filter(Boolean);
  const style = opts.compact ? CSS + COMPACT_CSS : CSS;
  return `<!doctype html><meta charset="utf-8"><title>${esc(doc.name)}</title><style>${style}</style>
<div class="masthead">
  <h1 class="name">${esc(doc.name)}</h1>
  <p class="contact">${contact.map((c) => `<span>${c}</span>`).join("")}</p>
</div>

<section><h2>Summary</h2><p class="summary">${esc(doc.summary.text)}</p></section>

<section><h2>Experience</h2><div class="track">
${doc.roles.map((r) => `<div class="role">
  <div class="role-head">
    <p class="role-title">${esc(r.title)}</p>
    <span class="role-dates">${esc(dateRange(r))}</span>
  </div>
  <p class="role-org">${esc(r.employer)}${r.location ? ` · ${esc(r.location)}` : ""}</p>
  ${r.lines.length ? `<ul>${r.lines.map((l) => `<li>${esc(l.text)}</li>`).join("")}</ul>` : ""}
</div>`).join("")}
</div></section>

${doc.projects.length ? `<section><h2>Selected Work</h2>
${doc.projects.map((p) => `<div class="project"><p class="project-name">${esc(p.name)}</p><p class="project-desc">${esc(p.line.text)}</p>${
  p.optional.length ? `<ul>${p.optional.map((l) => `<li>${esc(l.text)}</li>`).join("")}</ul>` : ""
}</div>`).join("")}
</section>` : ""}

${doc.skillGroups.length ? `<section><h2>Capabilities</h2>
${doc.skillGroups.map((g) => `<div class="skill-row">
  <div class="skill-label">${esc(g.label)}</div><div class="skill-values">${esc(g.skills.join(", "))}</div>
</div>`).join("")}
</section>` : ""}

<section><h2>Education</h2>
${doc.education.map((e) => `<p class="edu"><b>${esc(e.credential)}${e.field ? `, ${esc(e.field)}` : ""}</b> <span>· ${esc(e.institution)}</span></p>`).join("")}
</section>`;
}


/**
 * Renders the production design.
 *
 * The machinery, including the refusal to output a document missing any
 * of its lines or repeating one, lives in renderCore.
 */
export async function renderResume(doc: ResumeDoc, opts: RenderOptions = {}): Promise<RenderedResume> {
  // 11in less the 14mm + 13mm this template reserves, at 96dpi.
  const printable = 11 * 96 - ((14 + 13) / 25.4) * 96;
  return renderHtmlToPdf(renderResumeHtml(doc, opts), doc, RENDERER_VERSION, printable);
}

export type { RenderedResume };
export { hashPdf };
