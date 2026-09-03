/**
 * The standing answer to "have you worked here before" is No, and the
 * value of a standing answer is entirely in its scope. These cases are
 * mostly about the boundary: the questions that look like it and are not.
 */
import { matchesPriorEmployment, PRIOR_EMPLOYMENT_ANSWER } from "../lib/applications/priorEmployment.ts";

let n = 0, bad = 0;
const ok = (c: boolean, what: string) => { n++; if (!c) { bad++; console.error(`FAIL ${what}`); } };
const covered = (t: string) => ok(matchesPriorEmployment(t).covered, `COVERED: ${t}`);
const not = (t: string) => ok(!matchesPriorEmployment(t).covered, `NOT COVERED: ${t}`);

// ---- 1. the wordings the rule is for ---------------------------------
covered("Have you ever worked for Northern Trust?");
covered("Have you ever been employed by Stripe?");
covered("Have you previously worked for our company?");
covered("Are you a former employee?");
covered("Previous Worker");
covered("Prior employment with the company");
covered("Have you worked here before?");
covered("Have you been employed by this company before?");
covered("Have you ever worked for us in any capacity?");
covered("candidateIsPreviousWorker");
covered("Are you eligible for rehire?");
covered("Have you ever been employed by the company in the past?");
covered("Were you previously employed with us?");
covered("Have you ever worked at this organization before?");

// ---- 2. the employer group is still the employer ---------------------
covered("Have you ever been employed by this company or any of its affiliates?");
covered("Have you previously worked for the Company or its subsidiaries?");
covered("Have you ever been employed by us or a predecessor company?");
ok(matchesPriorEmployment("Have you ever been employed by this company or any of its affiliates?")
   .why.includes("affiliates"), "the affiliate reach is named in the reason, not hidden");

// ---- 3. THE BOUNDARY: adjacent questions this must never answer ------
not("Have you previously applied to Stripe?");
not("Have you ever applied for a position with our company before?");
not("Have you interviewed with us before?");
not("Have you ever interviewed for a role at this company?");
not("Do you have any relatives employed by the company?");
not("Is any immediate family member employed here?");
not("Do you have friends who work at Stripe?");
not("Were you referred by a current employee?");
not("How did you hear about us? Employee referral");
not("Have you ever worked for a client of the firm?");
not("Have you ever worked for a customer or vendor of the company?");
not("Have you been a contractor for Acme Corporation?");
not("Are you currently employed by another financial institution?");

// exclusions beat coverage even when the covered words are present
{
  const m = matchesPriorEmployment("Have you ever worked for a client of ours?");
  ok(!m.covered, "client wording is excluded despite containing 'ever worked'");
  ok(!m.covered && Boolean(m.excludedBy), "an exclusion says which words excluded it");
}
{
  const m = matchesPriorEmployment("Have you ever applied to or been employed by this company?");
  ok(!m.covered, "a compound question mentioning applying is not auto-answered");
}
{
  const m = matchesPriorEmployment("Have you ever interviewed with or worked for this company?");
  ok(!m.covered, "a compound question mentioning interviewing is not auto-answered");
}

// ---- 4. unrelated fields are untouched -------------------------------
not("First Name");
not("What is your current employer?");
not("Describe your work experience");
not("Are you authorized to work in the United States?");
not("Have you ever been convicted of a felony?");
not("Years of experience");
not("");
not("   ");

// ---- 5. the answer itself ---------------------------------------------
ok(PRIOR_EMPLOYMENT_ANSWER === "No", "the declared answer is No");
for (const t of ["Have you ever worked for Northern Trust?", "Previous Worker", "candidateIsPreviousWorker"]) {
  ok(matchesPriorEmployment(t).why.length > 0, `a covered match explains itself: ${t}`);
}
for (const t of ["Have you previously applied?", "Do you have relatives employed here?"]) {
  ok(matchesPriorEmployment(t).why.length > 0, `an exclusion explains itself: ${t}`);
}

console.log(`${n - bad}/${n} assertions passed`);
process.exit(bad ? 1 : 0);
