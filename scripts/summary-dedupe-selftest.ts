/**
 * A summary must not repeat an experience bullet word for word.
 *
 * Popl's tailored resume ended its summary with a sentence that appeared
 * again, verbatim, as a bullet under Genius One. The renderer refused the
 * document. The fix removes the summary sentence and keeps the bullet,
 * because the bullet is the line attached to the employment record and
 * its evidence.
 *
 * The rule is exact repetition and nothing else. Claims that merely
 * resemble each other operate at different altitudes - a summary
 * generalizes, a bullet evidences - and deleting one for resembling the
 * other would remove something deliberate.
 */
import { dropSummarySentencesDuplicatedInBullets } from "../lib/render/tailoredDoc.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

const line = (text: string) => ({ text, sources: ["e1"] });
const role = (...texts: string[]) => ({
  employer: "Genius One, Inc.", title: "Specialist", location: null,
  start: "2019-01-01", end: null, startPrecision: "MONTH", endPrecision: "MONTH",
  lines: texts.map(line),
} as any);

// The exact Popl failure.
const POPL_BULLET = "Designed marketing emails and built and managed segmented email marketing "
  + "funnels for an audience of approximately 100,000 contacts.";
{
  const summary = line(
    "Cross-functional marketing, operations, and creative production professional who takes "
    + "loosely defined objectives from idea through implementation. Work spanning marketing, "
    + "ecommerce, operations, and program coordination. " + POPL_BULLET);
  const r = dropSummarySentencesDuplicatedInBullets(summary, [role(POPL_BULLET, "Executed digital marketing.")]);
  check("the duplicated sentence is removed from the summary", r.removed.length === 1, JSON.stringify(r.removed));
  check("and it is the Popl sentence", r.removed[0]!.includes("segmented email marketing funnels"), "");
  check("the summary no longer contains it", !r.summary.text.includes("segmented email marketing funnels"), r.summary.text);
  check("the rest of the summary survives intact",
    r.summary.text.includes("Cross-functional marketing") && r.summary.text.includes("Work spanning marketing"), r.summary.text);
  check("the remaining summary is not incomplete", r.incomplete === false, "");
  check("the summary keeps its sources", JSON.stringify(r.summary.sources) === JSON.stringify(["e1"]), "");
}

// The bullet is what survives.
{
  const summary = line("A first sentence about operations work. " + POPL_BULLET);
  const roles = [role(POPL_BULLET)];
  const r = dropSummarySentencesDuplicatedInBullets(summary, roles);
  check("the evidence-bearing bullet is untouched", roles[0]!.lines.length === 1
    && roles[0]!.lines[0]!.text === POPL_BULLET, "");
  check("only the summary side is changed", !r.summary.text.includes("segmented email"), r.summary.text);
}

// Similar but not identical must survive, in both directions.
{
  const bullet = "Designed marketing emails and built segmented funnels for about 100,000 contacts.";
  const summaryText = "Designed marketing emails and built and managed segmented email marketing "
    + "funnels for an audience of approximately 100,000 contacts.";
  const r = dropSummarySentencesDuplicatedInBullets(line("Opening sentence here about work. " + summaryText), [role(bullet)]);
  check("a paraphrase is NOT removed", r.removed.length === 0, JSON.stringify(r.removed));
  check("and the summary is returned untouched", r.summary.text.includes("approximately 100,000 contacts"), "");
}
{
  const bullet = "Taught and mentored 250+ students.";
  const r = dropSummarySentencesDuplicatedInBullets(
    line("Taught and mentored students across three years of instruction. Second sentence about operations."),
    [role(bullet)]);
  check("a shorter related claim is NOT removed", r.removed.length === 0, JSON.stringify(r.removed));
}
{
  // Substring, not a whole sentence: must not match.
  const r = dropSummarySentencesDuplicatedInBullets(
    line("Executed digital marketing and ecommerce initiatives across websites and SEO for company priorities."),
    [role("Executed digital marketing.")]);
  check("a bullet that is only a fragment of a summary sentence is NOT removed", r.removed.length === 0, "");
}

// Case and spacing are presentation, not meaning.
{
  const r = dropSummarySentencesDuplicatedInBullets(
    line("A leading sentence about operations work.  DESIGNED   marketing emails and built and managed "
      + "segmented email marketing funnels for an audience of approximately 100,000 contacts."),
    [role(POPL_BULLET)]);
  check("case and spacing differences still count as verbatim", r.removed.length === 1, JSON.stringify(r.removed));
}

// Short connective sentences are not substantive claims.
{
  const r = dropSummarySentencesDuplicatedInBullets(
    line("Marketing and operations. A second substantive sentence about program coordination work."),
    [role("Marketing and operations.")]);
  check("a short sentence is left alone", r.removed.length === 0, JSON.stringify(r.removed));
}

// Structural incompleteness is refused, never patched.
{
  const r = dropSummarySentencesDuplicatedInBullets(line(POPL_BULLET), [role(POPL_BULLET)]);
  check("a summary that was only the duplicate is flagged incomplete", r.incomplete === true, "");
  check("and no replacement prose is invented", r.summary.text.trim() === "", JSON.stringify(r.summary.text));
}
{
  const r = dropSummarySentencesDuplicatedInBullets(
    line("Short lead. " + POPL_BULLET), [role(POPL_BULLET)]);
  check("a fragment left behind is also flagged incomplete", r.incomplete === true, r.summary.text);
}

// Projects count as experience too.
{
  const project = { name: "RentPup", line: line(POPL_BULLET), optional: [] } as any;
  const r = dropSummarySentencesDuplicatedInBullets(
    line("A leading sentence about product work here. " + POPL_BULLET), [], [project]);
  check("a project line also counts as a duplicate source", r.removed.length === 1, "");
}

// Nothing changes when there is no duplication at all.
{
  const summary = line("Cross-functional marketing and operations professional. Work spanning ecommerce and coordination.");
  const r = dropSummarySentencesDuplicatedInBullets(summary, [role("Executed digital marketing and ecommerce work.")]);
  check("a clean document is returned unchanged", r.summary === summary && r.removed.length === 0, "");
  check("and is never flagged incomplete", r.incomplete === false, "");
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
