/**
 * Reproduces BOTH the Samsara and Stripe production submission failures
 * at the Location field, and proves each fix.
 *
 * Samsara: the multi-pass rescan re-attempted a react-select the main
 * pass had already filled and verified, resolved its rerendered selector
 * to zero, and stopped one field short of the handoff after the resume
 * was uploaded. Stripe: the location ANSWER was prose ("Cleveland -
 * relocating to Chicago") that the typeahead could not search.
 */
import { chromium } from "playwright";
import { shouldReattempt } from "../lib/browser/actions.ts";
import { geoSearchTerm } from "../lib/browser/geography.ts";
let n=0,bad=0; const ok=(c:boolean,w:string)=>{n++;if(!c){bad++;console.error(`FAIL ${w}`);}};

// ==== SAMSARA: the rescan never re-attempts a processed field ==========
const PROCESSED = new Set(["Location (City)", "First Name", "Country", "Phone"]);

// The exact failure: the main pass processed Location (City); on the
// rescan its react-select input reads empty. It must NOT be re-attempted,
// however many same-labelled nodes the rerender produced.
ok(!shouldReattempt("Location (City)", PROCESSED, null, ""), "a processed react-select with an empty input is not re-attempted");
ok(!shouldReattempt("Location (City)", PROCESSED, "", null), "empty held and typed still skip when processed");
ok(!shouldReattempt("Phone", PROCESSED, "", ""), "a processed phone field is not re-attempted");

// A genuinely NEW dynamic field carries a label the main pass never saw.
ok(shouldReattempt("If you selected Other, explain", PROCESSED, null, ""),
   "a dynamically revealed field with a new label IS attempted");
ok(shouldReattempt("Cover Letter Text", PROCESSED, "", ""),
   "a never-seen empty field is attempted");

// A committed value always counts as filled, whatever the label.
ok(!shouldReattempt("State", PROCESSED, "Ohio", ""), "a committed chip value counts as filled");
ok(!shouldReattempt("State", PROCESSED, "", "Ohio"), "a typed value counts as filled");

// The user's namesake concern: a NEW field must not be suppressed. Under
// the processed-labels model, a new field has a NEW label, so it is never
// suppressed by a namesake -- there is no namesake to collide with.
ok(shouldReattempt("Additional Location", PROCESSED, null, ""),
   "a distinctly-labelled second location field is still attempted");

// ==== the react-select DOM the bug lives in ============================
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
await page.setContent(`<body>
  <div class="select__control"><div class="select__value-container">
    <div class="select__single-value">Cleveland, Ohio, United States</div>
    <div class="select__input-container"><input id="loc" class="select__input" value="" /></div>
  </div></div></body>`);
const held = await page.evaluate((sel: string) => {
  const el = document.querySelector(sel);
  const shell = el?.closest("[class*='select__control']")?.parentElement ?? el?.closest("div,fieldset");
  const single = shell?.querySelector("[class*='single-value']");
  return single ? (single.textContent ?? "").replace(/\s+/g, " ").trim() : null;
}, "#loc");
ok(held === "Cleveland, Ohio, United States", "the committed chip is read while the input is empty");
ok((await page.locator("#loc").inputValue()) === "", "the react-select input reads empty after commit");
await browser.close();

// ==== STRIPE: a prose location answer yields a searchable city ========
ok(geoSearchTerm("Cleveland - relocating to Chicago") === "Cleveland",
   "a prose location answer yields the leading city");
ok(geoSearchTerm("Cleveland, OH") === "Cleveland", "a clean city,state yields the city");
ok(geoSearchTerm("Cleveland, Ohio, United States") === "Cleveland", "a full place yields the city");
ok(geoSearchTerm("New York (remote)") === "New York", "a parenthetical is stripped");
ok(geoSearchTerm("Chicago — moving soon") === "Chicago", "an em-dash note is stripped");
ok(geoSearchTerm("Cleveland") === "Cleveland", "a bare city is unchanged");
// It only widens what can be SEARCHED, never invents a match: a string
// with no clean leading place is returned as-is and fails closed at the
// geo-match step exactly as before.
ok(geoSearchTerm("San Francisco Bay Area") === "San Francisco Bay Area",
   "a place with no separator is returned whole, to be judged by the matcher");

console.log(`${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
