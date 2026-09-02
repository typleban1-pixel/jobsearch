/**
 * C — Distinctive Professional.
 *
 * The premise: coherence through a strong editorial spine. The page has
 * an obvious left axis: a hairline runs down the experience section and
 * every role hangs off it, so a varied history reads as one continuous
 * track rather than a stack of unrelated jobs. Dates sit in a fixed
 * left gutter as small caps, which makes the chronology scannable
 * without the eye leaving that axis.
 *
 * The name is set large and tight in a grotesque with a rule beneath it,
 * and section headings carry a small filled marker. That is the whole
 * decorative budget; everything else is spacing and weight.
 *
 * The gutter is presentation only. Every date is also inside the role's
 * own text flow, so extraction never depends on the layout.
 *
 * Strongest at being remembered and at making a long chronology feel
 * deliberate. Weakest under an ATS that flattens positioned text, which
 * is why nothing is positioned that is not also in normal flow.
 */
import { esc, anchor, dateRange, renderHtmlToPdf, type ResumeDoc, type RenderedResume } from "../renderCore.ts";

export const RENDERER_VERSION = 103;
export const RENDERER_NAME = "C — Distinctive Professional";
const MARGIN_MM = 16 + 15;

const CSS = `
  @page { size: Letter; margin: 16mm 17mm 15mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #101317;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 10.7pt; line-height: 1.55;
  }

  .name {
    font-size: 38pt; font-weight: 700; letter-spacing: -0.038em;
    line-height: 0.96; margin: 0 0 9px; text-transform: none;
  }
  .contact { font-size: 9.5pt; color: #565d69; margin: 0 0 12px; }
  .contact a { color: #565d69; text-decoration: none; }
  .contact span + span::before { content: "  /  "; color: #b4bac3; }
  .masthead { border-bottom: 3pt solid #101317; padding-bottom: 12px; margin-bottom: 20px; }

  section { margin-bottom: 21px; }
  h2 {
    font-size: 8.6pt; font-weight: 700; letter-spacing: 0.19em; text-transform: uppercase;
    margin: 0 0 12px; color: #101317;
  }
  h2::before {
    content: ""; display: inline-block; width: 5px; height: 5px;
    background: #101317; margin-right: 8px; vertical-align: 0.12em;
  }
  .summary { margin: 0; font-size: 11.5pt; line-height: 1.56; font-weight: 400; }

  /* The spine. A hairline the whole experience section hangs off. */
  .track { border-left: 0.7pt solid #d8dce2; padding-left: 18px; margin-left: 3px; }
  .role { position: relative; margin-bottom: 18px; break-inside: avoid; }
  .role:last-child { margin-bottom: 0; }
  .role::before {
    content: ""; position: absolute; left: -21.5px; top: 0.58em;
    width: 7px; height: 0.7pt; background: #9aa2ad;
  }
  .role-dates {
    font-size: 8.4pt; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
    color: #7b828d; font-variant-numeric: tabular-nums; margin: 0 0 2px;
  }
  .role-title { font-size: 13.2pt; font-weight: 700; letter-spacing: -0.018em; margin: 0 0 1px; }
  .role-org { font-size: 10pt; color: #565d69; margin: 0 0 8px; font-weight: 500; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { padding-left: 14px; position: relative; margin-bottom: 5px; }
  li:last-child { margin-bottom: 0; }
  li::before { content: "›"; position: absolute; left: 0; color: #9aa2ad; font-weight: 700; }

  .skill-row { display: flex; gap: 12px; margin-bottom: 5px; align-items: baseline; }
  .skill-label {
    font-size: 8.3pt; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
    color: #7b828d; flex: 0 0 112px;
  }
  .skill-values { flex: 1; color: #2f353e; }
  .edu { margin-bottom: 4px; }
  .edu b { font-weight: 700; font-size: 10.5pt; }
  .edu span { color: #565d69; }
  .project { margin-bottom: 12px; break-inside: avoid; }
  .project-name { font-size: 11.2pt; font-weight: 700; margin: 0 0 3px; }
`;

export function renderHtml(doc: ResumeDoc): string {
  const contact = [esc(doc.location), esc(doc.email), doc.phone ? esc(doc.phone) : null,
    ...doc.links.map(anchor)].filter(Boolean);
  return `<!doctype html><meta charset="utf-8"><title>${esc(doc.name)}</title><style>${CSS}</style>
<div class="masthead">
  <h1 class="name">${esc(doc.name)}</h1>
  <p class="contact">${contact.map((c) => `<span>${c}</span>`).join("")}</p>
</div>

<section><h2>Summary</h2><p class="summary">${esc(doc.summary.text)}</p></section>

<section><h2>Experience</h2><div class="track">
${doc.roles.map((r) => `<div class="role">
  <p class="role-dates">${esc(dateRange(r))}</p>
  <p class="role-title">${esc(r.title)}</p>
  <p class="role-org">${esc(r.employer)}${r.location ? ` · ${esc(r.location)}` : ""}</p>
  ${r.lines.length ? `<ul>${r.lines.map((l) => `<li>${esc(l.text)}</li>`).join("")}</ul>` : ""}
</div>`).join("")}
</div></section>

${doc.projects.length ? `<section><h2>Selected Work</h2>
${doc.projects.map((p) => `<div class="project"><p class="project-name">${esc(p.name)}</p><p>${esc(p.line.text)}</p></div>`).join("")}
</section>` : ""}

<section><h2>Capabilities</h2>
${doc.skillGroups.map((g) => `<div class="skill-row">
  <div class="skill-label">${esc(g.label)}</div><div class="skill-values">${esc(g.skills.join(", "))}</div>
</div>`).join("")}
</section>

<section><h2>Education</h2>
${doc.education.map((e) => `<p class="edu"><b>${esc(e.credential)}${e.field ? `, ${esc(e.field)}` : ""}</b> <span>· ${esc(e.institution)}</span></p>`).join("")}
</section>`;
}

export async function render(doc: ResumeDoc): Promise<RenderedResume> {
  return renderHtmlToPdf(renderHtml(doc), doc, RENDERER_VERSION, 11 * 96 - (MARGIN_MM / 25.4) * 96);
}
