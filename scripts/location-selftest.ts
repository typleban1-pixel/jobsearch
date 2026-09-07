/**
 * Committing a location, and refusing to commit the wrong one.
 *
 *   node scripts/location-selftest.ts          matching rules only
 *   node scripts/location-selftest.ts --live   also drive the real control
 *
 * The bug: the fill typed "Cleveland, OH, US" into Greenhouse's location
 * combobox and never selected an option, so the control held uncommitted
 * text, the field ended up blank, and the form said "Please enter your
 * location" while the resume sat attached above it.
 *
 * The trap is the option list. Searching "Cleveland" offers City of
 * Cleveland, Cleveland Ohio, Cleveland Tennessee, Cleveland Heights,
 * East Cleveland and Cleveland Mississippi. First-result selection,
 * substring matching and ignoring the region each pick a different real
 * place, and each would be a false statement about where the applicant
 * lives.
 */
import { geoParts, sameGeography, exactGeoMatches, geoSearchTerm } from "../lib/browser/geography.ts";
import { launchBrowser, newPreparedContext, newPreparedPage } from "../lib/browser/launch.ts";

const live = process.argv.includes("--live");
let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};

const REVIEWED = "Cleveland, OH, US";
// The real option list Greenhouse returns for "Cleveland".
const OFFERED = [
  "City of Cleveland, Ohio, United States",
  "Cleveland, Ohio, United States",
  "Cleveland, Tennessee, United States",
  "City of Cleveland Heights, Ohio, United States",
  "Cleveland Heights, Ohio, United States",
  "City of East Cleveland, Ohio, United States",
  "East Cleveland, Ohio, United States",
  "Clevelândia, Parana, Brazil",
  "Cleveland, Queensland, Australia",
  "Cleveland, Mississippi, United States",
];

console.log("\nthe structured value expands to the offered form");
check("OH becomes Ohio and US becomes United States",
  geoParts(REVIEWED).join(" | ") === "cleveland | ohio | united states", geoParts(REVIEWED).join(" | "));
check("and the offered display parses the same way",
  geoParts("Cleveland, Ohio, United States").join(" | ") === "cleveland | ohio | united states");

console.log("\nthe exact place matches");
check("Cleveland, OH, US == Cleveland, Ohio, United States",
  sameGeography(REVIEWED, "Cleveland, Ohio, United States"));
check("and exactly one option in the real list matches",
  exactGeoMatches(OFFERED, REVIEWED).length === 1, JSON.stringify(exactGeoMatches(OFFERED, REVIEWED)));
check("and it is the right one",
  exactGeoMatches(OFFERED, REVIEWED)[0] === "Cleveland, Ohio, United States");

console.log("\nevery neighbouring place is refused");
for (const wrong of [
  "City of Cleveland, Ohio, United States",
  "Cleveland Heights, Ohio, United States",
  "City of Cleveland Heights, Ohio, United States",
  "East Cleveland, Ohio, United States",
  "City of East Cleveland, Ohio, United States",
  "New Cleveland, Ohio, United States",
]) check(`${wrong} is not Cleveland`, !sameGeography(REVIEWED, wrong));

console.log("\nthe region and country are not decoration");
check("Cleveland, Tennessee is refused", !sameGeography(REVIEWED, "Cleveland, Tennessee, United States"));
check("Cleveland, Mississippi is refused", !sameGeography(REVIEWED, "Cleveland, Mississippi, United States"));
check("Cleveland, Queensland, Australia is refused", !sameGeography(REVIEWED, "Cleveland, Queensland, Australia"));
check("Clevelandia, Brazil is refused", !sameGeography(REVIEWED, "Clevelândia, Parana, Brazil"));

console.log("\na partial place is not a match");
check("bare Cleveland does not match the full place", !sameGeography(REVIEWED, "Cleveland"));
check("city and region without country does not match", !sameGeography(REVIEWED, "Cleveland, Ohio"));
check("an empty string never matches", !sameGeography(REVIEWED, ""));

console.log("\nno match, and ambiguous match, both block");
check("a list with no exact match yields none",
  exactGeoMatches(["Cleveland Heights, Ohio, United States", "Cleveland, Tennessee, United States"], REVIEWED).length === 0);
check("two identical options are an ambiguity, not a tie",
  exactGeoMatches(["Cleveland, Ohio, United States", "Cleveland, OH, US"], REVIEWED).length === 2);
check("an empty list yields none", exactGeoMatches([], REVIEWED).length === 0);

console.log("\nabbreviations expand only where they belong");
check("CA in the region slot is California",
  sameGeography("San Jose, CA, US", "San Jose, California, United States"));
