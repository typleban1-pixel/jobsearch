/** The one property worth proving: submit is never chosen. */
import { chooseAdvance } from "../lib/workday/advance.ts";
let n = 0, bad = 0;
const ok = (c: boolean, w: string) => { n++; if (!c) { bad++; console.error(`FAIL ${w}`); } };

// ---- advancing works on the ordinary pages ---------------------------
for (const l of ["Save and Continue", "Continue", "Next", "save and continue"]) {
  const r = chooseAdvance(["Back", l, "Cancel"]);
  ok(r.click && r.label === l, `advances on ${JSON.stringify(l)}`);
}

// ---- submit is never chosen ------------------------------------------
for (const l of ["Submit", "Submit Application", "submit", "Apply Now", "Finish", "Send Application"]) {
  const r = chooseAdvance(["Back", l]);
  ok(!r.click, `never clicks ${JSON.stringify(l)}`);
  ok(!r.click && r.why.length > 0, `and says why for ${JSON.stringify(l)}`);
}
// Review: the only forward control is Submit.
{
  const r = chooseAdvance(["Back", "Submit"]);
  ok(!r.click, "the Review page does not advance itself");
  ok(!r.click && /not clicked without approval/.test(r.why), "and names approval as the reason");
}
// A button that both advances and submits is refused.
ok(!chooseAdvance(["Continue and Submit"]).click, "a hybrid label is refused, not matched loosely");
ok(!chooseAdvance(["Submit and Continue"]).click, "order does not matter to the refusal");

// ---- ambiguity fails closed ------------------------------------------
ok(!chooseAdvance(["Continue", "Next"]).click, "two advancing controls is an ambiguity");
ok(!chooseAdvance([]).click, "an empty page advances nothing");
ok(!chooseAdvance(["Back", "Cancel", "Save for Later"]).click, "no forward control means no click");
ok(!chooseAdvance(["Continuez"]).click, "a near-miss label is not matched");
ok(!chooseAdvance(["Continue to Submit"]).click, "a label mentioning submit is refused even if it starts with Continue");

// ---- acknowledgments: standard ones are checked, others are shown ----
import { classifyAcceptance } from "../lib/workday/advance.ts";
for (const t of [
  "Please acknowledge your acceptance of the foregoing terms and conditions by checking the box below.",
  "I accept the Terms and Conditions",
  "acceptTermsAndAgreements",
  "I agree to the privacy policy",
  "I certify that the information provided in this application is true and complete",
  "I acknowledge this electronic signature",
]) ok(classifyAcceptance(t).kind === "STANDARD", `standard acknowledgment: ${t.slice(0, 46)}`);

for (const [t, word] of [
  ["I agree to resolve all disputes through binding arbitration", "arbitration"],
  ["I accept these terms including a non-compete covenant", "non-compete"],
  ["I accept the terms and waive any right to a jury trial", "waiver"],
  ["I agree to the terms and consent to a credit check", "credit check"],
  ["I certify that I have never been convicted of a felony", "personal fact"],
  ["I agree to the terms and to indemnify the company", "indemnity"],
] as [string, string][]) {
  const v = classifyAcceptance(t);
  ok(v.kind === "NEEDS_A_PERSON", `${word} is shown to a person, not checked`);
  ok(v.kind === "NEEDS_A_PERSON" && v.why.length > 0, `${word} explains why`);
}

for (const t of ["First Name", "Are you 18 years of age or older?", "Veterans Status",
                 "Have you ever been an employee of Northern Trust?", "Race/Ethnicity", "Phone Number"])
  ok(classifyAcceptance(t).kind === "NOT_ACCEPTANCE", `ordinary question is not an acknowledgment: ${t}`);

console.log(`${n - bad}/${n} assertions passed`);
process.exit(bad ? 1 : 0);
