/**
 * The public homepage keeps its promises.
 *
 * The page's rules are editorial, but the failures they prevent are
 * factual: an em dash, a category label, a figure from somebody else's
 * career, or a leak about what sits behind the public site. Grep-level
 * checks are exactly the right tool, because every one of these is a
 * string that must or must not exist.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
let n=0,bad=0; const ok=(c:boolean,w:string)=>{n++;if(!c){bad++;console.error(`FAIL ${w}`);}};

// The full story moved to _site/FullStory.tsx when the live page went
// minimal; the guard follows the content, and the minimal page is held
// to the same language rules.
const files = ["app/page.tsx",
  ...readdirSync("app/_site").filter((f) => f.endsWith(".tsx")).map((f) => `app/_site/${f}`)];
const all = files.map((f) => ({ f, text: readFileSync(f, "utf8") }));
const everywhere = all.map((x) => x.text).join("\n");

// ---- absolute language rules -----------------------------------------
for (const { f, text } of all) {
  ok(!text.includes("—"), `${f}: zero em dashes`);
}
const BANNED = [
  /generalist/i, /jack of all trades/i, /polymath/i, /multi-?hyphenate/i,
  /multidisciplinary/i, /renaissance man/i, /results-?driven/i,
  /passionate professional/i, /innovative thinker/i, /creative problem solver/i,
  /proven track record/i, /wears many hats/i, /at the intersection/i,
  /where creativity meets/i, /bringing ideas to life/i,
  /i can solve anything/i, /i can figure anything out/i,
];
for (const re of BANNED) ok(!re.test(everywhere), `banned phrase absent: ${re}`);

// ---- contamination from someone else's career ------------------------
for (const re of [/travel ?centers/i, /diesel/i, /87%/, /87 percent/i, /\$120K/i, /logistics coordinator/i]) {
  ok(!re.test(everywhere), `contaminated fact absent: ${re}`);
}

// ---- nothing about what sits behind the public page ------------------
for (const re of [/job discovery/i, /job matching/i, /application automation/i,
  /ai scoring/i, /evidence system/i, /authenticated portal/i, /private dashboard/i, /auto-?submit/i]) {
  ok(!re.test(everywhere), `private functionality unmentioned: ${re}`);
}

// ---- the confirmed figures are present, correctly worded -------------
const page = readFileSync("app/_site/FullStory.tsx", "utf8");
ok(page.includes("$70K"), "Genius Academy ARR appears");
ok(page.includes("180K"), "the email audience growth appears");
ok(page.includes("$68K"), "product sales appear");
ok(page.includes("250+"), "students taught appear");
ok(page.includes("21"), "RentPup users appear");
ok(page.includes("$1.2K"), "RentPup monthly revenue appears");
ok(!/ARR[^.]{0,30}RentPup|RentPup[^.]{0,80}ARR/i.test(everywhere), "RentPup revenue is never converted to ARR");
ok(page.includes("Śnieżka"), "Śnieżka is spelled correctly");
ok(!/languages spoken/i.test(everywhere), "music languages are never labelled as spoken");
ok(/SUNG IN|listen/i.test(everywhere), "the languages are framed as listening");

// ---- factual separations ---------------------------------------------
// "couch" may appear in alt text, where it accurately describes the
// photograph; the joke was the circled couch and its punchline heading.
ok(!/not the couch/i.test(page), "the couch punchline is gone");
ok(!/THE COUCH/.test(page), "and the circled-couch overlay with it");
const genius = page.slice(page.indexOf("Here"), page.indexOf("Other people"));
ok(/GENIUS ACADEMY/.test(genius) && !/Cleveland Clinic/.test(genius),
  "the production set is Genius Academy and never Cleveland Clinic");
ok(/Anytime|Contract production/i.test(page) ? page.indexOf("Contract production") > page.indexOf("GENIUS ACADEMY") : true,
  "Anytime Picture stays a separate beat from the Genius set");
ok(/Amazon/.test(page) && /Ohio State/.test(page) && /Saks Fifth Avenue/.test(page),
  "the confirmed clients appear");
ok(/three student employees|3 student employees/i.test(readFileSync("app/_site/Metrics.tsx", "utf8"))
  && /Lorain County/i.test(readFileSync("app/_site/Metrics.tsx", "utf8")),
  "supervision is attributed to LCCC, not Genius One");

// ---- structure promises ----------------------------------------------
ok(!existsSync("app/_site/CadWipe.tsx") && !page.includes("CadWipe"), "the CAD wipe is gone");
ok((page.match(/offset=\{\{/g) ?? []).length >= 8, "the offset block is the recurring photo language");
ok(page.includes("The subject changes.") && page.includes("curiosity doesn"), "the thesis is present");
ok(page.indexOf("comfortable not knowing") < page.indexOf("The subject changes."),
  "the comfort line lands before the thesis");
ok(page.indexOf("deepest rabbit hole") < page.indexOf("enough work stuff"),
  "RentPup is the professional climax, before the break");
// The thread labels rendered through Section's label prop; the thread
// survives, the taxonomy does not.
ok(!/label="(MADE|FIXED|WORK|GROWN|FOUND)"/.test(page), "the old thread labels are removed");

// The minimal live page keeps its own promises.
const mini = readFileSync("app/page.tsx", "utf8");
ok(mini.includes("figuring things out"), "the live page keeps the opening line");
ok(/relocating to Chicago/i.test(mini), "the live page says the move is in progress");
ok(mini.includes("linkedin.com/in/tylerpleban"), "the live page links LinkedIn");
ok(mini.includes("oneScreen"), "the live page is the one-screen layout");
// A comment may name the file; what must not exist is an import of it.
ok(!/import .*FullStory/.test(mini), "the live page does not route the full story");

console.log(`${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
