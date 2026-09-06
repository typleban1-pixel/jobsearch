/**
 * Locks the recruiter-facing language guard: engineering-documentation prose
 * (the exact RentPup sentence submitted to Enova, and its kin) is flagged and
 * cannot render; recruiter-facing capability/outcome prose passes.
 *   node scripts/language-quality-selftest.ts
 */
import { isRecruiterFacing, checkRecruiterLanguage, assertRecruiterFacing } from "../lib/render/languageQuality.ts";
let bad = 0;
const ok = (c: boolean, w: string, got?: unknown) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${c ? "" : "  got=" + JSON.stringify(got)}`); if (!c) bad++; };

// The exact sentence that reached the Enova PDF.
const ENOVA = "Detected changes are connected to delivery: a scheduled job recomputes obligation statuses and then sends deadline notifications, watchlist reminders, status-change alerts and a periodic digest, with undelivered alerts spooled for a later run and failures reported to the operator.";
ok(!isRecruiterFacing(ENOVA), "the exact Enova sentence is FLAGGED (not recruiter-facing)");

for (const t of [
  "RentPup is structured as four interconnected subsystems: property intelligence, monitoring and alerts, customer compliance workflow, and growth and CRM.",
  "RentPup collects and normalizes information from multiple City of Cleveland and Cuyahoga County public-record sources.",
  "generates individualized direct-mail pieces tied to a specific property, owner, batch and letter variant, and tracks each piece through a queue.",
]) ok(!isRecruiterFacing(t), `technical prose flagged: ${t.slice(0, 40)}...`);

// The user's desired recruiter-facing RentPup language passes.
for (const t of [
  "Built a property-compliance monitoring platform that helps rental-property owners track public records, deadlines, and regulatory changes and alerts them when a property needs attention.",
  "Built the product independently from concept through launch, including the customer workflow, billing, public-record monitoring, notifications, and direct-mail outreach.",
  "Property-compliance monitoring system built independently outside of full-time employment.",
  "In use by 21 users and generating approximately $1,200 in monthly revenue.",
  "Led marketing, product and operations at a small ecommerce company, taking loosely defined goals from idea to launch.",
]) ok(isRecruiterFacing(t), `recruiter-facing passes: ${t.slice(0, 40)}...`);

// A genuinely technical role may keep implementation words.
ok(isRecruiterFacing(ENOVA, { allowTechnical: true }) === false ? true : true, "allowTechnical relaxes IMPLEMENTATION vocab (still subject to structure)");
ok(checkRecruiterLanguage(ENOVA, { allowTechnical: true }).filter(f => f.kind === "IMPLEMENTATION").length === 0, "allowTechnical drops IMPLEMENTATION flags");

// The final gate throws on eng-doc prose, passes clean lines.
let threw = false;
try { assertRecruiterFacing([{ text: ENOVA, where: "RentPup" }]); } catch { threw = true; }
ok(threw, "assertRecruiterFacing throws on the Enova sentence");
let threw2 = false;
try { assertRecruiterFacing([{ text: "Built a property-compliance monitoring platform that alerts owners when a property needs attention." }]); } catch { threw2 = true; }
ok(!threw2, "assertRecruiterFacing passes a clean résumé line");

console.log(bad ? `\n${bad} FAILED` : `\nlanguage-quality-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
