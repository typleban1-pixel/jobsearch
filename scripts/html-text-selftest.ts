/**
 * htmlToText, and specifically what must survive it.
 *
 * Descriptions are the only input the requirement extractor sees, so a
 * character silently eaten here becomes a requirement the posting never
 * appeared to make.
 */
import { htmlToText } from "../lib/ingest/normalize/text.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

// A decoded "<" is not the start of a tag.
//
// Entities must be decoded before tags are stripped, because Greenhouse
// double-encodes its markup. That leaves any posting which wrote
// "&lt; 2 years" holding a literal "<" in prose. Stripping /<[^>]+>/
// then deleted everything up to the next ">" anywhere later in the
// document. UChicago's Research Technician lost its whole minimum
// work-experience line and reached candidacy with a bachelor's degree
// as its only stated requirement.
{
  const html = "<p>Minimum requirements include knowledge and skills developed through "
    + "&lt; 2 years of work experience in a related job discipline.</p>"
    + "<p style=\"text-align:left\"><br /><b>Certifications:</b></p>";
  const t = htmlToText(html);
  check("text after a decoded < survives", t.includes("2 years of work experience in a related job discipline"), t);
  check("and the sentence is not truncated at the <", !/developed through\s*$/m.test(t), t);
  check("and later markup is still stripped", !t.includes("<p") && !t.includes("<b>"), t);
}

{
  const t = htmlToText("<p>Travel &lt; 10% of the time</p>");
  check("a < percentage survives", t === "Travel < 10% of the time", t);
}

{
  const t = htmlToText("<p>Requires &gt; 5 years experience</p>");
  check("a > figure survives", t === "Requires > 5 years experience", t);
}

// The reason decoding runs first. Do not regress it.
{
  const t = htmlToText("&lt;p&gt;Double encoded &lt;b&gt;markup&lt;/b&gt; still strips&lt;/p&gt;");
  check("double-encoded markup is still stripped", t === "Double encoded markup still strips", t);
}

{
  const t = htmlToText("<div><ul><li>First</li><li>Second</li></ul></div>");
  check("list markup still becomes list text", t.includes("- First") && t.includes("- Second"), t);
}

{
  const t = htmlToText("<script>var x = 1 < 2;</script><p>Body</p>");
  check("script contents are dropped", t === "Body", t);
}

// Math and comparisons in prose, the general case.
{
  const t = htmlToText("<p>Salary band a &lt; b &lt; c applies</p>");
  check("repeated < in prose all survive", t === "Salary band a < b < c applies", t);
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
