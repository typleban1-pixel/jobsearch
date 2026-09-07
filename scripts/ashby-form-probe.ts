/**
 * What discovery sees on an Ashby application form, before any grouping.
 *
 *   node --env-file=.env.local scripts/ashby-form-probe.ts <apply-url>
 *
 * A read-only diagnostic. Opens the apply page headless, reveals the form
 * and prints, side by side: the raw choice fieldsets (question text, each
 * option's control type, name and label), the button groups, the combobox
 * questions, and the generic field list after the shared Ashby
 * normalization -- exactly what preparation would store. Nothing is typed,
 * nothing is uploaded, nothing is clicked except "Apply for this job".
 */
import { launchBrowser, newPreparedPage } from "../lib/browser/launch.ts";
import { snapshotLive } from "../lib/browser/liveSnapshot.ts";
import {
  revealAshbyForm, readChoiceFieldsets, groupAshbyChoices, mergeChoiceGroups, dropFileHeaderArtifacts,
  readAshbyComboboxes, readAshbyButtonGroups, normalizeAshbyFields,
} from "../lib/browser/ashbyForm.ts";

const url = process.argv[2];
if (!url) { console.error("usage: ashby-form-probe.ts <apply-url>"); process.exit(2); }
const browser = await launchBrowser();
try {
  const page = await newPreparedPage(browser, { viewport: { width: 1440, height: 1000 } });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2500);
  await revealAshbyForm(page);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(800);

  console.log("== choice fieldsets (raw)");
  const fieldsets = await readChoiceFieldsets(page);
  for (const fs of fieldsets) {
    console.log(`  Q: ${JSON.stringify(fs.questionText)}`);
    for (const i of fs.inputs) console.log(`     ${i.kind.padEnd(8)} ${i.required ? "REQ" : "   "} ${i.name.slice(0, 24)}…  ${JSON.stringify(i.label)}`);
  }
  console.log("== button groups");
  for (const g of await readAshbyButtonGroups(page)) console.log(`  ${JSON.stringify(g.label)}  [${g.options.join(" | ")}]`);
  console.log("== combobox questions");
  for (const q of await readAshbyComboboxes(page)) console.log(`  ${JSON.stringify(q)}`);

  const raw = await snapshotLive(page.mainFrame());
  console.log(`== generic fields, raw (${raw.fields.length})`);
  for (const f of raw.fields) console.log(`  ${String(f.type).padEnd(8)} ${f.required ? "REQ" : "   "} ${(f.htmlType ?? "").padEnd(10)} key=${JSON.stringify(f.key).slice(0, 50)} label=${JSON.stringify(f.label).slice(0, 60)} name=${JSON.stringify(f.name ?? null)}`);

  const fields = await normalizeAshbyFields(page, raw.fields);
  console.log(`== after Ashby normalization (${fields.length})`);
  for (const f of fields) console.log(`  ${String(f.type).padEnd(8)} ${f.required ? "REQ" : "   "} ${(f.htmlType ?? "").padEnd(18)} ${JSON.stringify(f.label).slice(0, 70)}${f.options?.length ? `  opts: ${f.options.join(" | ").slice(0, 120)}` : ""}`);
} finally {
  await browser.close();
}
