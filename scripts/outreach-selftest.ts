/** The follow-up note: fixed skeleton, approved material, every rule checked. */
import { composeOutreach, firstPerson } from "../lib/outreach/compose.ts";
let bad = 0;
const ok = (c: boolean, what: string, extra = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${extra ? " -- " + extra : ""}`); if (!c) bad++; };
const profile = { preferredName: "Ty", firstName: "Tyler", lastName: "Pleban", phone: "210-577-4548", linkedin: "https://www.linkedin.com/in/tylerpleban/" };
const LINES = [
  "Built a property-compliance monitoring platform from concept through launch, using AI-assisted development alongside hands-on product design, workflow architecture, data integration, testing, and iteration.",
  "In use by 21 users and generating approximately $1,200 in monthly revenue.",
  "Built an AI system that analyzes how approximately 180,000 contacts behave and what they buy, identifying who is about to buy, who is slipping away, who is price-shopping, and who is worth holding onto.",
  "Taught and mentored 250+ students, translating technical concepts and professional workflows into hands-on instruction.",
  "Executed digital marketing and ecommerce work across websites, SEO, email, analytics, content, creative production, and online storefronts.",
];
ok(firstPerson("Built a platform from concept through launch.") === "I built a platform from concept through launch.", "a line that starts with what he did becomes first person");
ok(firstPerson("In use by 21 users.") === null, "a line that does not start with a verb is not forced into the first person");

const d = composeOutreach({ company: "Aleph", title: "Engagement Associate", appliedOn: "2026-09-07T20:00:00Z", recruiterName: null,
  requirements: ["process improvement", "client onboarding"], resumeLines: LINES,
  postingText: "Aleph is an AI-native platform for FP&A. 1 year of experience at an early stage tech startup preferred.", profile });
console.log("\n" + d.subject + "\n\n" + d.body + "\n");
ok(d.problems.length === 0, "the note passes every rule", d.problems.join("; "));
ok(!d.needsYourWords, "every slot was filled from approved material");
ok(/^Hi there,/.test(d.body), "no recruiter name known: a plain greeting, never an invented one");
ok(/I applied for the Engagement Associate role at Aleph on September 7/.test(d.body), "the opening names the role, the company and the date as recorded");
ok(/The AI focus of the role is what drew me to it\./.test(d.body), "an AI posting gets the AI hook");
ok(/I built a property-compliance monitoring platform/.test(d.body), "RentPup leads the bridge on an AI posting, in the first person");
ok(/\d/.test(d.body.split("\n\n")[3] ?? ""), "the proof paragraph carries a number");
ok(d.body.split(/\s+/).length < 180, "under 180 words", String(d.body.split(/\s+/).length));
ok(!/salary|score|attach/i.test(d.body), "never mentions pay, score or attachments");
ok(/Ty Pleban\n210-577-4548 · https:\/\/www\.linkedin\.com/.test(d.body), "signed with name, phone and LinkedIn");

const named = composeOutreach({ company: "Aleph", title: "Engagement Associate", appliedOn: null, recruiterName: "Dana", requirements: [], resumeLines: LINES, postingText: "", profile });
ok(/^Hi Dana,/.test(named.body), "a recruiter name given is used");
ok(!/ on [A-Z][a-z]+ \d/.test(named.body.split("\n\n")[1]!), "no date when nothing was submitted yet");

const thin = composeOutreach({ company: "X", title: "Y", appliedOn: null, recruiterName: null, requirements: ["a"], resumeLines: ["In use by 21 users."], postingText: "", profile });
ok(thin.needsYourWords && /\[Two sentences in your words/.test(thin.body), "with no usable lines the bridge is left for the person, marked, never improvised");

console.log(bad ? `\n${bad} FAILED` : "\noutreach-selftest: ALL PASS");
process.exit(bad ? 1 : 0);
