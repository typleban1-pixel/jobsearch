/**
 * Demographic fields are matched to the employer's vocabulary: exact,
 * then a standard synonym, then the form's decline option. Never a guess
 * about identity, and never for a non-demographic field.
 */
import { isDemographicField, isDisabilityField, resolveEeoOption } from "../lib/browser/eeo.ts";
let n=0,bad=0; const ok=(c:boolean,w:string)=>{n++;if(!c){bad++;console.error(`FAIL ${w}`);}};

// ---- recognising demographic fields ----------------------------------
for (const l of ["How do you identify? (gender identity)", "Gender", "Race/Ethnicity",
  "If you are based in the US, what is your veteran status?", "Do you have a disability?",
  "How do you identify? (race/ethnicity)"])
  ok(isDemographicField(l), `demographic: ${l.slice(0,40)}`);
for (const l of ["First Name", "Phone", "Location (City)", "Most Recent Employer",
  "Are you authorized to work in the US?", "Have you previously worked at Samsara?"])
  ok(!isDemographicField(l), `NOT demographic: ${l}`);

// ---- the exact Samsara case: Male -> Man -----------------------------
const SAMSARA_GENDER = ["Agender","Cis-man","Cis-woman","Gender Fluid","Genderqueer","Man","Woman","I don't wish to answer"];
{
  const c = resolveEeoOption("Male", SAMSARA_GENDER);
  ok(c.kind === "SYNONYM" && c.option === "Man", `Male maps to Man (${JSON.stringify(c)})`);
}
ok(resolveEeoOption("Female", SAMSARA_GENDER).kind === "SYNONYM", "Female maps to a synonym");
{
  const c = resolveEeoOption("Man", SAMSARA_GENDER);
  ok(c.kind === "EXACT" && c.option === "Man", "an exact answer stays exact");
}

// ---- decline when nothing fits ---------------------------------------
{
  const c = resolveEeoOption("Two-Spirit", SAMSARA_GENDER);
  ok(c.kind === "DECLINE" && /wish to answer/i.test(c.option), `an unmapped answer declines (${JSON.stringify(c)})`);
}
{
  // A form with no decline option and no match yields NONE (fails closed).
  const c = resolveEeoOption("Nonbinary", ["Man", "Woman"]);
  ok(c.kind === "NONE", "no synonym and no decline option is NONE, not a guess");
}

// ---- race exact match, then decline ----------------------------------
const RACE = ["White","Black or African American","Asian","Hispanic or Latino","Two or More Races","I don't wish to answer"];
ok(resolveEeoOption("White", RACE).kind === "EXACT", "White matches White exactly");
ok(resolveEeoOption("Klingon", RACE).kind === "DECLINE", "an unlisted race declines");

// ---- never invents an identity: synonyms are only the standard pair --
{
  // "Man" must never be offered as a match for "Woman" or vice versa.
  const c = resolveEeoOption("Male", ["Woman", "Nonbinary", "I decline to self-identify"]);
  ok(c.kind === "DECLINE", "Male never maps to Woman; it declines when Man is absent");
}

// ---- disability: the truthful No is chosen, never a needless decline -
//
// The stored answer states the fact. When the form's No is worded
// differently it must still be picked over the decline option, because
// declining would refuse a question the person answered.
const DIS_LABEL = "Do you have a physical or mental disability, impairment, or condition that substantially limits major life activity?";
const STORED_NO = "No, I do not have a disability and have not had one in the past";

ok(isDisabilityField(DIS_LABEL), "the disability question is recognised as a disability field");
ok(!isDisabilityField("How do you identify? (gender identity)"), "gender is not a disability field");

{ // bare Yes/No/decline: No is chosen, not the decline
  const c = resolveEeoOption(STORED_NO, ["Yes", "No", "I don't wish to answer"], DIS_LABEL);
  ok(c.kind === "SYNONYM" && c.option === "No", `stored No maps to the bare "No" (${JSON.stringify(c)})`);
}
{ // a differently-worded No is still a No, not a decline
  const c = resolveEeoOption(STORED_NO, ["Yes, I have a disability, or have had one in the past",
    "No, I don't have a disability", "I do not wish to answer"], DIS_LABEL);
  ok(c.kind === "SYNONYM" && /^No,/.test(c.option), `stored No maps to a reworded No (${JSON.stringify(c)})`);
}
{ // the exact federal wording still matches exactly
  const c = resolveEeoOption(STORED_NO, [STORED_NO, "Yes, I have a disability, or have had one in the past", "I don't wish to answer"], DIS_LABEL);
  ok(c.kind === "EXACT", "the exact federal No still matches exactly");
}
{ // a Yes answer maps to the Yes option
  const c = resolveEeoOption("Yes, I have a disability", ["Yes", "No", "I don't wish to answer"], DIS_LABEL);
  ok(c.kind === "SYNONYM" && c.option === "Yes", `a Yes answer maps to Yes (${JSON.stringify(c)})`);
}
{ // a decline-worded answer has no polarity, so it declines, never a pole
  const c = resolveEeoOption("Prefer not to say", ["Yes", "No", "I don't wish to answer"], DIS_LABEL);
  ok(c.kind === "DECLINE" && /wish to answer/i.test(c.option), `a decline answer stays a decline (${JSON.stringify(c)})`);
}
{ // no same-polarity option exists: falls through safely to decline
  const c = resolveEeoOption(STORED_NO, ["Yes", "I don't wish to answer"], DIS_LABEL);
  ok(c.kind === "DECLINE", "with no No option offered, it declines rather than guessing");
}
{ // the disability mapping is gated on the field: without the label, the
  // stored No does not exact-match a bare "No" and there is no synonym,
  // so a non-disability context declines (proving the gate).
  const c = resolveEeoOption(STORED_NO, ["Yes", "No", "I don't wish to answer"]);
  ok(c.kind === "DECLINE", "outside a disability field the polarity mapping does not fire");
}
{ // two No-polarity options and no exact match: it refuses to pick one
  const c = resolveEeoOption(STORED_NO, ["Yes", "No", "No, I don't have a disability"], DIS_LABEL);
  // Requires exactly one same-polarity option; two => skip the mapping.
  // No decline option here either, so NONE (fails closed, never guesses).
  ok(c.kind === "NONE", `two same-polarity options and no decline fails closed (${JSON.stringify(c)})`);
}

console.log(`${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
