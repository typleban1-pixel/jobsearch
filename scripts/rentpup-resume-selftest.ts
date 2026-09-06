/**
 * Locks the RentPup résumé regression the Enova PDF exposed: the Selected
 * Work heading, the RentPup name and its recruiter-facing description render
 * together and BEFORE Capabilities/Education, and no engineering-documentation
 * prose reaches the résumé.
 *   node scripts/rentpup-resume-selftest.ts
 */
import { renderResumeHtml, type ResumeDoc } from "../lib/render/resumePdf.ts";
import { isRecruiterFacing } from "../lib/render/languageQuality.ts";
let bad = 0;
const ok = (c: boolean, w: string, got?: unknown) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${c ? "" : "  got=" + JSON.stringify(got)}`); if (!c) bad++; };

const RENTPUP_DESC = "A property-compliance monitoring product helping Cleveland rental-property owners identify regulatory issues and upcoming compliance risks.";
const doc: ResumeDoc = {
  name: "Ty Pleban", email: "e@x.com", phone: "1", location: "Cleveland, OH", links: [],
  summary: { text: "Marketing, product and operations generalist.", sources: [] },
  roles: [{ title: "Digital Marketing, Product & Operations Specialist", employer: "Genius One", location: null,
    start: "2024-03-01", end: null, startPrecision: "month", endPrecision: null, periods: [],
    lines: [{ text: "Led marketing, product and ecommerce initiatives from idea to launch.", sources: [] }] } as any],
  education: [{ institution: "Lorain County CC", credential: "Associate", field: "Media" }],
  skillGroups: [{ label: "Marketing", skills: ["SEO", "Email marketing"] }],
  projects: [{ name: "RENTPUP - rentpup.com - Independent Product", title: "Founder / Product Builder",
    line: { text: RENTPUP_DESC, sources: ["p1"] },
    optional: [{ text: "In use by 21 users and generating approximately $1,200 in monthly revenue.", sources: ["m1", "m2"] }],
  } as any],
};

const html = renderResumeHtml(doc);
// Match the section HEADINGS precisely; the words appear in CSS comments too.
const iSelected = html.indexOf("<h2>Selected Work</h2>");
const iRent = html.indexOf("RENTPUP");
const iDesc = html.indexOf(RENTPUP_DESC.slice(0, 40));
const iCaps = html.indexOf("<h2>Capabilities</h2>");
const iEdu = html.indexOf("<h2>Education</h2>");

ok(iSelected > 0 && iRent > iSelected, "Selected Work heading precedes the RentPup name");
ok(iDesc > iRent, "RentPup recruiter-facing description follows its name");
ok(iSelected < iCaps && iSelected < iEdu, "Selected Work section renders BEFORE Capabilities and Education");
ok(iDesc < iEdu, "the RentPup description renders before Education (never detached below it)");
ok(html.includes("project-desc"), "the description carries the keep-together class");
ok(!/recomputes obligation|spooled|scheduled job/.test(html), "no engineering-documentation prose in the résumé");
ok(isRecruiterFacing(RENTPUP_DESC), "the RentPup description is recruiter-facing by the guard");

console.log(bad ? `\n${bad} FAILED` : `\nrentpup-resume-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
