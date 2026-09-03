/**
 * Reproduces the production submission failure: a react-select location
 * field that the main pass filled and verified was re-attempted by the
 * multi-pass rescan, resolved to zero controls after the rerender, and
 * stopped the whole submission one field short of the handoff -- after
 * the resume was already uploaded, before any Submit click.
 *
 * The mechanism is exercised two ways: the committed-value reader
 * against a real react-select DOM, and the rescan's re-attempt decision.
 */
import { chromium } from "playwright";
import { shouldReattempt } from "../lib/browser/actions.ts";
let n=0,bad=0; const ok=(c:boolean,w:string)=>{n++;if(!c){bad++;console.error(`FAIL ${w}`);}};

// ---- 1. the rescan never re-attempts a field the main pass filled ----
// This is the exact bug: the location was in `filled`, but its
// re-snapshot input read empty, so the old check re-queued it.
const FILLED = new Set(["Location (City)", "First Name", "Country"]);
ok(!shouldReattempt("Location (City)", FILLED, null, ""), "a filled react-select with an empty input is NOT re-attempted");
ok(!shouldReattempt("Location (City)", FILLED, "", null), "empty held and empty typed still skip when already filled");
ok(!shouldReattempt("First Name", FILLED, "Tyler", "Tyler"), "an ordinary filled field is not re-attempted");
// A genuinely empty field the main pass did NOT fill is still attempted.
ok(shouldReattempt("Cover Letter", FILLED, null, ""), "a field never filled, and empty, is still attempted");
ok(shouldReattempt("Cover Letter", FILLED, "", ""), "empty strings do not count as filled");
// A field not in the filled set but holding a committed chip is done.
ok(!shouldReattempt("State", FILLED, "Ohio", ""), "a committed value (held) counts as filled even if not in the set");
ok(!shouldReattempt("State", FILLED, "", "Ohio"), "a typed value counts as filled even if not in the set");

// ---- 1b. a duplicate label does NOT suppress a genuinely new field ---
// The main pass filled "Location (City)". If a NEW, different field
// later appears also labelled "Location (City)" (pathological, but the
// guard must hold), it must still be attempted while empty. Skip by
// label only when the label is unique in the current snapshot.
ok(!shouldReattempt("Location (City)", FILLED, null, "", true),
   "a UNIQUE filled label is skipped (the rerendered react-select)");
ok(shouldReattempt("Location (City)", FILLED, null, "", false),
   "a DUPLICATE filled label is still attempted, preserving new-field discovery");
ok(!shouldReattempt("Location (City)", FILLED, "Cleveland, OH", "", false),
   "even a duplicate label is skipped when THIS field holds a committed value");
ok(shouldReattempt("New Question", FILLED, null, "", true),
   "a brand-new label, empty, is always attempted");

// ---- 2. committedValue reads a real react-select chip ----------------
// The main pass relies on this to verify the location; the rescan skip
// is the backstop for when the re-snapshot selector cannot.
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
// A faithful react-select shape: a control wrapper, a single-value chip,
// and a search input that is EMPTY after commit (as react-select leaves it).
await page.setContent(`<body>
  <div class="select__control select__control--is-focused">
    <div class="select__value-container">
      <div class="select__single-value">Cleveland, Ohio, United States</div>
      <div class="select__input-container">
        <input id="loc" class="select__input" value="" />
      </div>
    </div>
  </div>
</body>`);
const held = await page.evaluate((sel: string) => {
  const el = document.querySelector(sel);
  const shell = el?.closest("[class*='select__control']")?.parentElement ?? el?.closest("div,fieldset");
  const single = shell?.querySelector("[class*='single-value']");
  return single ? (single.textContent ?? "").replace(/\s+/g, " ").trim() : null;
}, "#loc");
ok(held === "Cleveland, Ohio, United States", `the committed chip is read from a react-select (got ${JSON.stringify(held)})`);
const typed = await page.locator("#loc").inputValue();
ok(typed === "", "and the react-select input itself reads empty after commit, which is why the chip matters");
// Together: this exact field would have been re-attempted by the old
// check (input empty) and skipped correctly by the new one (chip held).
ok(!shouldReattempt("Location (City)", new Set(), held, typed),
   "the committed chip alone prevents a re-attempt, even before the label set");
await browser.close();

console.log(`${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
