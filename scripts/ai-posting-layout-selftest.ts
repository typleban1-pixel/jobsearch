/**
 * A posting about AI leads with the independent product.
 *
 *   node scripts/ai-posting-layout-selftest.ts
 *
 * isAiPosting decides from the posting's own terms; a doc marked
 * projectsFirst prints Selected Work before Experience in both renderers.
 */
import { isAiPosting } from "../lib/render/tailoredDoc.ts";
import { renderMarkdown, type ResumeDoc } from "../lib/render/resume.ts";
import { renderResumeHtml as resumeHtml } from "../lib/render/resumePdf.ts";
let bad = 0;
const ok = (c: boolean, label: string, extra?: unknown) => { if (!c) { bad++; console.log(`  FAIL  ${label}`, extra ?? ""); } else console.log(`  PASS  ${label}`); };

ok(isAiPosting(["integrate AI tools into operations workflows", "project coordination"]), "'AI tools' marks an AI posting");
ok(isAiPosting(["experience with machine learning products"]), "'machine learning' marks an AI posting");
ok(isAiPosting(["AI-assisted development"]), "'AI-assisted' marks an AI posting");
ok(!isAiPosting(["email marketing", "aim to grow revenue", "maintain CRM hygiene"]), "'aim' and 'maintain' do not");
ok(!isAiPosting(["Business Development Operations"]), "a title alone does not");

const doc: ResumeDoc = {
  name: "Ty Pleban", email: "x@example.com", phone: null, location: "Cleveland, OH", links: [],
  summary: { text: "Summary.", sources: [] },
  roles: [{ title: "Specialist", employer: "Genius One, Inc.", location: null, start: "2024-03-01", end: null, startPrecision: "MONTH", endPrecision: "MONTH", isCurrent: true, employmentType: null, lines: [{ text: "Did work.", sources: [] }] } as any],
  education: [], skillGroups: [],
  projects: [{ name: "RENTPUP", line: { text: "A product.", sources: [] }, optional: [{ text: "Built it.", sources: [] }] }],
};
const md = renderMarkdown({ ...doc, projectsFirst: true });
ok(md.indexOf("## Projects") < md.indexOf("## Experience"), "markdown: projects before experience when projectsFirst");
const md2 = renderMarkdown(doc);
ok(md2.indexOf("## Experience") < md2.indexOf("## Projects"), "markdown: experience first by default");
const html = resumeHtml({ ...doc, projectsFirst: true });
ok(html.indexOf("<h2>Selected Work</h2>") < html.indexOf("<h2>Experience</h2>"), "pdf html: Selected Work before Experience when projectsFirst");
const html2 = resumeHtml(doc);
ok(html2.indexOf("<h2>Experience</h2>") < html2.indexOf("<h2>Selected Work</h2>"), "pdf html: Experience first by default");
console.log(bad ? `\n${bad} FAILED` : "\nai-posting-layout-selftest: ALL PASS");
process.exit(bad ? 1 : 0);