check("and is not read as Canada", !sameGeography("San Jose, CA, US", "San Jose, Canada"));

console.log("\nwhat gets typed is a place name, not the formatted value");
check("the search term is the city", geoSearchTerm(REVIEWED) === "Cleveland", geoSearchTerm(REVIEWED));
check("and the full structured value is never the search term", geoSearchTerm(REVIEWED) !== REVIEWED);

if (!live) {
  console.log(`\n${failures === 0 ? "matching rules passed" : failures + " FAILED"}; pass --live to drive the real control`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---- against the real control ----------------------------------------
console.log("\nagainst Stripe's live location control");
const { chromium } = await import("playwright");
const browser = await launchBrowser();
const page = await newPreparedPage(browser, { viewport: { width: 1440, height: 1000 } });
await page.goto("https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=7844214",
  { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForTimeout(4000);

const optionsNow = async (): Promise<string[]> => page.evaluate(() => {
  const box = document.getElementById("react-select-candidate-location-listbox");
  if (!box || box.textContent?.includes("Loading")) return [];
  return [...box.querySelectorAll("[role=option]")].map((o) => (o.textContent ?? "").trim()).filter(Boolean);
});

const loc = page.locator("#candidate-location");
await loc.click();
await loc.fill(REVIEWED);
await page.waitForTimeout(3000);
check("the structured value returns nothing, so it cannot be the search term",
  (await optionsNow()).length === 0, JSON.stringify((await optionsNow()).slice(0, 3)));

await loc.fill(geoSearchTerm(REVIEWED));
let opts: string[] = [];
for (let i = 0; i < 20; i++) { await page.waitForTimeout(600); opts = await optionsNow(); if (opts.length) break; }
check(`searching "${geoSearchTerm(REVIEWED)}" returns options (${opts.length})`, opts.length > 0);
const hits = exactGeoMatches(opts, REVIEWED);
check("exactly one is an exact geographic match", hits.length === 1, JSON.stringify(hits));
check("and the neighbours are present but unmatched",
  opts.some((o) => /Cleveland Heights/.test(o)) && !hits.some((h) => /Heights/.test(h)));

// Commit it the way the filler will, and prove it stuck.
await page.locator(`#react-select-candidate-location-listbox [role=option]`)
  .filter({ hasText: /^Cleveland, Ohio, United States$/ }).first().click();
await page.waitForTimeout(1000);
await page.locator("#first_name").click();
await page.waitForTimeout(800);

const committed = await page.evaluate(() => {
  const el = document.querySelector("#candidate-location");
  const shell = el?.closest("[class*='select__control']")?.parentElement;
  return {
    single: shell?.querySelector("[class*='single-value']")?.textContent?.trim() ?? null,
    inputValue: (el as HTMLInputElement)?.value ?? null,
    error: document.body.textContent?.includes("Please enter your location") ?? false,
  };
});
check("the control holds the committed place", committed.single === "Cleveland, Ohio, United States", JSON.stringify(committed));
check("and the validation error is absent", committed.error === false);
check("and the raw input is empty, so typed text is not the answer", (committed.inputValue ?? "") === "");

await browser.close();
console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);


// Chicagoland membership survives how an employer writes the place.
{
  const { resolveMetro, municipalityKey } = await import("../lib/ingest/normalize/location.ts");
  check("a site-code prefix is not part of the town: 3051 Alsip", resolveMetro("3051 Alsip", "IL") === "Chicagoland");
  check("a country prefix is dropped: USA - Chicago", resolveMetro("USA - Chicago", "IL") === "Chicagoland");
  check("a neighbourhood resolves to its city: Chinatown - Chicago", resolveMetro("Chinatown - Chicago", "IL") === "Chicagoland");
  check("and the other way round: Chicago - Loop", resolveMetro("Chicago - Loop", "IL") === "Chicagoland");
  check("the observed misspelling is corrected: Chicgao", resolveMetro("Chicgao", "IL") === "Chicagoland");
  check("Bedford Park is Chicagoland", resolveMetro("Bedford Park", "IL") === "Chicagoland");
  check("Winnetka is Chicagoland", resolveMetro("Winnetka", "IL") === "Chicagoland");
  check("a Chicagoland name in another state is not: Aurora, CO", resolveMetro("Aurora", "CO") === null);
  check("an unrelated place stays unresolved", resolveMetro("Springfield", "IL") === null);
  check("the key never invents a municipality", municipalityKey("1564 - Hartford") === "hartford" && resolveMetro("1564 - Hartford", "IL") === null);
}
