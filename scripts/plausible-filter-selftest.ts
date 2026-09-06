/**
 * Locks the cheap plausibility prefilter: it EXCLUDES only clear
 * occupational mismatch and leadership seniority, and passes named-relevant
 * AND ambiguous titles through to candidacy (breadth preserved). Uses real
 * inventory titles so the boundaries are the ones that actually occur.
 *   node scripts/plausible-filter-selftest.ts
 */
import { isPlausibleJob } from "../lib/discovery/plausibleFilter.ts";
let bad = 0;
const ok = (c: boolean, w: string) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}`); if (!c) bad++; };
const P = (title: string, extra: any = {}) => isPlausibleJob({ title, ...extra }).plausible;

// EXCLUDE: clearly other occupations
for (const t of ["Software Engineer", "Senior Security Operations Engineer", "Staff Backend Engineer",
  "Data Scientist", "Registered Nurse", "Clinical Research Coordinator", "Staff Attorney",
  "Senior Accountant", "Algorithmic Trader", "Quantitative Researcher", "Associate Sales Engineer",
  "Account Executive, Mid Market", "GTM Contract Recruiter", "Warehouse Operations Associate",
  "Delivery Driver", "High School Teacher"]) {
  ok(!P(t), `EXCLUDE occupation: ${t}`);
}
// EXCLUDE: leadership seniority (title or structured)
for (const t of ["Director of Product Operations", "VP, Marketing", "Head of GTM, Sales Planning",
  "Chief Marketing Officer", "Principal Business Systems Analyst"]) {
  ok(!P(t), `EXCLUDE leadership: ${t}`);
}
ok(!P("Marketing Manager", { seniority: "DIRECTOR" }), "EXCLUDE structured DIRECTOR seniority even if title is IC");

// INCLUDE: named relevant functions (candidacy makes the real call)
for (const t of ["Digital Marketing, Product & Operations Specialist", "Marketing & Communications Program Manager",
  "Content Manager", "Social Media & Content Manager", "Product Marketing Manager",
  "Strategy & Operations Associate", "Senior Associate, Implementation", "Customer Success Manager",
  "Program Coordinator", "Senior Manager, Demand Generation", "Revenue Operations Lead",
  "Account Manager", "Ecommerce Specialist", "Video Producer"]) {
  ok(P(t), `INCLUDE relevant: ${t}`);
}
// INCLUDE: ambiguous generalist (breadth: not excluded -> passes)
for (const t of ["Rotational Development Program", "Business Analyst", "Operations Associate"]) {
  ok(P(t), `INCLUDE ambiguous (breadth): ${t}`);
}
// an IC-marked leadership-ish title still passes
ok(P("Principal Product Manager", { isIC: true }), "INCLUDE explicit IC even if title says Principal");

console.log(bad ? `\n${bad} FAILED` : `\nplausible-filter-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
