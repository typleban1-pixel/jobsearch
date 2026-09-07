/** The follow-up note: the person's own email as the pattern, the job-dependent slots filled from the posting, every rule checked. */
import { composeOutreach, themesOf, fieldLine, STORY, STANCE, CLOSE, WORD_LIMIT } from "../lib/outreach/compose.ts";
let bad = 0;
const ok = (c: boolean, what: string, extra = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${extra ? " -- " + extra : ""}`); if (!c) bad++; };
const profile = { preferredName: "Ty", firstName: "Tyler", lastName: "Pleban", phone: "210-577-4548", linkedin: "https://www.linkedin.com/in/tylerpleban/" };

const CHARTIS = `Manager, Business Development Operations
Chartis is a healthcare advisory firm serving health systems, hospitals and payers. You will improve BD processes, standardize our sales process, build reporting and dashboards for pipeline metrics, and find practical uses for AI across the BD team. Work cross-functionally with stakeholders. Clinical and healthcare experience is a plus.`;
const d = composeOutreach({ company: "Chartis", title: "Manager, Business Development Operations", recruiterName: "Ashley", postingText: CHARTIS, profile });
console.log("\n" + d.subject + "\n\n" + d.body + "\n");
ok(d.problems.length === 0, "the note passes every rule", d.problems.join("; "));
ok(!d.needsYourWords, "every slot was filled");
ok(/^Hi Ashley,/.test(d.body), "a recruiter name given is used");
ok(/^I just applied for the Manager, Business Development Operations role at Chartis\. The focus on /m.test(d.body), "the opening names the role and company as recorded");
ok(themesOf(CHARTIS).includes("finding practical uses for AI"), "AI named on a single mention", themesOf(CHARTIS).join(" | "));
ok(themesOf(CHARTIS).length === 2, "two focus phrases at most", themesOf(CHARTIS).join(" | "));
ok(d.body.includes(STORY) && d.body.includes(STANCE) && d.body.includes(CLOSE), "the person's own paragraphs appear verbatim");
ok(d.body.includes("My bachelor's is also in Health Science"), "a healthcare posting gets the Health Science line");
ok(/Thanks so much,\n\nTy Pleban\n210-577-4548 · https:\/\/www\.linkedin\.com/.test(d.body), "signed the way the sample signs");
ok(d.body.split(/\s+/).length <= WORD_LIMIT, `within ${WORD_LIMIT} words`, String(d.body.split(/\s+/).length));

const tech = composeOutreach({ company: "Aleph", title: "Engagement Associate", recruiterName: null,
  postingText: "Aleph is an AI-native platform for FP&A. You will own client onboarding and client success, drive customer engagement. 1 year at an early stage tech startup preferred. Benefits include health insurance.", profile });
ok(/^Hi there,/.test(tech.body), "no recruiter name known: a plain greeting, never an invented one");
ok(!/Health Science|community college/.test(tech.body), "one stray mention of health insurance does not make it a healthcare posting");
ok(/The focus on .*finding practical uses for AI.* made me want/.test(tech.body), "AI hook on an AI posting", tech.body.split("\n\n")[1]);

const edu = fieldLine("Serve university students and faculty; higher education partners; colleges nationwide.", "Instructure");
ok(edu !== null && /community college/.test(edu), "an education posting gets the teaching line");

const blank = composeOutreach({ company: "X", title: "Y", recruiterName: null, postingText: "We need someone good.", profile });
ok(blank.needsYourWords && /The focus on \[the one or two things/.test(blank.body), "a posting that emphasises nothing we recognise leaves the hook to the person, marked, never improvised");
ok(blank.problems.length === 0, "a marked slot is not a rule violation");

const dbl = composeOutreach({ company: "X", title: "Analyst role", recruiterName: null, postingText: "analytics dashboards metrics", profile });
ok(dbl.problems.some((p) => /doubles a word/.test(p)), "a title already ending in 'role' is flagged");

console.log(bad ? `\n${bad} FAILED` : "\noutreach-selftest: ALL PASS");
process.exit(bad ? 1 : 0);
