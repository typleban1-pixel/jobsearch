/**
 * Demographic fields are matched to the employer's vocabulary: exact,
 * then a standard synonym, then the form's decline option. Never a guess
 * about identity, and never for a non-demographic field.
 */
import { isDemographicField, resolveEeoOption } from "../lib/browser/eeo.ts";
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

console.log(`${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
