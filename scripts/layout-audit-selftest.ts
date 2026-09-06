/**
 * Deterministic checks on the layout quality gate (no browser).
 * node scripts/layout-audit-selftest.ts
 */
import { auditLayout, PAGE_PX } from "../lib/render/layoutAudit.ts";
let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

const doc: any = {
  name: "Ty Pleban", email: "e", phone: "p", location: "Chicago, IL", links: [],
  summary: { text: "s", sources: [] },
  roles: [{ employer: "Genius One", title: "T", location: null, start: "2020", end: null, startPrecision: "YEAR", endPrecision: "YEAR", lines: [] }],
  education: [{ institution: "Lorain County Community College", credential: "AA" }],
  skillGroups: [], projects: [],
};
const text = "Ty Pleban Chicago, IL SUMMARY s EXPERIENCE Genius One EDUCATION Lorain County Community College Associate of Arts. This is enough extracted text to pass the minimum-length floor and exercise every branch of the audit without tripping the too-short guard at all.";

// 1. One page is always fine.
ok(auditLayout({ pageCount: 1, contentPx: 800, doc, text }).ok, "a one-page resume passes");

// 2. A trivial trailing overflow blocks.
{
  const r = auditLayout({ pageCount: 2, contentPx: PAGE_PX + 40, doc, text });
  ok(!r.ok && r.blocking.some((b) => /trivial overflow/.test(b)), "a 2nd page ~5% full is a blocking trivial overflow", JSON.stringify(r.blocking));
  ok(r.lastPageFill < 0.25, "and its last-page fill is under 25%", `${(r.lastPageFill*100).toFixed(0)}%`);
}
// 3. A genuinely full second page is fine.
{
  const r = auditLayout({ pageCount: 2, contentPx: PAGE_PX * 1.8, doc, text });
  ok(r.ok, "a 2nd page that is 80% full is not flagged", `${(r.lastPageFill*100).toFixed(0)}%`);
}
// 4. Broken extraction blocks.
ok(!auditLayout({ pageCount: 1, contentPx: 800, doc, text: "Ty Pleban ��� broken" }).ok, "replacement characters block");
ok(!auditLayout({ pageCount: 1, contentPx: 800, doc, text: "short" }).ok, "implausibly short extraction blocks");
// 5. A missing employer/school is a (non-blocking) warning.
{
  const r = auditLayout({ pageCount: 1, contentPx: 800, doc, text: "Ty Pleban SUMMARY plenty of words here to comfortably clear the two-hundred character minimum-length floor so that the extraction is not flagged as implausibly short, while deliberately omitting the employer and the school names so the missing-entity warning branch is the only thing this case exercises at all, indeed yes it is now long enough." });
  ok(r.ok && r.warnings.some((w) => /Genius One/.test(w)), "a missing employer is a warning, not blocking", JSON.stringify(r.warnings));
}
console.log(bad ? `\n${bad} FAILED` : `\nlayout-audit-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
