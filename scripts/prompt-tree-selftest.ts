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

// ---- 1b. the same answer in the tenant's wording ----------------------
{
  const s = nextStep(LEVEL1, ["Company website"]);
  ok(s.action === "DESCEND" && s.label === "Northern Trust Web Site" && s.viaPath,
     "the generic sourcing answer opens the employer's own web-site category");
  const s2 = nextStep(LEVEL2, []);
  ok(s2.action === "SELECT" && s2.label === "Careers Web Site" && !s2.viaPath, "and the single leaf below it is chosen");
  const fair = nextStep([branch("Career Fair"), branch("Referral")], ["Company website"]);
  ok(fair.action === "STOP", "with no web-site option offered, the generic answer is not forced onto a specific channel");
  const jb = nextStep(LEVEL1, ["Job Board"]);
  ok(jb.action === "DESCEND" && jb.label === "Job Board", "an exact label still wins, unchanged");
}
// ---- 1c. listbox labels, matched the same way --------------------------
{
  const { matchOptionLabel } = await import("../lib/workday/optionMatch.ts");
  const us = matchOptionLabel(["United States of America (+1)", "United States of America (+1)", "Canada (+1)"], "US");
  ok(us.ok && us.label === "United States of America (+1)", "US matches the country however it is qualified, and a duplicate reading is one option");
  const usa = matchOptionLabel(["United States of America", "United Kingdom"], "US");
  ok(usa.ok && usa.label === "United States of America", "US matches United States of America");
  const oh = matchOptionLabel(["Ohio", "Oklahoma"], "OH");
  ok(oh.ok && oh.label === "Ohio", "a state abbreviation matches its name");
  const web = matchOptionLabel(LEVEL1.map((o) => o.label), "Company website");
  ok(web.ok && web.label === "Northern Trust Web Site", "the generic sourcing answer picks the employer's web site");
  const none = matchOptionLabel(["Career Fair", "Referral", "University Recruiting"], "Company website");
  ok(!none.ok, "and refuses when only specific channels are offered");
  const eeo = matchOptionLabel(["Yes", "No"], "Not Hispanic or Latino");
  ok(eeo.ok && eeo.label === "No", "a spelled-out negative answers a Yes/No control as No");
  const amb = matchOptionLabel(["Ohio", "Ohio (North)", "Ohio (South)"], "Ohio");
  ok(amb.ok && amb.label === "Ohio", "an exact label wins over qualified variants");
  const two = matchOptionLabel(["Fax", "Landline", "Mobile"], "216-555-0100");
  ok(!two.ok && two.hits.length === 0, "a value that is none of the options matches nothing");
}
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
  const lone = nextStep([branch("Careers Web Site")], []);
  ok(lone.action === "SELECT" && lone.label === "Careers Web Site", "a single option under the chosen category is taken even when its markup calls it a category");
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
