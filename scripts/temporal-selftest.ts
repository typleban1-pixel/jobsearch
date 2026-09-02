/**
 * A date governing a list, and what may be said under it.
 *
 * The construction is general: "since YEAR", "YEAR to present", "over N
 * years", "N+ years", each followed by an enumeration. What is tested is
 * the rule, not the one summary that exposed it.
 */
import { checkTemporalScope, governedItems, type DatedSource } from "../lib/render/temporalScope.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}\n         ${d}`); }
};
const src = (id: string, text: string, start: string | null, end: string | null = null): DatedSource => ({ id, text, start, end });

// A profile in miniature: teaching and video from 2016, ecommerce and
// product from 2019, an undated skill row.
const OLD = src("lccc", "Video Production Lab Instructor. Taught students, coordinated cross-department projects and video production.", "2016-01-01", "2019-01-01");
const NEW = src("g1", "Executed digital marketing, ecommerce and email marketing work. Designed and prototyped physical products.", "2019-01-01", null);
const UNDATED = src("skill", "Workflow automation and process improvement", null);

// ---- the real failure -------------------------------------------------
{
  const v = checkTemporalScope(
    "Experience since 2016 spanning ecommerce and email marketing, physical product development, program and project coordination, and video production.",
    [OLD, NEW]);
  check("a date is refused over items that started later", v.length > 0, JSON.stringify(v.map((x) => x.item)));
  check("and it names the item and the year it actually starts",
    v.some((x) => /ecommerce/i.test(x.item) && x.earliestSupport === 2019), JSON.stringify(v));
  check("items that DO reach back are not flagged",
    !v.some((x) => /video production/i.test(x.item)), JSON.stringify(v.map((x) => x.item)));
}
// ---- valid constructions pass ----------------------------------------
{
  const v = checkTemporalScope("Experience since 2016 spanning video production, teaching, and project coordination.", [OLD]);
  check("a date holding for every item passes", v.length === 0, JSON.stringify(v));
}
{
  const v = checkTemporalScope("Experience since 2019 spanning ecommerce, email marketing, and physical product development.", [NEW]);
  check("a correctly narrowed date passes", v.length === 0, JSON.stringify(v));
}
{
  const v = checkTemporalScope("Delivered ecommerce and email marketing work.", [NEW]);
  check("a list with no date is not the check's business", v.length === 0, JSON.stringify(v));
}
{
  const v = checkTemporalScope("In 2021 launched an ecommerce storefront and an email programme.", [NEW]);
  check("a date that reports one event governs nothing", v.length === 0, JSON.stringify(v));
}
{
  const v = checkTemporalScope("Experience since 2016 in video production.", [OLD]);
  check("a single item is not an enumeration", v.length === 0, JSON.stringify(v));
}
{
  const v = checkTemporalScope("Experience since 2016 spanning video production, teaching, and workflow automation.", [OLD, UNDATED]);
  check("a row with no start date cannot create a violation", v.length === 0, JSON.stringify(v));
}
// ---- the other anchor forms ------------------------------------------
{
  const v = checkTemporalScope("2016 to present, covering ecommerce, email marketing, and video production.", [OLD, NEW]);
  check("\"YEAR to present\" is an anchor", v.some((x) => /ecommerce/i.test(x.item)), JSON.stringify(v));
}
{
  const thisYear = new Date().getUTCFullYear();
  const v = checkTemporalScope(`Over ${thisYear - 2016} years spanning ecommerce, email marketing, and video production.`, [OLD, NEW]);
  check("\"over N years\" is an anchor", v.some((x) => /ecommerce/i.test(x.item)), JSON.stringify(v));
  const ok = checkTemporalScope(`Over ${thisYear - 2019} years spanning ecommerce, email marketing, and physical product development.`, [NEW]);
  check("and a correctly sized N passes", ok.length === 0, JSON.stringify(ok));
}
// ---- an item nothing supports ----------------------------------------
{
  // Deliberately NOT this check's business. Whether an item is supported
  // at all is auditClaim's question, against the same rows, and lexical
  // matching here would refuse true lines over irregular verbs.
  const v = checkTemporalScope("Experience since 2016 spanning video production, teaching, and litigation support.", [OLD]);
  check("an item no cited row mentions yields no temporal opinion", v.length === 0, JSON.stringify(v));
}
// ---- parsing ----------------------------------------------------------
{
  const items = governedItems("Experience since 2016 spanning ecommerce and email marketing, physical product development, and video production.", 11);
  check("the enumeration splits on commas and 'and'", items.length >= 3, JSON.stringify(items));
  check("no fragment is empty of subject matter", items.every((i) => i.trim().length > 3), JSON.stringify(items));
}
{
  const v = checkTemporalScope("Experience since 2016 spanning video production and teaching. Separately, ecommerce work followed.", [OLD, NEW]);
  check("the anchor does not reach past its own sentence", v.length === 0, JSON.stringify(v));
}
// ---- stemming ---------------------------------------------------------
{
  const v = checkTemporalScope("Experience since 2016 spanning video production, coordination, and teaching.", [OLD]);
  check("an item matches a row through a shared stem", v.length === 0, JSON.stringify(v));
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
