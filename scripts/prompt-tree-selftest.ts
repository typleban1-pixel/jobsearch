/**
 * A category is not an answer. These are the real Northern Trust levels.
 */
import { classifyOption, chooseOption, nextStep, parseOptionPath, formatOptionPath, NO_METADATA, type OptionNode }
  from "../lib/workday/prompt.ts";
let n=0,bad=0; const ok=(c:boolean,w:string)=>{n++;if(!c){bad++;console.error(`FAIL ${w}`);}};

const branch = (label: string): OptionNode => ({ label, instanceId: NO_METADATA, hasSideCharm: true });
const leaf = (label: string, id = "abc123"): OptionNode => ({ label, instanceId: id, hasSideCharm: false });

// The live first level: eight categories, none selectable.
const LEVEL1 = ["Career Fair","Job Board","Newspapers","Northern Trust Web Site",
  "Professional Associations","Referral","Social Network","University Recruiting"].map(branch);
const LEVEL2 = [leaf("Careers Web Site")];

// ---- 1. leaf vs branch comes from the employer's own markup ----------
for (const b of LEVEL1) ok(classifyOption(b) === "BRANCH", `${b.label} is a category, not an answer`);
ok(classifyOption(LEVEL2[0]!) === "LEAF", "Careers Web Site is selectable");
ok(classifyOption({ label: "x", instanceId: null, hasSideCharm: false }) === "BRANCH",
   "a node with no instance id is never treated as selectable");

// ---- 2. the path decides ---------------------------------------------
{
  const s = nextStep(LEVEL1, ["Northern Trust Web Site", "Careers Web Site"]);
  ok(s.action === "DESCEND" && s.label === "Northern Trust Web Site", "a category is opened, not chosen");
  const s2 = nextStep(LEVEL2, ["Careers Web Site"]);
  ok(s2.action === "SELECT" && s2.label === "Careers Web Site", "the leaf is chosen");
}
// Naming only the category must never select it.
{
  const s = nextStep(LEVEL1, ["Northern Trust Web Site"]);
  ok(s.action === "DESCEND", "naming a category alone opens it rather than answering with it");
}
// One leaf below is unambiguous; several are not.
{
  ok(nextStep(LEVEL2, []).action === "SELECT", "a single leaf needs no further instruction");
  const many = nextStep([leaf("A","1"), leaf("B","2")], []);
  ok(many.action === "STOP", "two leaves without instruction is a stop, not a guess");
  ok(many.action === "STOP" && /does not say which/.test(many.why), "and it says why");
}
// A level of only categories with nothing left to say is a stop.
{
  const s = nextStep(LEVEL1, []);
  ok(s.action === "STOP", "all-categories with no path is a stop");
  ok(s.action === "STOP" && s.offered.length === 8, "and reports every option offered");
}

// ---- 3. matching is exact --------------------------------------------
ok(!chooseOption(LEVEL1, "Web Site").ok, "a substring never matches an option");
ok(!chooseOption(LEVEL1, "northern trust web").ok, "a prefix never matches an option");
ok(chooseOption(LEVEL1, "northern trust web site").ok, "case does not matter");
ok(!chooseOption(LEVEL1, "").ok, "an empty answer matches nothing");
ok(!chooseOption([], "Referral").ok, "an empty level matches nothing");
{
  const dupe = chooseOption([branch("Referral"), leaf("Referral","9")], "Referral");
  ok(!dupe.ok, "two identically labelled options is an ambiguity, not a tie to break");
}
ok(nextStep(LEVEL1, ["Nope"]).action === "STOP", "an unknown name stops");
ok((nextStep(LEVEL1, ["Nope"]) as any).offered.length === 8, "and lists what was actually offered");

// ---- 4. paths round-trip ---------------------------------------------
ok(JSON.stringify(parseOptionPath("Northern Trust Web Site > Careers Web Site"))
   === JSON.stringify(["Northern Trust Web Site","Careers Web Site"]), "a path splits on >");
ok(parseOptionPath("Careers Web Site").length === 1, "a bare leaf is a one-step path");
ok(parseOptionPath("").length === 0, "an empty answer is an empty path");
ok(formatOptionPath(["A","B"]) === "A > B", "a path formats back");
ok(JSON.stringify(parseOptionPath("  A  >  B  ")) === JSON.stringify(["A","B"]), "whitespace is trimmed");

console.log(`${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
