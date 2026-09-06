/**
 * Locks the LOW_STAKES_SURVEY classification: generic recruiting/attribution
 * questions may be answered generically; anything substantive must not be.
 *   node scripts/low-stakes-survey-selftest.ts
 */
import { classifyLowStakesSurvey, pickSurveyOption, GENERIC_SURVEY_FREETEXT } from "../lib/applications/lowStakesSurvey.ts";
let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };
const low = (t: string) => ok(classifyLowStakesSurvey(t).low, `LOW-STAKES: ${t}`);
const not = (t: string) => ok(!classifyLowStakesSurvey(t).low, `NOT low-stakes: ${t}`, classifyLowStakesSurvey(t).reason);

// low-stakes attribution/sourcing questions
low("How did you first hear about Flexport?");
low("Let us know specifically how you heard about us:");
low("How did you hear about this position?");
low("Where did you hear about this position?");
low("How did you find this job?");
low("What brought you to our careers page?");
low("Where did you see this job posting?");
low("How were you made aware of this opportunity?");

// substantive questions that must NOT be low-stakes'd
not("Are you authorized to work lawfully in the United States?");
not("Will you now or in the future require sponsorship?");
not("Have you previously been employed by Flexport or any of its entities?");
not("What are your salary expectations?");
not("What is your highest level of education?");
not("How many years of experience do you have with Python?");
not("Have you ever been convicted of a felony?");
not("Do you have any conflicts of interest?");
not("What is your gender?");
not("Are you Hispanic or Latino?");
not("Do you identify as having a disability?");
not("Are you a protected veteran?");
not("What is the name of the person who referred you?");   // referral NAME is substantive
not("Are you willing to relocate?");
not("When can you start?");
not("Do you have management experience?");
not("Where are you currently located?");

// option picking
{
  const flex = ["Campus","Career Platform (LinkedIn, Glassdoor, BuiltIn, etc.)","Event","Flexport Blog","Flexport Employee","Media","Social Media","Other"];
  const p = pickSurveyOption(flex);
  ok(!!p && /career platform/i.test(p.value), "Flexport options -> Career Platform", p?.value);
}
{
  const p = pickSurveyOption(["LinkedIn","Company Website","Indeed","Other"]);
  ok(!!p && /company website/i.test(p.value), "prefers Company Website when offered", p?.value);
}
{
  const p = pickSurveyOption(["Referral","Recruiter","Something Else"]);
  ok(!!p && p.value === "Something Else", "specific channels excluded; 'Something Else' is a truthful not-listed answer", p?.value);
}
// Truthfulness: a specific channel that did not happen must never be chosen,
// even when its label loosely contains a generic word.
{
  const p = pickSurveyOption(["LinkedIn","Company Website","Campus Career Site","Employee Referral","Other"]);
  ok(!!p && p.value === "Company Website", "Campus Career Site is NOT read as a generic careers site", p?.value);
}
ok(pickSurveyOption(["Campus Career Site"]) === null, "only an untruthful-specific option -> null (leave for review, do not invent)");
ok(pickSurveyOption(["Campus","Career Fair","Employee Referral","Friend or Family"]) === null, "no truthful generic option -> null (block to review)");
ok(pickSurveyOption([]) === null, "no options -> null (caller uses free text)");
ok(GENERIC_SURVEY_FREETEXT === "Company website", "free-text answer is 'Company website'");

console.log(bad ? `\n${bad} FAILED` : `\nlow-stakes-survey-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
