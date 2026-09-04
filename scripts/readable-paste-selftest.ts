/**
 * The Resume Builder paste normalizer must turn clipboard HTML into
 * readable text: paragraph breaks, separated headings, preserved bullet
 * AND numbered items, and never adjacent blocks concatenated (the WolfeCo
 * "In-PersonTime Zone" / "ResponsibilitiesTeam Workflow" symptom).
 */
import { readablePaste } from "../lib/resume/readablePaste.ts";

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

// A WolfeCo-shaped posting: the exact block adjacencies from the report.
const html =
  `<h2>About WolfeCo</h2><p>WolfeCo Media</p>` +
  `<p><b>Location:</b> In-Person</p><p><b>Time Zone:</b> ET</p>` +
  `<p>reporting</p><p>We're looking</p>` +
  `<h2>Responsibilities</h2><h3>Team Workflow &amp; Project Management</h3>` +
  `<ul><li>Manage the calendar</li><li>Coordinate freelancers</li></ul>` +
  `<h2>Application Process</h2><ol><li>Submit resume</li><li>Screening call</li><li>Final interview</li></ol>`;
const out = readablePaste(html);
const lines = out.split("\n").map((l) => l.trim());

ok(!/In-PersonTime Zone/.test(out), 'no "In-PersonTime Zone" concatenation');
ok(!/About WolfeCoWolfeCo Media/.test(out), 'no "About WolfeCoWolfeCo Media" concatenation');
ok(!/reportingWe're looking/.test(out), 'no "reportingWe\'re looking" concatenation');
ok(!/ResponsibilitiesTeam Workflow/.test(out), 'no "ResponsibilitiesTeam Workflow" concatenation');
ok(lines.includes("Location: In-Person") && lines.includes("Time Zone: ET"), "paragraph breaks preserved (Location / Time Zone on their own lines)");
ok(lines.includes("About WolfeCo") && lines.includes("Responsibilities"), "headings visually separated on their own lines");
ok(out.includes("- Manage the calendar") && out.includes("- Coordinate freelancers"), "bullet list line breaks preserved");
ok(/(^|\n)1\. Submit resume(\n|$)/.test(out) && /(^|\n)2\. Screening call/.test(out) && /(^|\n)3\. Final interview/.test(out), "numbered items preserved (1. 2. 3.)");
ok(readablePaste(null) === "" && readablePaste(undefined) === "" && readablePaste("") === "", "null/empty HTML yields empty (caller falls back to native paste)");
// never emits a raw tag
ok(!/<[a-zA-Z/]/.test(out), "output is plain text, no residual HTML tags");

console.log(bad ? `\n${bad} FAILED` : `\nreadable-paste-selftest: ALL PASS`);
console.log("\n--- rendered sample ---\n" + out);
process.exit(bad ? 1 : 0);
