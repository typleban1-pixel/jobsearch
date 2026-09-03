/**
 * A secondary field must not inherit its primary's answer.
 *
 *   node scripts/inherited-answer-selftest.ts
 *
 * The resolver matches on intent, and several fields legitimately share
 * one. On a Northern Trust form that meant "Address Line 2" came back
 * with the whole street address and "Phone Extension" with the whole
 * phone number, because each matched the same intent as its primary.
 * Submitted, that puts the address on two lines and the phone number in
 * the extension box.
 *
 * This is a property of two-line address and phone forms generally, not
 * of Workday, so the guard lives in the resolver and is tested here.
 */
import { guardInheritedAnswer, type ResolvedField } from "../lib/applications/answer.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}  ${d}`); }
};
const R = (label: string, answer: string, confidence = "VERIFIED"): ResolvedField => ({
  field: { label, name: label, required: false, type: "text" } as any,
  intentKey: null, matchedBy: "test", answer, confidence: confidence as any,
  blockKind: null, blockedReason: null, evidenceIds: [], considered: [], refused: false,
});
const ADDR = "740 W. Superior Ave #609";
const PHONE = "210-577-4548";

console.log("\n1. the address case that was live:");
{
  const g = guardInheritedAnswer(R("Address Line 2", ADDR), [ADDR]);
  check("line 2 echoing line 1 is blanked", g.answer === "");
  check("and marked DERIVED, not BLOCKED", g.confidence === "DERIVED", g.confidence);
  check("with a reason saying it is deliberate", /deliberate blank/.test(g.matchedBy), g.matchedBy);
  check("it is not left unanswered", g.blockedReason === null && g.blockKind === null);
}

console.log("\n2. the phone case that was live:");
{
  const g = guardInheritedAnswer(R("Phone Extension", PHONE), [PHONE]);
  check("an extension echoing the number is blanked", g.answer === "" && g.confidence === "DERIVED");
  check("the reason names the extension", /extension/.test(g.matchedBy), g.matchedBy);
  const g2 = guardInheritedAnswer(R("Phone Ext.", PHONE), [PHONE]);
  check("abbreviated 'Ext.' is caught too", g2.answer === "");
}

console.log("\n3. the PRIMARY field is never blanked:");
{
  check("Address Line 1 keeps its answer",
    guardInheritedAnswer(R("Address Line 1", ADDR), [ADDR]).answer === ADDR);
  check("Phone Number keeps its answer",
    guardInheritedAnswer(R("Phone Number", PHONE), [PHONE]).answer === PHONE);
  check("a bare 'Address' keeps its answer",
    guardInheritedAnswer(R("Address", ADDR), [ADDR]).answer === ADDR);
}

console.log("\n4. a genuine secondary answer survives:");
{
  // If the profile ever holds a real unit or extension, blanking it
  // would be the same class of error in the other direction.
  check("line 2 with its OWN value is untouched",
    guardInheritedAnswer(R("Address Line 2", "Apt 5"), [ADDR]).answer === "Apt 5");
  check("an extension with its own value is untouched",
    guardInheritedAnswer(R("Phone Extension", "4021"), [PHONE]).answer === "4021");
  check("and its confidence is not downgraded",
    guardInheritedAnswer(R("Address Line 2", "Apt 5"), [ADDR]).confidence === "VERIFIED");
}

console.log("\n5. unrelated fields are never touched:");
{
  for (const label of ["City", "Postal Code", "First Name", "Email", "How Did You Hear About Us?"]) {
    check(`${label} is unaffected`, guardInheritedAnswer(R(label, "value"), [ADDR, PHONE]).answer === "value");
  }
}

console.log("\n6. blocked and empty resolutions pass through:");
{
  const blocked = { ...R("Address Line 2", ""), confidence: "BLOCKED" as any };
  check("a BLOCKED field stays blocked", guardInheritedAnswer(blocked, [ADDR]).confidence === "BLOCKED");
  check("an already-empty answer is unchanged",
    guardInheritedAnswer(R("Address Line 2", ""), [ADDR]).answer === "");
  check("no primaries means nothing to inherit",
    guardInheritedAnswer(R("Address Line 2", ADDR), []).answer === ADDR);
}

console.log("\n7. other spellings of the same trap:");
{
  for (const label of ["Apt", "Unit", "Suite", "Address 2"]) {
    check(`"${label}" echoing the street is blanked`,
      guardInheritedAnswer(R(label, ADDR), [ADDR]).answer === "");
  }
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("a second line is not a second copy of the first");
