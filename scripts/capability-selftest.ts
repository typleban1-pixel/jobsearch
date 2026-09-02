/**
 * Which verified skills are worth printing for a given posting.
 *
 * Written after Google Docs reached a real tailored resume for a job
 * that asked for Excel and Google Sheets and never mentioned documents.
 * It got there on the word "google": plain token overlap made every
 * product of a vendor relevant as soon as one of them was required.
 *
 * The rule these cases pin down is that a brand token alone establishes
 * nothing, while an exact tool name establishes a great deal. Nothing
 * here touches claim relevance or corpus scoring; scoreCapability is
 * consulted only when deciding which capabilities to print.
 */
import { profileFor, scoreCapability } from "../lib/render/relevance.ts";
import { selectCapabilities } from "../lib/render/tailoredDoc.ts";
import type { ResumeDoc } from "../lib/render/resume.ts";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};

// The real posting, with its real extracted themes.
const MENU = profileFor("Menu Strategy Analyst",
  ["excel", "project management", "google sheets", "fast-paced work environment experience", "food tasting and feedback"]);

console.log("\na vendor token alone makes nothing relevant");
check("Google Sheets is relevant, it was asked for", scoreCapability("Google Sheets", MENU) > 0);
check("Microsoft Excel is relevant, it was asked for", scoreCapability("Microsoft Excel", MENU) > 0);
check("Google Docs is NOT relevant, only its vendor was named",
  scoreCapability("Google Docs", MENU) === 0, String(scoreCapability("Google Docs", MENU)));
check("Google Analytics is NOT relevant either",
  scoreCapability("Google Analytics", MENU) === 0, String(scoreCapability("Google Analytics", MENU)));
check("Microsoft PowerPoint is NOT relevant",
  scoreCapability("Microsoft PowerPoint", MENU) === 0, String(scoreCapability("Microsoft PowerPoint", MENU)));

console.log("\nthe same tools ARE relevant where the posting names them");
const DOCS = profileFor("Content Coordinator", ["google docs", "documentation", "style guides"]);
check("Google Docs is relevant to a posting that asks for Google Docs", scoreCapability("Google Docs", DOCS) > 0);
check("and Google Sheets is not, on that posting", scoreCapability("Google Sheets", DOCS) === 0);

const DECKS = profileFor("Sales Enablement Manager", ["microsoft powerpoint", "presentation design"]);
check("PowerPoint is relevant where presentations are asked for", scoreCapability("Microsoft PowerPoint", DECKS) > 0);
check("and Excel is not, on that posting", scoreCapability("Microsoft Excel", DECKS) === 0);

console.log("\nan exact tool name outscores an incidental word");
check("the full name scores higher than a lone shared word",
  scoreCapability("Google Sheets", MENU) > scoreCapability("Microsoft Excel", MENU),
  `sheets ${scoreCapability("Google Sheets", MENU)} vs excel ${scoreCapability("Microsoft Excel", MENU)}`);

console.log("\nnon-vendor skills are unaffected");
check("an ordinary skill still matches on its own words",
  scoreCapability("Project coordination", MENU) > 0);
check("an unrelated skill still scores nothing",
  scoreCapability("FDM 3D printing", MENU) === 0);

console.log("\nthrough the section selector");
const doc = {
  skillGroups: [
    { label: "Office and productivity tools", skills: ["Microsoft Excel", "Google Sheets", "Google Docs", "Microsoft PowerPoint"] },
    { label: "Creative production", skills: ["Adobe Premiere Pro", "Adobe Photoshop", "Video editing"] },
  ],
} as ResumeDoc;

const picked = selectCapabilities(doc, ["excel", "google sheets", "project management"], "Menu Strategy Analyst");
const office = picked.find((g) => g.label === "Office and productivity tools");
check("the office group is printed", Boolean(office), JSON.stringify(picked));
check("with exactly the two tools the posting asks for",
  office?.skills.length === 2 && office.skills.includes("Microsoft Excel") && office.skills.includes("Google Sheets"),
  JSON.stringify(office?.skills));
check("and Google Docs is not among them", !office?.skills.includes("Google Docs"));
check("an irrelevant group is dropped entirely",
  !picked.some((g) => g.label === "Creative production"), JSON.stringify(picked.map((g) => g.label)));

// Naming one Google tool must not print the rest of them. This is the
// exact shape of the defect, through the selector rather than the score.
const oneGoogleTool = selectCapabilities(doc, ["google sheets"], "Operations Analyst");
const g = oneGoogleTool.find((x) => x.label === "Office and productivity tools");
check("asking for one Google tool does not print the others",
  !g || (!g.skills.includes("Google Docs") && !g.skills.includes("Microsoft PowerPoint")),
  JSON.stringify(g?.skills));

// A caveat worth stating rather than asserting away. Some brand names
// carry a genuine concept: "adobe" in a posting maps to
// creative_production in the concept dictionary, so Adobe tools stay
// relevant to a posting that says "adobe" and nothing else. That is the
// dictionary's judgement, it is shared with claim relevance and corpus
// scoring, and narrowing it here would change far more than which
// capabilities get printed. "google" carries no such concept, which is
// why the word rule above is what the Docs case needed.
const adobeOnly = selectCapabilities(doc, ["adobe"], "Operations Analyst");
check("a vendor whose name IS a concept still selects its tools, by concept not by token",
  adobeOnly.some((x) => x.label === "Creative production"), JSON.stringify(adobeOnly.map((x) => x.label)));

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
