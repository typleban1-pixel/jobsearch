/**
 * The submitter must read the confirmation on the FORM's page, not on the
 * employer wrapper or a stale tab. This checks the page-picking rule stays
 * provider-agnostic while keeping Greenhouse's proven behaviour.
 */
import { pickResultPageIndex } from "../lib/browser/resultPage.ts";
let bad = 0;
const ok = (c: boolean, w: string) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}`); if (!c) bad++; };

// Greenhouse: the form origin is greenhouse.io; that page is picked (old behaviour).
ok(pickResultPageIndex(["https://acme.com/careers", "https://boards.greenhouse.io/acme/jobs/1"],
  "https://boards.greenhouse.io/acme/jobs/1") === 1, "picks the greenhouse.io form page");
// Ashby: the form origin is jobs.ashbyhq.com; that page is picked, not the last tab.
ok(pickResultPageIndex(["https://jobs.ashbyhq.com/acme/abc", "about:blank"],
  "https://jobs.ashbyhq.com/acme/abc") === 0, "picks the Ashby form-origin page over a blank tab");
// Lever/Workday: origin match with no greenhouse anywhere.
ok(pickResultPageIndex(["about:blank", "https://jobs.lever.co/acme/xyz"],
  "https://jobs.lever.co/acme/xyz") === 1, "picks the Lever form-origin page");
// No origin match, greenhouse present -> greenhouse fallback.
ok(pickResultPageIndex(["https://x.com/a", "https://boards.greenhouse.io/y/z"],
  "https://jobs.ashbyhq.com/none/here") === 1, "falls back to a greenhouse.io page when the origin is absent");
// Nothing matches -> the last page opened.
ok(pickResultPageIndex(["https://a.com/1", "https://b.com/2"], "https://c.com/3") === 1, "falls back to the last page");
ok(pickResultPageIndex([], "https://a.com") === -1, "no pages -> -1");

console.log(bad ? `\n${bad} FAILED` : `\nresult-page-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
