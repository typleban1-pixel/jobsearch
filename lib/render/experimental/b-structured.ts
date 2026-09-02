/**
 * B — Structured Cross-Functional.
 *
 * The premise: coherence through explicit structure. Where A hopes the
 * reader assembles the pattern, this labels it. A capabilities band sits
 * directly under the header so the breadth is stated before the
 * chronology explains it, and every role carries a compact meta line in
 * a fixed grammar so titles, employers, places and dates always land in
 * the same visual positions.
 *
 * Serif body against a sans structural layer: the two jobs of the page
 * are visibly different things. Rules are used deliberately and only at
 * section boundaries.
 *
 * Strongest when there is a lot of relevant material and the reader
 * needs to navigate it. Weakest on a thin document, where the structure
 * can look heavier than what it holds.
 */
import { esc, anchor, dateRange, renderHtmlToPdf, type ResumeDoc, type RenderedResume } from "../renderCore.ts";

export const RENDERER_VERSION = 102;
export const RENDERER_NAME = "B — Structured Cross-Functional";
const MARGIN_MM = 15 + 14;

const CSS = `
  @page { size: Letter; margin: 15mm 16mm 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #15181d;
    font-family: "Charter", "Iowan Old Style", Georgia, serif;
    font-size: 10.7pt; line-height: 1.52;
  }
  .sans { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }

  header { border-bottom: 2pt solid #15181d; padding-bottom: 11px; margin-bottom: 0; }
  .name {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 27pt; font-weight: 700; letter-spacing: -0.02em; line-height: 1.04; margin: 0 0 6px;
  }
  .contact {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 9.3pt; color: #4a515c;
  }
  .contact a { color: #4a515c; text-decoration: none; }
  .contact span + span::before { content: " · "; color: #a9b0ba; }

  /* The breadth, stated before the chronology explains it. */
  .capabilities { border-bottom: 0.6pt solid #d5dae1; padding: 10px 0 11px; margin-bottom: 16px; }
  .cap-row { display: flex; gap: 12px; margin-bottom: 5px; align-items: baseline; }
  .cap-row:last-child { margin-bottom: 0; }
  .cap-label {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 8.2pt; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
    color: #6f7681; flex: 0 0 118px;
  }
  .cap-values { flex: 1; font-size: 10.2pt; color: #2b313a; }

  section { margin-bottom: 17px; }
  h2 {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 8.6pt; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase;
    color: #15181d; margin: 0 0 10px; padding-bottom: 4px; border-bottom: 0.6pt solid #d5dae1;
  }
  .summary { margin: 0; font-size: 11pt; line-height: 1.55; }

  .role { margin-bottom: 14px; break-inside: avoid; }
  .role:last-child { margin-bottom: 0; }
  .role-title {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 11.4pt; font-weight: 700; margin: 0;
  }
  .role-meta {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 9.2pt; margin: 2px 0 7px; color: #5b6270;
  }
  .role-meta .dates { font-variant-numeric: tabular-nums; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { padding-left: 14px; position: relative; margin-bottom: 4.5px; }
  li:last-child { margin-bottom: 0; }
  /* A drawn square rather than a 6pt glyph: nothing on the page depends
     on type set below the readability floor. */
  li::before {
    content: ""; position: absolute; left: 2px; top: 0.62em;
    width: 3.2px; height: 3.2px; background: #8b929d;
  }

  .edu { margin-bottom: 4px; }
  .edu b { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-weight: 700; font-size: 10.3pt; }
  .edu span { color: #5b6270; }
  .project { margin-bottom: 11px; break-inside: avoid; }
  .project-name {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 10.8pt; font-weight: 700; margin: 0 0 2px;
  }
`;

export function renderHtml(doc: ResumeDoc): string {
  const contact = [esc(doc.location), esc(doc.email), doc.phone ? esc(doc.phone) : null,
    ...doc.links.map(anchor)].filter(Boolean);
  return `<!doctype html><meta charset="utf-8"><title>${esc(doc.name)}</title><style>${CSS}</style>
<header>
  <h1 class="name">${esc(doc.name)}</h1>
  <p class="contact">${contact.map((c) => `<span>${c}</span>`).join("")}</p>
</header>

<div class="capabilities">
${doc.skillGroups.map((g) => `<div class="cap-row">
  <div class="cap-label">${esc(g.label)}</div><div class="cap-values">${esc(g.skills.join(" · "))}</div>
</div>`).join("")}
</div>

<section><h2>Profile</h2><p class="summary">${esc(doc.summary.text)}</p></section>

<section><h2>Experience</h2>
${doc.roles.map((r) => `<div class="role">
  <p class="role-title">${esc(r.title)}</p>
  <p class="role-meta">${esc(r.employer)}${r.location ? ` &nbsp;·&nbsp; ${esc(r.location)}` : ""} &nbsp;·&nbsp; <span class="dates">${esc(dateRange(r))}</span></p>
  <ul>${r.lines.map((l) => `<li>${esc(l.text)}</li>`).join("")}</ul>
</div>`).join("")}</section>

${doc.projects.length ? `<section><h2>Selected Work</h2>
${doc.projects.map((p) => `<div class="project"><p class="project-name">${esc(p.name)}</p><p>${esc(p.line.text)}</p></div>`).join("")}
</section>` : ""}

<section><h2>Education</h2>
${doc.education.map((e) => `<p class="edu"><b>${esc(e.credential)}${e.field ? `, ${esc(e.field)}` : ""}</b> <span>· ${esc(e.institution)}</span></p>`).join("")}
</section>`;
}

export async function render(doc: ResumeDoc): Promise<RenderedResume> {
  return renderHtmlToPdf(renderHtml(doc), doc, RENDERER_VERSION, 11 * 96 - (MARGIN_MM / 25.4) * 96);
}
