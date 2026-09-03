/** Typed text is a query. Only the committed list is evidence. */
import { chooseSkill, isCommitted, type SkillResult } from "../lib/workday/skillPicker.ts";
let n=0,bad=0; const ok=(c:boolean,w:string)=>{n++;if(!c){bad++;console.error(`FAIL ${w}`);}};
const R = (...labels: string[]): SkillResult[] => labels.map((l) => ({ label: l, checked: false }));

// ---- an exact result is chosen ---------------------------------------
{
  const c = chooseSkill(R("Microsoft Excel","Microsoft Word","Microsoft Project"), "Microsoft Excel");
  ok(c.ok && c.label === "Microsoft Excel", "the exact skill is chosen from a crowded result set");
}
ok(chooseSkill(R("microsoft excel"), "Microsoft Excel").ok, "case does not matter");
ok(chooseSkill(R("Cross Department Collaboration"), "Cross-department collaboration").ok,
   "the same words punctuated differently are the same skill");

// ---- never a near miss ------------------------------------------------
{
  const c = chooseSkill(R("Project Finance","Project Accounting","Projector Setup"), "Project");
  ok(!c.ok, "a bare term never selects a longer skill");
  ok(!c.ok && c.offered.length === 3, "and the real results are reported");
}
ok(!chooseSkill(R("Microsoft Excel"), "Excel").ok, "a substring never matches");
ok(!chooseSkill(R("Google Analytics 4"), "Google Analytics").ok, "a versioned variant is not the same skill");
ok(!chooseSkill(R("Data Analytics"), "Google Analytics").ok, "a different skill is refused");
ok(!chooseSkill(R("M-SIM","M-Code","MXML"), "Microsoft Excel").ok,
   "fuzzy noise from a partial query selects nothing");
ok(!chooseSkill([], "Microsoft Excel").ok, "no results selects nothing");
ok(!chooseSkill(R("No Items."), "Microsoft Excel").ok, "the empty-state row is not a skill");

// ---- ambiguity stops --------------------------------------------------
{
  const c = chooseSkill(R("Microsoft Excel","Microsoft Excel"), "Microsoft Excel");
  ok(!c.ok, "two identical results is an ambiguity, not a tie to break");
}

// ---- commitment is read from the committed list -----------------------
ok(isCommitted(["Microsoft Excel"], "Microsoft Excel"), "a committed skill is recognised");
ok(!isCommitted([], "Microsoft Excel"), "an empty committed list is never a success");
ok(!isCommitted(["Microsoft Word"], "Microsoft Excel"), "a different committed skill is not it");
ok(isCommitted(["  microsoft   excel "], "Microsoft Excel"), "whitespace and case do not hide a commitment");

// ---- sequential searches can never concatenate ------------------------
// The live bug: "PM" then "MG" became "PMMG" because the box never
// cleared and the widget ignored further keystrokes.
import { beginSearch, confirmTyped } from "../lib/workday/skillPicker.ts";
{
  ok(beginSearch("", "Program Management").ok, "a clean box starts a search");
  const dirty = beginSearch("PM", "Management");
  ok(!dirty.ok, "a box that still holds the previous query refuses to search");
  ok(!dirty.ok && /still held/.test(dirty.why), "and says the box was not clear");
}
{
  // Even if clearing appeared to work, the typed value is re-read.
  ok(confirmTyped("Program Management", "Program Management").ok, "the intended term is confirmed");
  const c = confirmTyped("PMMG", "MG");
  ok(!c.ok, "a concatenated box never proceeds to Enter");
  ok(!c.ok && /PMMG/.test(c.why), "and the actual contents are reported");
  ok(!confirmTyped("Program", "Program Management").ok, "a truncated query does not proceed");
  ok(!confirmTyped("", "Program Management").ok, "an empty box after typing does not proceed");
}
// Opaque abbreviations are refused as search terms outright.
for (const junk of ["PMMG", "PM", "MG", "ABC"]) {
  ok(!beginSearch("", junk).ok, `${junk} is refused as a search term`);
}
for (const real of ["Program Management", "Project Management", "Operations", "Analytics", "Process Improvement"]) {
  ok(beginSearch("", real).ok, `${real} is a valid search term`);
}
ok(!beginSearch("", "").ok, "an empty term is refused");
ok(!beginSearch("", "   ").ok, "a whitespace term is refused");

console.log(`${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
