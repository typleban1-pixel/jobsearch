/**
 * C2 — Distinctive Professional, refined.
 *
 * Same identity as C: a chronological spine, strong continuity between
 * positions, a prominent name, single column, editorial restraint. What
 * changed is emphasis rather than character.
 *
 * The spine is quieter. In C it was a 0.7pt line with a tick at every
 * role and the dates set above the title in spaced small caps, which
 * made the timeline the first thing the eye found. Here the rule is
 * lighter, the ticks are smaller and paler, and the dates move to the
 * right of the title where the eye already goes. The spine organises
 * without announcing itself.
 *
 * Body copy is larger and looser: 11pt at 1.62 rather than 10.7 at
 * 1.55, with more space between bullets and considerably more between
 * positions. The 8pt floor is a last-resort invariant, not a target, so
 * nothing important is set near it.
 *
 * The optional one-line capability strip is DISABLED for production.
 * The mechanism stays because the idea is sound, but the current
 * selector is too literal: against a legal-operations posting it
 * produced "Cross-department collaboration • Google Analytics • Project
 * coordination • Subscription billing", which reads as keyword salad
 * rather than orientation, and it pushed the document onto a third page.
 * It returns only behind a substantially smarter coherent-theme
 * selector, validated the same way.
 */
import { esc, anchor, dateRange, renderHtmlToPdf, type ResumeDoc, type RenderedResume } from "../renderCore.ts";

export const RENDERER_VERSION = 104;
export const RENDERER_NAME = "C2 — Distinctive Professional, refined";
const MARGIN_MM = 17 + 16;

const CSS = `
  @page { size: Letter; margin: 17mm 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #12151a;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 11pt; line-height: 1.62;
  }

  .name { font-size: 35pt; font-weight: 700; letter-spacing: -0.034em; line-height: 0.98; margin: 0 0 8px; }
  .contact { font-size: 9.8pt; color: #545b67; margin: 0; }
  .contact a { color: #545b67; text-decoration: none; }
  .contact span + span::before { content: "   ·   "; color: #b9bfc8; }
  .masthead { border-bottom: 2pt solid #12151a; padding-bottom: 12px; margin-bottom: 14px; }

  /* Optional, job-specific, and one line. Never a matrix. */
  .capability {
    font-size: 9.6pt; font-weight: 600; letter-spacing: 0.06em;
    color: #3c434e; margin: 0 0 20px; padding-bottom: 14px;
    border-bottom: 0.5pt solid #e3e7eb;
  }

  section { margin-bottom: 26px; }
  h2 {
    font-size: 8.8pt; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase;
    margin: 0 0 14px; color: #7d848f;
  }
  .summary { margin: 0; font-size: 11.6pt; line-height: 1.6; color: #12151a; }

  /* The spine: lighter than C's, and set further from the text. */
  .track { border-left: 0.5pt solid #e0e4e9; padding-left: 22px; margin-left: 2px; }
  .role { position: relative; margin-bottom: 24px; break-inside: avoid; }
  .role:last-child { margin-bottom: 0; }
  .role::before {
    content: ""; position: absolute; left: -24.5px; top: 0.66em;
    width: 5px; height: 5px; border-radius: 50%; background: #c8ced6;
  }
  .role-head { display: flex; justify-content: space-between; align-items: baseline; gap: 14px; }
  .role-title { font-size: 13.4pt; font-weight: 700; letter-spacing: -0.02em; margin: 0; }
  .role-dates {
    font-size: 9.6pt; color: #7d848f; font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .role-org { font-size: 10.4pt; color: #545b67; margin: 2px 0 10px; font-weight: 500; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { padding-left: 16px; position: relative; margin-bottom: 8px; }
  li:last-child { margin-bottom: 0; }
  li::before {
    content: ""; position: absolute; left: 0; top: 0.68em;
    width: 7px; height: 0.6pt; background: #b9bfc8;
  }

  .skill-row { display: flex; gap: 14px; margin-bottom: 7px; align-items: baseline; }
  .skill-label {
    font-size: 8.8pt; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
    color: #7d848f; flex: 0 0 118px;
  }
  .skill-values { flex: 1; color: #2e343d; }
  .edu { margin-bottom: 6px; }
  .edu b { font-weight: 700; font-size: 11pt; }
  .edu span { color: #545b67; }
  .project { margin-bottom: 16px; break-inside: avoid; }
  .project-name { font-size: 11.6pt; font-weight: 700; margin: 0 0 4px; }
`;

export function renderHtml(doc: ResumeDoc, capabilities: string[] = []): string {
  const contact = [esc(doc.location), esc(doc.email), doc.phone ? esc(doc.phone) : null,
    ...doc.links.map(anchor)].filter(Boolean);
  return `<!doctype html><meta charset="utf-8"><title>${esc(doc.name)}</title><style>${CSS}</style>
<div class="masthead">
  <h1 class="name">${esc(doc.name)}</h1>
  <p class="contact">${contact.map((c) => `<span>${c}</span>`).join("")}</p>
</div>
${capabilities.length ? `<p class="capability">${capabilities.map(esc).join("  •  ")}</p>` : ""}

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
