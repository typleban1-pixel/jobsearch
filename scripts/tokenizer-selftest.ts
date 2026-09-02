/**
 * Punctuation must not decide whether a word matches.
 *
 * The defect: wordsOf() tokenized on /[a-z0-9+#.-]+/g so that "node.js"
 * and "e-billing" survive as single terms, and the same class swallowed
 * the full stop at the end of a sentence. Every claim in the profile
 * ends in one, so the last word of every claim was "operations." and no
 * concept term ever matched it. The identical sentence scored 4 without
 * its final character.
 *
 * The invariant being fixed: ordinary surrounding punctuation does not
 * change whether a word matches. The invariant being PROTECTED: internal
 * dots and hyphens still do.
 */
import { conceptsOf, profileFor, scoreClaim } from "../lib/render/relevance.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}\n         ${detail}`); }
};
const has = (text: string, concept: string) => conceptsOf(text).has(concept);

// ---- 1. the same word, surrounded differently ------------------------
//
// Each of these is the identical sentence with one trailing character
// changed. The word is the last one on purpose: that is where the bug
// lived, and where a naive fix will still miss it.
const FRAMES = ["operations", "operations.", "operations,", "operations;",
                "operations:", "operations)", "operations!", "operations?",
                "operations\"", "operations'", "(operations)", "operations…",
                "operations]", "operations}"];
for (const f of FRAMES) {
  check(`"${f}" expresses process_workflow`, has(`Managed lab ${f}`, "process_workflow"),
    JSON.stringify([...conceptsOf(`Managed lab ${f}`)]));
}
check("a leading full stop does not hide the word", has("Managed lab .operations", "process_workflow"));
check("surrounding quotes do not hide it", has('Managed lab "operations"', "process_workflow"));

// The whole point, stated once as an equality rather than as a list.
const SENTENCE = "Supervised the day-to-day work of three student employees, and managed day-to-day lab operations";
const posting = profileFor("Legal Operations Specialist",
  ["operations experience", "process improvement", "multitasking and deadline management"]);
check("the sentence scores the same with and without its final stop",
  scoreClaim(SENTENCE, posting) === scoreClaim(`${SENTENCE}.`, posting),
  `${scoreClaim(SENTENCE, posting)} vs ${scoreClaim(`${SENTENCE}.`, posting)}`);
check("and that score is not zero", scoreClaim(`${SENTENCE}.`, posting) > 0,
  String(scoreClaim(`${SENTENCE}.`, posting)));

for (const [bare, punctuated] of [
  ["Coordinated cross-department projects", "Coordinated cross-department projects."],
  ["Ran analytics and reporting", "Ran analytics and reporting!"],
  ["Handled customer support", "Handled customer support;"],
  ["Built the platform", "Built the platform)"],
] as const) {
  check(`"${punctuated.slice(-14)}" matches what "${bare.slice(-12)}" matches`,
    JSON.stringify([...conceptsOf(bare)].sort()) === JSON.stringify([...conceptsOf(punctuated)].sort()),
    `${JSON.stringify([...conceptsOf(bare)])} vs ${JSON.stringify([...conceptsOf(punctuated)])}`);
}

// ---- 2. internal punctuation still carries meaning -------------------
//
// These are the reason the character class is permissive in the first
// place. A fix that strips dots and hyphens everywhere passes section 1
// and destroys these.
const words = (t: string) => [...conceptsOf(t)]; // proxy: exercised through the real path below
import { RELEVANCE_VERSION } from "../lib/render/relevance.ts";
check("the scorer version is unchanged by this fix", RELEVANCE_VERSION === 1, String(RELEVANCE_VERSION));

// A posting naming a hyphenated or dotted tool must still match a claim
// naming the same tool, and must NOT match its halves.
// Long enough to earn the literal bonus, which requires more than four
// characters. These must actually score.
for (const tok of ["node.js", "e-billing", "day-to-day", "post-production", "cross-functional", "on-site", "go-to-market"]) {
  const p = profileFor("", [tok]);
  check(`"${tok}" survives tokenization intact`, scoreClaim(`Worked with ${tok} systems`, p) > 0,
    `score ${scoreClaim(`Worked with ${tok} systems`, p)}`);
  check(`"${tok}" still matches when a sentence ends on it`, scoreClaim(`Worked with ${tok}.`, p) > 0,
    `score ${scoreClaim(`Worked with ${tok}.`, p)}`);
}
// "c++" and "c#" are below the literal bonus's length floor and score
// zero whatever the tokenizer does. That floor is scoring semantics and
// is deliberately not touched here; what is asserted is only that
// punctuation does not make them behave differently.
for (const tok of ["c++", "c#"]) {
  const p = profileFor("", [tok]);
  check(`"${tok}" behaves identically with and without a trailing stop`,
    scoreClaim(`Worked with ${tok} systems`, p) === scoreClaim(`Worked with ${tok}.`, p),
    `${scoreClaim(`Worked with ${tok} systems`, p)} vs ${scoreClaim(`Worked with ${tok}.`, p)}`);
}
{
  const p = profileFor("", ["node.js"]);
  check("a dotted token is not split into its halves",
    scoreClaim("Worked with node and js separately", p) === 0,
    String(scoreClaim("Worked with node and js separately", p)));
}
{
  const p = profileFor("", ["e-billing"]);
  check("a hyphenated token is not split into its halves",
    scoreClaim("Handled billing", p) === 0, String(scoreClaim("Handled billing", p)));
}
check("cross-functional is still one concept-bearing token",
  has("Collaborated cross-functional.", "cross_functional"));
check("and so is post-production", has("Led post-production.", "creative_production"));

// ---- 3. nothing else moved -------------------------------------------
//
// A claim with no punctuation at the end scored what it scored before
// the fix, and must still score exactly that.
const UNCHANGED: Array<[string, string[], number]> = [
  ["Coordinated cross-functionally with marketing and other teams to set creative approaches and run projects from planning through delivery",
   ["process improvement", "project coordination"], 6],
  // Measured before the fix and asserted unchanged after it. It ends on
  // "Onshape", a word no concept lists, so the fix must not move it.
  ["Designed, prototyped, tested, and refined physical products using FDM 3D printing, parametric CAD in Onshape",
   ["process improvement", "project coordination"], 0],
];
for (const [claim, terms, expected] of UNCHANGED) {
  const p = profileFor("Operations Manager", terms);
  check(`an unpunctuated claim still scores ${expected}`, scoreClaim(claim, p) === expected,
    `${scoreClaim(claim, p)} for "${claim.slice(0, 40)}"`);
}
check("an empty claim still scores zero", scoreClaim("", profileFor("X", ["y"])) === 0);
check("punctuation alone expresses no concept", conceptsOf(".,;:!?").size === 0);
check("a bare full stop is not a word", conceptsOf(". . .").size === 0);

void words;
console.log(`\n${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
