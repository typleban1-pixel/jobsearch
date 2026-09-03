/** An approximate degree is a false statement about a qualification. */
import { mapDegree, abbreviate, optionAbbreviations } from "../lib/workday/degree.ts";
let n=0,bad=0; const ok=(c:boolean,w:string)=>{n++;if(!c){bad++;console.error(`FAIL ${w}`);}};

// Northern Trust's real list.
const NT = ["Select One","Some College","Associate's (A.A., A.S., A.A.S.)","Bachelor's (B.A., B.S., B.B.A.)",
  "Master's (M.A., M.S., M.B.A.)","Juris Doctorate (J.D.)","Doctorate (D.B.A., Ed.D., Ph.D.)","Diploma",
  "Post-Graduate Diploma","Certificate"];

// ---- the two verified credentials ------------------------------------
{
  const b = mapDegree("Bachelor of Science", NT);
  ok(b.ok && b.option === "Bachelor's (B.A., B.S., B.B.A.)", `B.S. maps to the Bachelor's option (${JSON.stringify(b)})`);
  ok(b.ok && /B\.S\./.test(b.why), "and it says the option lists B.S.");
  const a = mapDegree("Associate of Arts", NT);
  ok(a.ok && a.option === "Associate's (A.A., A.S., A.A.S.)", "A.A. maps to the Associate's option");
}
ok(abbreviate("Bachelor of Science") === "B.S.", "Bachelor of Science abbreviates to B.S.");
ok(abbreviate("Associate of Arts") === "A.A.", "Associate of Arts abbreviates to A.A.");
ok(abbreviate("Some College") === "", "a non-credential abbreviates to nothing");
ok(optionAbbreviations("Bachelor's (B.A., B.S., B.B.A.)").length === 3, "an option's abbreviations are read from it");
ok(optionAbbreviations("Diploma").length === 0, "an option with no parenthesis claims none");

// ---- it fails closed --------------------------------------------------
{
  const m = mapDegree("Bachelor of Science", ["Select One"]);
  ok(!m.ok, "a list with only the placeholder maps nothing");
  const none = mapDegree("Bachelor of Science", ["Certificate","Diploma"]);
  ok(!none.ok, "a taxonomy without a bachelor's fails rather than approximating");
  ok(!none.ok && none.offered.length === 2, "and reports what was offered");
  ok(!mapDegree("Doctor of Philosophy", ["Certificate"]).ok, "no doctorate option fails");
  ok(!mapDegree("", NT).ok, "an empty credential maps nothing");
}
// Never widen: a master's must not become a bachelor's.
{
  const m = mapDegree("Master of Science", NT);
  ok(m.ok && m.option.startsWith("Master's"), "M.S. maps to Master's, never to Bachelor's");
  const j = mapDegree("Juris Doctor", NT);
  ok(j.ok && /Juris/.test(j.option), "J.D. maps to Juris Doctorate");
}
// Ambiguity is a stop.
{
  const dup = mapDegree("Bachelor of Science", ["Bachelor's (B.S.)","Undergrad (B.S.)"]);
  ok(!dup.ok, "two options listing the same abbreviation is a stop");
}
ok(!mapDegree("Associate of Arts", ["Bachelor's (B.A., B.S.)"]).ok,
   "an associate degree never maps to a bachelor's option");

console.log(`${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
