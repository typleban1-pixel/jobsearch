import { toAmericanEnglish, assertAmericanEnglish } from "../lib/render/americanEnglish.ts";
import { checkClaims } from "../lib/render/claimGuards.ts";

/**
 * The rendering rule has to hold on the two cases that actually matter:
 * it must fix Commonwealth spelling anywhere in a document, and it must
 * leave a proper noun alone even when that proper noun contains a word
 * the rule would otherwise rewrite.
 */
const PROTECT = [
  "Lorain County Community College", "Centre for Applied Research",
  "Genius One, Inc.", "Anytime Picture LLC", "Holley Performance",
  "Sportsman Network", "Western Governors University", "Bachelor of Science",
];

const cases: Array<[string, string, string]> = [
  ["spelling", "Organised the programme and analysed behaviour across the centre.",
   "Organized the program and analyzed behavior across the center."],
  ["proper noun kept", "Partnered with the Centre for Applied Research on fulfilment.",
   "Partnered with the Centre for Applied Research on fulfillment."],
  ["mixed", "Specialised in cataloguing whilst travelling to the licence renewal.",
   "Specialized in cataloging while traveling to the license renewal."],
  ["capitalization", "Organisation and ORGANISATION and organisation",
   "Organization and ORGANIZATION and organization"],
  ["numeric range keeps hyphen", "Worked 2019\u20132022 at Genius One, Inc.",
   "Worked 2019-2022 at Genius One, Inc."],
  ["em dash removed", "Coordinated a collaboration \u2014 10+ deliverables.",
   "Coordinated a collaboration, 10+ deliverables."],
];

let failed = 0;
console.log("american english rendering layer\n");
for (const [name, input, expected] of cases) {
  const got = toAmericanEnglish(input, { protect: PROTECT }).text;
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        got      ${got}\n        expected ${expected}`);
}

// The guard must reject, not quietly pass.
let threw = false;
try { assertAmericanEnglish("We optimised the programme."); } catch { threw = true; }
console.log(`  ${threw ? "PASS" : "FAIL"}  assert rejects non-American text`);
if (!threw) failed++;

let clean = true;
try { assertAmericanEnglish("We optimized the program at Lorain County Community College.", { protect: PROTECT }); }
catch { clean = false; }
console.log(`  ${clean ? "PASS" : "FAIL"}  assert accepts already-American text`);
if (!clean) failed++;

// Claim guards: the approved wordings must pass, the flattering
// distortions of them must not.
const claimCases: Array<[string, boolean]> = [
  ["Built and grew RentPup, acquiring customers in Cleveland.", true],
  ["Built RentPup, an independent property-compliance product, in his own time.", false],
  ["Senior software engineer with full-stack experience.", true],
  ["Used AI-assisted development to build a working product end to end.", false],
  ["Created the Video Program internship program from the ground up.", true],
  ["Generated more than $70,000 in ARR.", true],
  ["Played a substantial hands-on role in developing, launching, and operating Genius Academy, an education-focused offering that reached a peak of more than $70,000 in annual recurring revenue in 2022.", false],
  ["Managed a team of 12 employees.", true],
  ["Supervised the day-to-day work of three student employees.", false],
  ["Taught and mentored 250+ students.", false],
];
console.log("");
for (const [text, shouldBlock] of claimCases) {
  const blocked = checkClaims(text).length > 0;
  const ok = blocked === shouldBlock;
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${blocked ? "blocked" : "allowed"}  ${text.slice(0, 52)}`);
}

console.log(`\n${failed === 0 ? "all passed" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
