/**
 * Choosing from an async type-ahead, and refusing to.
 *
 *   node scripts/combobox-selftest.ts          matching rules only
 *   node scripts/combobox-selftest.ts --live   also open the real form
 *
 * Greenhouse's school picker renders the first hundred institutions
 * alphabetically -- Aalborg, Aalto, Aarhus -- and loads anything else
 * only when searched. A fill that read that page and concluded "Western
 * Governors University" was not offered was reading the first page of a
 * dictionary and concluding a word does not exist.
 *
 * Typing to search is safe. What is not safe is what a search box
 * invites: taking the first result, or accepting something close. Every
 * case below exists to pin one of those shut.
 */
import { exactOptions } from "../lib/browser/inspectCombobox.ts";
import { launchBrowser, newPreparedContext, newPreparedPage } from "../lib/browser/launch.ts";

const live = process.argv.includes("--live");
let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};

// The real first page of Greenhouse's school list.
const ALPHABETIC_FIRST_PAGE = [
  "Aalborg University", "Aalto University", "Aarhus University",
  "Abdullah Gul University", "Abertay University", "Aberystwyth University",
];
const WGU = "Western Governors University";

console.log("\nthe answer is not on the unfiltered first page");
check("Western Governors University is absent from the alphabetic page",
  exactOptions(ALPHABETIC_FIRST_PAGE, WGU).length === 0);
check("and that absence is not evidence it does not exist",
  ALPHABETIC_FIRST_PAGE.every((o) => o < "B"), "the page is alphabetical and stops long before W");

console.log("\ntyping loads it, and an exact match selects it");
const SEARCHED = ["Western Governors University", "Western Governors University - Nevada"];
check("the searched list contains it", SEARCHED.includes(WGU));
check("exactly one option matches exactly", exactOptions(SEARCHED, WGU).length === 1);
check("and it is the exact one, not the first-looking one",
  exactOptions(SEARCHED, WGU)[0] === WGU);

console.log("\nnear matches are refused");
check("a suffixed variant alone is not a match",
  exactOptions(["Western Governors University - Nevada"], WGU).length === 0);
check("a prefix is not a match", exactOptions(["Western Governors"], WGU).length === 0);
check("a superstring is not a match",
  exactOptions(["The Western Governors University Foundation"], WGU).length === 0);
check("a different school is not a match",
  exactOptions(["Eastern Governors University"], WGU).length === 0);
check("substring matching is never used",
  exactOptions(["Governors"], WGU).length === 0);

console.log("\nwhitespace and case are not material; anything else is");
check("case folds", exactOptions(["western governors university"], WGU).length === 1);
check("surrounding space is trimmed", exactOptions(["  Western Governors University  "], WGU).length === 1);
check("internal double space collapses", exactOptions(["Western  Governors  University"], WGU).length === 1);
check("but a missing word does not", exactOptions(["Western University"], WGU).length === 0);

console.log("\nzero and ambiguous results both block");
check("zero exact matches blocks", exactOptions(["Aalborg University", "Aalto University"], WGU).length === 0);
check("two identical options are ambiguous, not a tie to break",
  exactOptions([WGU, WGU], WGU).length === 2);
check("an empty list blocks", exactOptions([], WGU).length === 0);

console.log("\nordinary finite lists are unaffected");
const DEGREES = ["Associate's Degree", "Bachelor's Degree", "Master's Degree", "Other"];
check("a finite select still matches exactly", exactOptions(DEGREES, "Bachelor's Degree").length === 1);
check("and still refuses a near match", exactOptions(DEGREES, "Bachelor of Science").length === 0);

if (!live) {
  console.log(`\n${failures === 0 ? "matching rules passed" : failures + " FAILED"}; pass --live to open the real form`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---- against the real control ----------------------------------------
console.log("\nagainst Stripe's live school picker");
const { chromium } = await import("playwright");
const browser = await launchBrowser();
const page = await newPreparedPage(browser, { viewport: { width: 1440, height: 1000 } });
await page.goto("https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=7844214",
  { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForTimeout(4000);

// Scoped to the listbox THIS control owns. Reading the first listbox on
// the page returned the phone dial-code list instead, which is the same
// class of mistake the fill layer must never make.
const readOptions = async (): Promise<string[]> => page.evaluate((sel: string) => {
  const el = document.querySelector(sel);
  const owned = el?.getAttribute("aria-controls") ?? el?.getAttribute("aria-owns");
  const box = (owned && document.getElementById(owned))
    || el?.closest("div")?.querySelector("[role='listbox'], [class*='menu' i]");
  if (!box) return [];
  return Array.from(box.querySelectorAll("[role='option'], [class*='option' i]"))
    .map((o) => (o.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
}, "#school--0");

const school = page.locator("#school--0");
await school.click();
await page.waitForTimeout(1200);
const unfiltered = await readOptions();
check(`the unfiltered list is a first page (${unfiltered.length} options)`, unfiltered.length > 0);
check("and it does NOT contain Western Governors University",
  exactOptions(unfiltered, WGU).length === 0, unfiltered.slice(0, 3).join(", "));

await school.fill(WGU);
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(400);
  if (exactOptions(await readOptions(), WGU).length) break;
}
const filtered = await readOptions();
check(`typing loads matching options (${filtered.length} returned)`, filtered.length > 0);
check("and exactly one is an exact match", exactOptions(filtered, WGU).length === 1,
  filtered.slice(0, 5).join(" | "));

await school.fill("Zzzz No Such School Zzzz");
await page.waitForTimeout(2500);
const none = await readOptions();
check("a search with no real match yields no exact match", exactOptions(none, WGU).length === 0,
  none.slice(0, 3).join(", "));

await school.fill("");
await page.keyboard.press("Escape");
const residue = await school.inputValue().catch(() => "");
check("the control is left empty after searching", residue.trim() === "", JSON.stringify(residue));

await browser.close();
console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
