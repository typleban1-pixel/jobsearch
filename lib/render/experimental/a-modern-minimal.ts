/**
 * A — Modern Minimal Generalist.
 *
 * The premise: coherence through calm. A career that spans product,
 * operations, marketing and creative work reads as scattered when the
 * page is busy, so this removes almost everything structural and lets
 * whitespace and a single strong typographic axis do the organising.
 *
 * One sans family throughout, one hairline rule in the whole document,
 * no boxes, no markers, no second colour. Section headings are small and
 * quiet; the eye is meant to travel down role titles, which are the only
 * other large thing on the page besides the name.
 *
 * Strongest where the reader is senior and skimming. Weakest when there
 * is a lot to say: with many bullets the calm becomes flat, because
 * nothing is competing to be noticed.
 */
import { esc, anchor, dateRange, renderHtmlToPdf, type ResumeDoc, type RenderedResume } from "../renderCore.ts";

export const RENDERER_VERSION = 101;
export const RENDERER_NAME = "A — Modern Minimal Generalist";
const MARGIN_MM = 18 + 16;

const CSS = `
  @page { size: Letter; margin: 18mm 19mm 16mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #191c21;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 10.8pt; line-height: 1.62; font-weight: 400;
  }
  .name { font-size: 34pt; font-weight: 300; letter-spacing: -0.03em; line-height: 1; margin: 0 0 10px; }
  .contact { font-size: 9.6pt; color: #5b6270; letter-spacing: 0.01em; margin: 0 0 4px; }
  .contact a { color: #5b6270; text-decoration: none; }
  .contact span + span::before { content: "   "; white-space: pre; }
  .rule { border: 0; border-top: 0.5pt solid #c9ced6; margin: 18px 0 22px; }

  section { margin-bottom: 24px; }
  h2 {
    font-size: 8.4pt; font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase;
    color: #9aa1ad; margin: 0 0 12px;
  }
  .summary { font-size: 11.4pt; line-height: 1.58; font-weight: 300; margin: 0; color: #191c21; }

  .role { margin-bottom: 20px; break-inside: avoid; }
  .role:last-child { margin-bottom: 0; }
  .role-title { font-size: 13pt; font-weight: 500; letter-spacing: -0.012em; margin: 0 0 2px; }
  .role-meta { font-size: 9.6pt; color: #6d747f; margin: 0 0 9px; font-weight: 400; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { padding-left: 15px; position: relative; margin-bottom: 7px; }
  li:last-child { margin-bottom: 0; }
  li::before { content: "—"; position: absolute; left: 0; color: #b6bcc6; }

  .skills { font-size: 10.4pt; color: #3d434d; }
  .skills div { margin-bottom: 5px; }
  .skills b { font-weight: 500; color: #191c21; }
  .edu { margin-bottom: 4px; font-size: 10.6pt; }
  .edu span { color: #6d747f; }
  .project { margin-bottom: 13px; break-inside: avoid; }
  .project-name { font-size: 11.4pt; font-weight: 500; margin: 0 0 3px; }
`;

export function renderHtml(doc: ResumeDoc): string {
  const contact = [esc(doc.location), esc(doc.email), doc.phone ? esc(doc.phone) : null,
    ...doc.links.map(anchor)].filter(Boolean);
  return `<!doctype html><meta charset="utf-8"><title>${esc(doc.name)}</title><style>${CSS}</style>
<h1 class="name">${esc(doc.name)}</h1>
<p class="contact">${contact.map((c) => `<span>${c}</span>`).join("")}</p>
<hr class="rule">

<section><h2>Summary</h2><p class="summary">${esc(doc.summary.text)}</p></section>

<section><h2>Experience</h2>
${doc.roles.map((r) => `<div class="role">
  <p class="role-title">${esc(r.title)}</p>
  <p class="role-meta">${esc(r.employer)}${r.location ? `, ${esc(r.location)}` : ""} &nbsp;&nbsp;·&nbsp;&nbsp; ${esc(dateRange(r))}</p>
  <ul>${r.lines.map((l) => `<li>${esc(l.text)}</li>`).join("")}</ul>
</div>`).join("")}</section>

${doc.projects.length ? `<section><h2>Selected Work</h2>
${doc.projects.map((p) => `<div class="project"><p class="project-name">${esc(p.name)}</p><p>${esc(p.line.text)}</p></div>`).join("")}
</section>` : ""}

<section><h2>Skills</h2><div class="skills">
${doc.skillGroups.map((g) => `<div><b>${esc(g.label)}</b> &nbsp; ${esc(g.skills.join(", "))}</div>`).join("")}
</div></section>

<section><h2>Education</h2>
${doc.education.map((e) => `<p class="edu">${esc(e.credential)}${e.field ? `, ${esc(e.field)}` : ""} <span>· ${esc(e.institution)}</span></p>`).join("")}
</section>`;
}

export async function render(doc: ResumeDoc): Promise<RenderedResume> {
  return renderHtmlToPdf(renderHtml(doc), doc, RENDERER_VERSION, 11 * 96 - (MARGIN_MM / 25.4) * 96);
}
