/**
 * A/C Hybrid — C's architecture, A's restraint.
 *
 * Descends from C, not from A: the chronological spine is still here and
 * still the organising idea, and the information architecture is C's.
 * What it borrows from A is temperament.
 *
 * Where C2 keeps a heavy masthead rule, a 700-weight name and bold role
 * titles, this lightens all three. The name is set at 300 weight so its
 * size does the work instead of its blackness; the masthead rule is a
 * hairline; role titles are medium rather than bold. Section headings
 * are quieter still. The spine is the palest element that remains
 * visible at all, so career continuity registers without ever competing
 * with the words.
 *
 * The question it exists to answer: whether C's coherence survives when
 * almost all of the emphasis is removed, or whether the design depends
 * on that emphasis to work.
 */
import { esc, anchor, dateRange, renderHtmlToPdf, type ResumeDoc, type RenderedResume } from "../renderCore.ts";

export const RENDERER_VERSION = 105;
export const RENDERER_NAME = "A/C Hybrid — restrained challenger";
const MARGIN_MM = 19 + 17;

const CSS = `
  @page { size: Letter; margin: 19mm 20mm 17mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #1a1e24;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 10.9pt; line-height: 1.68; font-weight: 400;
  }

  .name { font-size: 33pt; font-weight: 300; letter-spacing: -0.028em; line-height: 1; margin: 0 0 9px; }
  .contact { font-size: 9.7pt; color: #626976; margin: 0; }
  .contact a { color: #626976; text-decoration: none; }
  .contact span + span::before { content: "   ·   "; color: #c3c9d1; }
  .masthead { border-bottom: 0.5pt solid #d6dbe1; padding-bottom: 14px; margin-bottom: 16px; }

  .capability {
    font-size: 9.5pt; font-weight: 500; letter-spacing: 0.05em;
    color: #626976; margin: 0 0 24px;
  }

  section { margin-bottom: 28px; }
  h2 {
    font-size: 8.6pt; font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase;
    margin: 0 0 15px; color: #9aa1ac;
  }
  .summary { margin: 0; font-size: 11.5pt; line-height: 1.62; font-weight: 300; color: #1a1e24; }

  /* The palest thing that still reads as a line. */
  .track { border-left: 0.4pt solid #e8ebef; padding-left: 24px; margin-left: 2px; }
  .role { position: relative; margin-bottom: 26px; break-inside: avoid; }
  .role:last-child { margin-bottom: 0; }
  .role::before {
    content: ""; position: absolute; left: -26.2px; top: 0.72em;
    width: 4px; height: 4px; border-radius: 50%; background: #dfe3e8;
  }
  .role-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
  .role-title { font-size: 13pt; font-weight: 500; letter-spacing: -0.014em; margin: 0; }
  .role-dates { font-size: 9.6pt; color: #8b929d; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .role-org { font-size: 10.3pt; color: #626976; margin: 2px 0 11px; font-weight: 400; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { padding-left: 17px; position: relative; margin-bottom: 9px; }
  li:last-child { margin-bottom: 0; }
  li::before { content: "—"; position: absolute; left: 0; color: #c3c9d1; }

  .skill-row { display: flex; gap: 14px; margin-bottom: 7px; align-items: baseline; }
  .skill-label {
    font-size: 8.6pt; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase;
    color: #9aa1ac; flex: 0 0 118px;
  }
  .skill-values { flex: 1; color: #3a414b; }
  .edu { margin-bottom: 6px; }
  .edu b { font-weight: 500; font-size: 10.9pt; }
  .edu span { color: #626976; }
  .project { margin-bottom: 17px; break-inside: avoid; }
  .project-name { font-size: 11.4pt; font-weight: 500; margin: 0 0 4px; }
`;

export function renderHtml(doc: ResumeDoc, capabilities: string[] = []): string {
  const contact = [esc(doc.location), esc(doc.email), doc.phone ? esc(doc.phone) : null,
    ...doc.links.map(anchor)].filter(Boolean);
  return `<!doctype html><meta charset="utf-8"><title>${esc(doc.name)}</title><style>${CSS}</style>
<div class="masthead">
  <h1 class="name">${esc(doc.name)}</h1>
  <p class="contact">${contact.map((c) => `<span>${c}</span>`).join("")}</p>
</div>
${capabilities.length ? `<p class="capability">${capabilities.map(esc).join("   ·   ")}</p>` : ""}

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
${doc.projects.map((p) => `<div class="project"><p class="project-name">${esc(p.name)}</p><p>${esc(p.line.text)}</p></div>`).join("")}
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

export async function render(doc: ResumeDoc, capabilities: string[] = []): Promise<RenderedResume> {
  return renderHtmlToPdf(renderHtml(doc, capabilities), doc, RENDERER_VERSION, 11 * 96 - (MARGIN_MM / 25.4) * 96);
}
