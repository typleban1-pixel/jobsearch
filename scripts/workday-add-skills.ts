/**
 * Adds skills through Workday's search-and-check picker.
 *
 * Search, Enter, read the results, check exactly one, verify it appears
 * in the committed list, then clear the query before the next term.
 */
import { chromium } from "playwright";
import { chooseSkill, isCommitted, beginSearch, confirmTyped } from "../lib/workday/skillPicker.ts";

/**
 * Plain-English skill names only, one complete phrase per search.
 *
 * Never an abbreviation or an initialism: those are what concatenated
 * fragments look like, and searching for one cannot find a real skill.
 */
const CANDIDATES: { term: string; evidence: string }[] = [
  { term: "Program Management", evidence: "coordinated a college-industry collaboration with 10+ deliverables (LCCC)" },
  { term: "Project Management", evidence: "resume skill group: Operations and process (Project coordination)" },
  { term: "Process Improvement", evidence: "configured automated Asana workflows across teams (Holley)" },
  { term: "Operations", evidence: "Digital Marketing, Product & Operations Specialist (Genius One)" },
  { term: "Analytics", evidence: "resume skill group: Marketing and ecommerce (Google Analytics)" },
  { term: "Marketing", evidence: "executed digital marketing and ecommerce work (Genius One)" },
];

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = b.contexts()[0]!.pages().filter((p: any) => !p.url().startsWith("about:"))[0]!;
page.setDefaultTimeout(30_000);

const fld = page.locator('[data-automation-id="formField-skills"]').first();
if (!(await fld.count().catch(() => 0))) { console.error("no skills control on this page"); await b.close(); process.exit(1); }
await fld.scrollIntoViewIfNeeded().catch(() => undefined);

const committed = async (): Promise<string[]> => await page.evaluate(() => {
  const f = document.querySelector('[data-automation-id="formField-skills"]');
  return [...(f?.querySelectorAll('[data-automation-id="selectedItem"]') ?? [])]
    .map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim()).filter(Boolean);
});

const readResults = async () => await page.evaluate(() => {
  const c = document.querySelector('[data-automation-id="activeListContainer"]');
  if (!c) return [];
  return [...c.querySelectorAll('[data-automation-id="menuItem"]')]
    .filter((e) => e.getClientRects().length > 0)
    .map((e) => ({ label: (e as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
                   checked: e.querySelector('[data-automation-checked="Checked"]') !== null }))
    .filter((r) => r.label && !/^no items\.?$/i.test(r.label));
});

const added: { skill: string; evidence: string }[] = [];
const skipped: { skill: string; why: string; offered: number }[] = [];

for (const c of CANDIDATES) {
  const input = fld.locator("input").first();
  const value = async () => String(await input.inputValue().catch(() => ""));

  await input.click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  const before = await value();
  /**
   * fill(""), not a keyboard shortcut.
   *
   * Control+A moves the caret to the start of the line on this platform
   * rather than selecting, and this widget then ignores further
   * keystrokes entirely: typing "PM", clearing, and typing "MG" left the
   * box holding "PM". Successive searches concatenated into strings
   * nobody chose. fill("") is the only thing that empties it.
   */
  await input.fill("").catch(() => undefined);
  await page.waitForTimeout(250);
  const afterClear = await value();

  const start = beginSearch(afterClear, c.term);
  if (!start.ok) {
    skipped.push({ skill: c.term, why: start.why, offered: 0 });
    console.log(`skip ${c.term.padEnd(22)} ${start.why}`);
    console.log(`       before=${JSON.stringify(before)} afterClear=${JSON.stringify(afterClear)}`);
    await input.fill("").catch(() => undefined);
    continue;
  }

  await page.keyboard.type(c.term, { delay: 90 });
  await page.waitForTimeout(300);
  const afterType = await value();
  const typed = confirmTyped(afterType, c.term);
  console.log(`\nsearch ${JSON.stringify(c.term)}  before=${JSON.stringify(before)} afterClear=${JSON.stringify(afterClear)} afterType=${JSON.stringify(afterType)}`);
  if (!typed.ok) {
    skipped.push({ skill: c.term, why: typed.why, offered: 0 });
    console.log(`skip ${c.term.padEnd(22)} ${typed.why}`);
    await input.fill("").catch(() => undefined);
    continue;
  }

  // The search only runs on Enter, exactly once.
  await page.keyboard.press("Enter").catch(() => undefined);

  let results: any[] = [];
  for (let i = 0; i < 15; i++) { await page.waitForTimeout(500); results = await readResults(); if (results.length) break; }

  const choice = chooseSkill(results, c.term);
  if (!choice.ok) {
    skipped.push({ skill: c.term, why: choice.why, offered: results.length });
    console.log(`skip ${c.term.padEnd(22)} ${choice.why}`);
    if (results.length) console.log(`       returned: ${results.slice(0, 8).map((r: any) => r.label).join(" | ")}`);
    await input.fill("").catch(() => undefined);
    continue;
  }

  const row = page.locator('[data-automation-id="activeListContainer"] [data-automation-id="menuItem"]')
    .filter({ hasText: new RegExp(`^\\s*${choice.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) }).first();
  await row.click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(900);

  const now = await committed();
  if (isCommitted(now, choice.label)) {
    added.push({ skill: choice.label, evidence: c.evidence });
    console.log(`ok   ${choice.label.padEnd(32)} committed (${choice.why})`);
  } else {
    skipped.push({ skill: c.term, why: "selected but never appeared in the committed list", offered: results.length });
    console.log(`FAIL ${c.term.padEnd(22)} selected but not committed`);
  }
  // Reset completely before the next term.
  await input.fill("").catch(() => undefined);
  await page.waitForTimeout(300);
}

const final = await committed();
console.log(`\ncommitted skills (${final.length}): ${final.join(" | ") || "(none)"}`);
for (const a of added) console.log(`  ${a.skill}  <- ${a.evidence}`);
if (skipped.length) console.log(`skipped ${skipped.length}: ${skipped.map((s) => s.skill).join(", ")}`);
await b.close();
process.exit(0);
