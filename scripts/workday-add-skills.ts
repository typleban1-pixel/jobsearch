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
/**
 * The skills are the overlap between this posting and the truth profile.
 *
 * Scoring already computes it: each requirement the employer stated is
 * resolved against verified evidence, and a DIRECT resolution means the
 * profile evidences that concept itself. Those, restricted to skill-class
 * requirements, are the candidates. Nothing the posting did not mention
 * is offered, nothing the profile does not evidence is claimed, and
 * Workday's own list decides which of them exist as skills.
 *
 *   node scripts/workday-add-skills.ts <application_id>
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
const ID = process.argv[2];
if (!ID) { console.error("usage: node scripts/workday-add-skills.ts <application_id>"); process.exit(2); }
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const { data: app } = await db.from("applications").select("job_id").eq("id", ID).single();
const { data: score } = await db.from("job_scores").select("fit_breakdown").eq("job_id", app!.job_id).eq("is_current", true).maybeSingle();
const detail: any[] = (score as any)?.fit_breakdown?.conceptDetail ?? [];
const seen = new Set<string>();
const CANDIDATES: { term: string; evidence: string }[] = detail
  .filter((c) => c.resolution === "DIRECT" && c.requirementClass !== "EDUCATION" && c.requirementClass !== "CREDENTIAL")
  .map((c) => ({ term: String(c.label ?? c.concept).trim(), evidence: `the posting asks for it and the profile evidences it directly: ${c.rationale ?? ""}`.trim() }))
  .filter((c) => c.term.length > 1 && !seen.has(c.term.toLowerCase()) && seen.add(c.term.toLowerCase()));
console.log(`posting requirements the profile evidences directly (skills): ${CANDIDATES.length}`);
for (const c of CANDIDATES) console.log(`  ${c.term}`);
if (!CANDIDATES.length) { console.log("nothing to add: no skill the posting asks for is directly evidenced by the profile"); process.exit(0); }

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
