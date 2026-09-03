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

console.log(`${n - bad}/${n} assertions passed`);
process.exit(bad ? 1 : 0);
